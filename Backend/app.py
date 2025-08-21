# backend/app.py
import asyncio
import base64
import io
import os
import sqlite3
import time
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from PIL import Image, ImageDraw
from pydantic import BaseModel, validator
from playwright.async_api import async_playwright

# ============================================================================
# Configuration globale
# ============================================================================
DB_PATH = os.getenv("BLUE_SCAN_DB", "blue_scan.sqlite")
WPLACE_URL = "https://wplace.live/"
# Couleur spéciale dans le template : si un pixel du template vaut DEFACE_RGB,
# alors on exige qu'il corresponde au "sol" (ground) et pas au template.
DEFACE_RGB = (0xDE, 0xFA, 0xCE)

# ============================================================================
# Modèles Pydantic (I/O API)
# ============================================================================
class ConfigIn(BaseModel):
    guild_id: str = ""
    channel_id: str = ""
    discord_webhook: str = ""
    poll_ms: int = 2000
    scan_hz: float = 1.0
    tolerance: int = 8
    suspicion_threshold: int = 5
    degradation_threshold: int = 30
    stride: int = 1
    staged_scan: bool = True
    tile_w: int = 100
    tile_h: int = 100
    tiles_per_tick: int = 1
    tiles_global_per_tick: int = 64
    one_tile_per_artwork: bool = True
    ignore_outside: bool = True
    detourage_mode: str = "alpha_only"  # "alpha_only" | "polygon_only" | "alpha_or_polygon"

class ArtworkIn(BaseModel):
    name: str
    x: int
    y: int
    w: int
    h: int

class ArtworkOut(ArtworkIn):
    id: int
    added_at: str
    mode: str  # 'build' | 'protect'

class TemplateIn(BaseModel):
    data_url: str  # "data:image/..."

class ModeIn(BaseModel):
    mode: str  # 'build' | 'protect'

class ArtworkCornersIn(BaseModel):
    name: str
    corners: List[List[int]]

    @validator("corners")
    def _four_points(cls, v):
        if not isinstance(v, list) or len(v) != 4:
            raise ValueError("corners doit contenir 4 points")
        for p in v:
            if not (isinstance(p, list) and len(p) == 2):
                raise ValueError("chaque point = [x,y]")
        return v

class PlaceTLIn(BaseModel):
    name: str
    tl_x: int
    tl_y: int
    data_url: str  # "data:image/..."

# ============================================================================
# SQLite helpers
# ============================================================================
def db():
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA journal_mode=WAL;")
    return con

def _try_alter(con, sql: str):
    try:
        con.execute(sql)
        con.commit()
    except Exception:
        pass

def init_db():
    con = db()
    con.executescript(
        """
        CREATE TABLE IF NOT EXISTS config(
          id INTEGER PRIMARY KEY CHECK(id=1),
          guild_id TEXT, channel_id TEXT, discord_webhook TEXT,
          poll_ms INTEGER, scan_hz REAL, tolerance INTEGER,
          suspicion_threshold INTEGER, degradation_threshold INTEGER,
          stride INTEGER, staged_scan INTEGER,
          tile_w INTEGER, tile_h INTEGER, tiles_per_tick INTEGER,
          ignore_outside INTEGER,
          tiles_global_per_tick INTEGER,
          one_tile_per_artwork INTEGER,
          detourage_mode TEXT
        );
        INSERT OR IGNORE INTO config
          (id,guild_id,channel_id,discord_webhook,poll_ms,scan_hz,tolerance,
           suspicion_threshold,degradation_threshold,stride,staged_scan,
           tile_w,tile_h,tiles_per_tick,ignore_outside,
           tiles_global_per_tick,one_tile_per_artwork,detourage_mode)
          VALUES(1,'','','',2000,1.0,8,5,30,1,1,100,100,1,1,64,1,'alpha_only');

        CREATE TABLE IF NOT EXISTS artworks(
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          x INTEGER, y INTEGER, w INTEGER, h INTEGER,
          added_at TEXT NOT NULL,
          mode TEXT DEFAULT 'build'
        );

        CREATE TABLE IF NOT EXISTS baselines(
          artwork_id INTEGER PRIMARY KEY,
          w INTEGER NOT NULL, h INTEGER NOT NULL,
          rgba BLOB NOT NULL
        );
        CREATE TABLE IF NOT EXISTS grounds(
          artwork_id INTEGER PRIMARY KEY,
          w INTEGER NOT NULL, h INTEGER NOT NULL,
          rgba BLOB NOT NULL
        );
        CREATE TABLE IF NOT EXISTS templates(
          artwork_id INTEGER PRIMARY KEY,
          w INTEGER NOT NULL, h INTEGER NOT NULL,
          rgba BLOB NOT NULL
        );
        CREATE TABLE IF NOT EXISTS masks(
          artwork_id INTEGER PRIMARY KEY,
          w INTEGER NOT NULL, h INTEGER NOT NULL,
          mask BLOB NOT NULL
        );
        """
    )
    cols = [r[1] for r in con.execute("PRAGMA table_info(config)")]
    if "scan_hz" not in cols:
        con.execute("ALTER TABLE config ADD COLUMN scan_hz REAL DEFAULT 1.0")
    if "tile_w" not in cols:
        con.executescript(
            """
            ALTER TABLE config ADD COLUMN tile_w INTEGER DEFAULT 100;
            ALTER TABLE config ADD COLUMN tile_h INTEGER DEFAULT 100;
            ALTER TABLE config ADD COLUMN tiles_per_tick INTEGER DEFAULT 1;
            ALTER TABLE config ADD COLUMN ignore_outside INTEGER DEFAULT 1;
            """
        )
    if "tiles_global_per_tick" not in cols:
        con.execute("ALTER TABLE config ADD COLUMN tiles_global_per_tick INTEGER DEFAULT 64")
    if "one_tile_per_artwork" not in cols:
        con.execute("ALTER TABLE config ADD COLUMN one_tile_per_artwork INTEGER DEFAULT 1")
    if "detourage_mode" not in cols:
        con.execute("ALTER TABLE config ADD COLUMN detourage_mode TEXT DEFAULT 'alpha_only'")
    _try_alter(con, "ALTER TABLE artworks ADD COLUMN mode TEXT DEFAULT 'build'")
    con.commit()
    con.close()

init_db()

# ============================================================================
# Playwright state & helpers
# ============================================================================
@dataclass
class PwState:
    pw: Optional[Any] = None
    browser: Optional[Any] = None
    page: Optional[Any] = None

PW = PwState()

async def ensure_page():
    """Lance Playwright + Chromium headless et va sur wplace si besoin."""
    if PW.page:
        return PW.page
    PW.pw = await async_playwright().start()
    PW.browser = await PW.pw.chromium.launch(
        headless=True, args=["--disable-dev-shm-usage", "--no-sandbox"]
    )
    ctx = await PW.browser.new_context(viewport={"width": 1600, "height": 900})
    PW.page = await ctx.new_page()
    await PW.page.goto(WPLACE_URL, wait_until="domcontentloaded", timeout=60_000)
    return PW.page

GET_CANVAS_INFO = """
(() => {
  const cs = Array.from(document.querySelectorAll('canvas'));
  if (!cs.length) return {ok:false};
  let best = cs[0], area = best.width*best.height;
  for (const c of cs) { const a=c.width*c.height; if (a>area){best=c;area=a;} }
  const r = best.getBoundingClientRect();
  return {ok:true, cw:best.width, ch:best.height, bx:r.x, by:r.y, bw:r.width, bh:r.height};
})()
"""

async def get_region_rgba(page, x: int, y: int, w: int, h: int) -> Optional[np.ndarray]:
    """Lit un rectangle RGBA du canvas principal. Fallback screenshot si getImageData indispo."""
    info = await page.evaluate(GET_CANVAS_INFO)
    if not info.get("ok"):
        return None
    # A) getImageData direct (rapide)
    try:
        b64 = await page.evaluate(
            f"""
          (() => {{
            const cs = Array.from(document.querySelectorAll('canvas'));
            let best = cs[0], area = best.width*best.height;
            for (const c of cs) {{ const a=c.width*c.height; if (a>area) {{best=c;area=a;}} }}
            const ctx = best.getContext('2d', {{willReadFrequently:true}});
            const img = ctx.getImageData({x},{y},{w},{h});
            return btoa(String.fromCharCode.apply(null, img.data));
          }})()
        """
        )
        raw = base64.b64decode(b64)
        return np.frombuffer(raw, dtype=np.uint8).reshape((h, w, 4))
    except Exception:
        pass
    # B) Screenshot + resize exact
    cw, ch, bw, bh, bx, by = info["cw"], info["ch"], info["bw"], info["bh"], info["bx"], info["by"]
    sx, sy = bw / cw, bh / ch
    clip = {"x": bx + x * sx, "y": by + y * sy, "width": max(1, w * sx), "height": max(1, h * sy)}
    buf = await page.screenshot(clip=clip)
    im = Image.open(io.BytesIO(buf)).convert("RGBA").resize((w, h), Image.NEAREST)
    return np.array(im, dtype=np.uint8)

async def get_full_canvas(page) -> Optional[np.ndarray]:
    """Dump le canvas entier en RGBA (H, W, 4)."""
    info = await page.evaluate(GET_CANVAS_INFO)
    if not info.get("ok"):
        return None
    cw, ch = info["cw"], info["ch"]
    # A) getImageData full
    try:
        b64 = await page.evaluate(
            f"""
          (() => {{
            const cs = Array.from(document.querySelectorAll('canvas'));
            let best = cs[0], area = best.width*best.height;
            for (const c of cs) {{ const a=c.width*c.height; if (a>area) {{best=c;area=a;}} }}
            const ctx = best.getContext('2d', {{willReadFrequently:true}});
            const img = ctx.getImageData(0,0,{cw},{ch});
            return btoa(String.fromCharCode.apply(null, img.data));
          }})()
        """
        )
        raw = base64.b64decode(b64)
        return np.frombuffer(raw, dtype=np.uint8).reshape((ch, cw, 4))
    except Exception:
        pass
    # B) Screenshot + resize
    bw, bh, bx, by = info["bw"], info["bh"], info["bx"], info["by"]
    buf = await page.screenshot(clip={"x": bx, "y": by, "width": bw, "height": bh})
    im = Image.open(io.BytesIO(buf)).convert("RGBA").resize((cw, ch), Image.NEAREST)
    return np.array(im, dtype=np.uint8)

# ============================================================================
# Diff helpers
# ============================================================================
def within_tol(a: np.ndarray, b: np.ndarray, tol: int) -> np.ndarray:
    d = np.abs(a.astype(np.int16) - b.astype(np.int16))
    return (d[..., 0] <= tol) & (d[..., 1] <= tol) & (d[..., 2] <= tol) & (d[..., 3] <= tol)

def count_diff_mask(ok_mask: np.ndarray) -> int:
    return int((~ok_mask).sum())

def count_diff_pixels(a: np.ndarray, b: np.ndarray, tol: int, stride: int = 1) -> int:
    if stride < 1:
        stride = 1
    aa = a[::stride, ::stride, :]
    bb = b[::stride, ::stride, :]
    same = within_tol(aa, bb, tol)
    diff_sample = int((~same).sum())
    if stride == 1:
        return diff_sample
    scale = (a.shape[0] * a.shape[1]) / (aa.shape[0] * aa.shape[1])
    return int(diff_sample * scale)

# ============================================================================
# Simulations "Discord" → logs console
# ============================================================================
LAST_EVENT: Dict[Tuple[int, Tuple[int, int, int, int]], Tuple[str, float]] = {}

def sim_embed_send(title: str, description: str, color_hex: str):
    print(f'console.log("envoie embed: {title} | {description} | color={color_hex}")')

def sim_embed_update(title: str, description: str, color_hex: str):
    print(f'console.log("modif embed: {title} | {description} | color={color_hex}")')

# ============================================================================
# Tuilage
# ============================================================================
@dataclass
class TileRect:
    x: int
    y: int
    w: int
    h: int

@dataclass
class TilerState:
    tiles: List[TileRect]
    idx: int = 0

TILERS: Dict[int, TilerState] = {}
TPL_FP: Dict[int, tuple] = {}

def build_tiles(w: int, h: int, tw: int, th: int) -> List[TileRect]:
    out: List[TileRect] = []
    for yy in range(0, h, th):
        hh = min(th, h - yy)
        for xx in range(0, w, tw):
            ww = min(tw, w - xx)
            out.append(TileRect(xx, yy, ww, hh))
    return out

def next_tile(art_id: int) -> Optional[TileRect]:
    st = TILERS.get(art_id)
    if not st or not st.tiles:
        return None
    t = st.tiles[st.idx]
    st.idx = (st.idx + 1) % len(st.tiles)
    return t

# ============================================================================
# Worker principal
# ============================================================================
_running = False

async def monitor_loop():
    """Boucle de scan tuilé, équitable multi-œuvres, priorisation 'hot'."""
    global _running
    page = await ensure_page()
    print("Surveillance ...")

    rr_ids: List[int] = []
    rr_pos = 0
    hot: set[int] = set()

    while _running:
        try:
            con = db()
            cfg = con.execute("SELECT * FROM config WHERE id=1").fetchone()
            tol = int(cfg["tolerance"])
            susp_t = int(cfg["suspicion_threshold"])
            degr_t = int(cfg["degradation_threshold"])
            stride = max(1, int(cfg["stride"] or 1))
            staged = bool(cfg["staged_scan"])
            tile_w = max(10, min(1000, int(cfg["tile_w"] or 100)))
            tile_h = max(10, min(1000, int(cfg["tile_h"] or 100)))
            tiles_global = max(1, int(cfg["tiles_global_per_tick"] or 64))
            one_per_art = bool(cfg["one_tile_per_artwork"])
            ignore_outside = bool(cfg["ignore_outside"])
            detourage_mode = (cfg["detourage_mode"] or "alpha_only").strip()
            scan_hz = float(cfg["scan_hz"] or 1.0)
            period = max(0.2, 1.0 / scan_hz)

            arts = con.execute("SELECT * FROM artworks ORDER BY id ASC").fetchall()
            ids = [a["id"] for a in arts]
            if rr_ids != ids:
                rr_ids, rr_pos = ids, 0

            # (Re)build tuiles si template a changé
            for a in arts:
                aid = a["id"]
                trow = con.execute("SELECT w,h,rgba FROM templates WHERE artwork_id=?", (aid,)).fetchone()
                fp = (trow["w"], trow["h"], len(trow["rgba"])) if trow else (0, 0, 0)
                rebuild = (aid not in TILERS) or (TPL_FP.get(aid) != fp)
                if rebuild:
                    tiles = build_tiles(a["w"], a["h"], tile_w, tile_h)
                    if ignore_outside:
                        tpl_alpha = None
                        poly_mask = None
                        if trow:
                            tpl = np.frombuffer(trow["rgba"], dtype=np.uint8).reshape((trow["h"], trow["w"], 4))
                            tpl_alpha = (tpl[..., 3] > 0)
                        mrow = con.execute("SELECT w,h,mask FROM masks WHERE artwork_id=?", (aid,)).fetchone()
                        if mrow:
                            poly_mask = (
                                np.frombuffer(mrow["mask"], dtype=np.uint8)
                                .reshape((mrow["h"], mrow["w"])) > 0
                            )
                        keep = []
                        for tr in tiles:
                            sub = None
                            if detourage_mode == "alpha_only" and tpl_alpha is not None:
                                sub = tpl_alpha[tr.y : tr.y + tr.h, tr.x : tr.x + tr.w]
                            elif detourage_mode == "polygon_only" and poly_mask is not None:
                                sub = poly_mask[tr.y : tr.y + tr.h, tr.x : tr.x + tr.w]
                            else:  # alpha_or_polygon
                                if tpl_alpha is not None and poly_mask is not None:
                                    sub = tpl_alpha[tr.y:tr.y+tr.h, tr.x:tr.x+tr.w] | poly_mask[tr.y:tr.y+tr.h, tr.x:tr.x+tr.w]
                                elif tpl_alpha is not None:
                                    sub = tpl_alpha[tr.y:tr.y+tr.h, tr.x:tr.x+tr.w]
                                elif poly_mask is not None:
                                    sub = poly_mask[tr.y:tr.y+tr.h, tr.x:tr.x+tr.w]
                            if (sub is None) or np.any(sub):
                                keep.append(tr)
                        tiles = keep
                    TILERS[aid] = TilerState(tiles, 0)
                    TPL_FP[aid] = fp

            # Frame unique partagée pour la passe
            frame = await get_full_canvas(page)
            if frame is None:
                await asyncio.sleep(period)
                continue

            # Planification équitable
            budget = tiles_global
            order = rr_ids[:]
            if hot:
                hot_order = [i for i in order if i in hot]
                cold_order = [i for i in order if i not in hot]
                order = hot_order + cold_order

            idx = rr_pos
            if one_per_art:
                for _ in range(len(order)):
                    if budget <= 0:
                        break
                    aid = order[idx]
                    idx = (idx + 1) % len(order)
                    a = next((x for x in arts if x["id"] == aid), None)
                    if not a:
                        continue
                    tile = next_tile(aid)
                    if not tile:
                        continue

                    y0 = a["y"] + tile.y
                    y1 = y0 + tile.h
                    x0 = a["x"] + tile.x
                    x1 = x0 + tile.w
                    cur = frame[y0:y1, x0:x1, :]

                    trow = con.execute("SELECT w,h,rgba FROM templates WHERE artwork_id=?", (aid,)).fetchone()
                    grow = con.execute("SELECT w,h,rgba FROM grounds   WHERE artwork_id=?", (aid,)).fetchone()
                    mrow = con.execute("SELECT w,h,mask FROM masks WHERE artwork_id=?", (aid,)).fetchone()
                    mode = a["mode"] or "build"

                    if trow and grow:
                        tpl = np.frombuffer(trow["rgba"], dtype=np.uint8).reshape((trow["h"], trow["w"], 4))
                        grd = np.frombuffer(grow["rgba"], dtype=np.uint8).reshape((grow["h"], grow["w"], 4))
                        tpl_t = tpl[tile.y : tile.y + tile.h, tile.x : tile.x + tile.w, :]
                        grd_t = grd[tile.y : tile.y + tile.h, tile.x : tile.x + tile.w, :]

                        alpha_mask = tpl_t[..., 3] > 0
                        deface_mask = (
                            (tpl_t[..., 0] == DEFACE_RGB[0])
                            & (tpl_t[..., 1] == DEFACE_RGB[1])
                            & (tpl_t[..., 2] == DEFACE_RGB[2])
                        )

                        poly_mask_t = None
                        if mrow:
                            msk = np.frombuffer(mrow["mask"], dtype=np.uint8).reshape((mrow["h"], mrow["w"]))
                            poly_mask_t = msk[tile.y : tile.y + tile.h, tile.x : tile.x + tile.w] > 0

                        if detourage_mode == "alpha_only":
                            inside = alpha_mask
                        elif detourage_mode == "polygon_only":
                            inside = poly_mask_t if poly_mask_t is not None else alpha_mask
                        else:
                            inside = alpha_mask | (poly_mask_t if poly_mask_t is not None else False)

                        tpl_ok = within_tol(cur, tpl_t, tol)
                        grd_ok = within_tol(cur, grd_t, tol)
                        ok_inside_nondef = (tpl_ok | grd_ok) if mode == "build" else tpl_ok
                        ok_inside = np.where(deface_mask, grd_ok, ok_inside_nondef)
                        ok_outside = True if ignore_outside else grd_ok
                        ok = np.where(inside, ok_inside, ok_outside)
                        diffs = count_diff_mask(ok)
                    else:
                        # Fallback baseline uniquement
                        brow = con.execute("SELECT w,h,rgba FROM baselines WHERE artwork_id=?", (aid,)).fetchone()
                        if not brow:
                            budget -= 1
                            continue
                        base = np.frombuffer(brow["rgba"], dtype=np.uint8).reshape((brow["h"], brow["w"], 4))
                        base_t = base[tile.y : tile.y + tile.h, tile.x : tile.x + tile.w, :]
                        diffs = count_diff_pixels(base_t, cur, tol, stride=stride)
                        if staged and diffs >= max(3, susp_t // 2) and stride > 1:
                            diffs = count_diff_pixels(base_t, cur, tol, stride=1)

                    tile_key = (aid, (tile.x, tile.y, tile.w, tile.h))
                    prev = LAST_EVENT.get(tile_key, ("none", 0.0))[0]

                    if diffs >= degr_t:
                        print("Dégradation en cours !")
                        title = "Dégradation en cours !"
                        desc = (
                            f"Œuvre: {a['name']} | tuile=({tile.x},{tile.y},{tile.w},{tile.h}) | "
                            f"diffs={diffs} (≥{degr_t}) | zone=({a['x']},{a['y']},{a['w']},{a['h']})"
                        )
                        if prev == "suspicion":
                            sim_embed_update(title, desc, "#E74C3C")
                        else:
                            sim_embed_send(title, desc, "#E74C3C")
                        LAST_EVENT[tile_key] = ("degradation", time.time())
                        hot.add(aid)
                    elif diffs >= susp_t:
                        print("Suspicion dégradation")
                        title = "Suspicion de dégradation"
                        desc = (
                            f"Œuvre: {a['name']} | tuile=({tile.x},{tile.y},{tile.w},{tile.h}) | "
                            f"diffs={diffs} (≥{susp_t}) | zone=({a['x']},{a['y']},{a['w']},{a['h']})"
                        )
                        if prev in ("suspicion", "degradation"):
                            sim_embed_update(title, desc, "#F1C40F")
                        else:
                            sim_embed_send(title, desc, "#F1C40F")
                        LAST_EVENT[tile_key] = ("suspicion", time.time())
                        hot.add(aid)

                    budget -= 1
                    if budget <= 0:
                        break

            rr_pos = idx

            # Passe 2 : consomme le reste du budget en round-robin
            idx2 = rr_pos
            while budget > 0 and rr_ids:
                aid = rr_ids[idx2]
                idx2 = (idx2 + 1) % len(rr_ids)
                a = next((x for x in arts if x["id"] == aid), None)
                if not a:
                    continue
                tile = next_tile(aid)
                if not tile:
                    continue

                y0 = a["y"] + tile.y
                y1 = y0 + tile.h
                x0 = a["x"] + tile.x
                x1 = x0 + tile.w
                cur = frame[y0:y1, x0:x1, :]

                trow = con.execute("SELECT w,h,rgba FROM templates WHERE artwork_id=?", (aid,)).fetchone()
                grow = con.execute("SELECT w,h,rgba FROM grounds   WHERE artwork_id=?", (aid,)).fetchone()
                mrow = con.execute("SELECT w,h,mask FROM masks WHERE artwork_id=?", (aid,)).fetchone()
                mode = a["mode"] or "build"

                if trow and grow:
                    tpl = np.frombuffer(trow["rgba"], dtype=np.uint8).reshape((trow["h"], trow["w"], 4))
                    grd = np.frombuffer(grow["rgba"], dtype=np.uint8).reshape((grow["h"], grow["w"], 4))
                    tpl_t = tpl[tile.y : tile.y + tile.h, tile.x : tile.x + tile.w, :]
                    grd_t = grd[tile.y : tile.y + tile.h, tile.x : tile.x + tile.w, :]

                    alpha_mask = tpl_t[..., 3] > 0
                    deface_mask = (
                        (tpl_t[..., 0] == DEFACE_RGB[0])
                        & (tpl_t[..., 1] == DEFACE_RGB[1])
                        & (tpl_t[..., 2] == DEFACE_RGB[2])
                    )

                    poly_mask_t = None
                    if mrow:
                        msk = np.frombuffer(mrow["mask"], dtype=np.uint8).reshape((mrow["h"], mrow["w"]))
                        poly_mask_t = msk[tile.y : tile.y + tile.h, tile.x : tile.x + tile.w] > 0

                    if detourage_mode == "alpha_only":
                        inside = alpha_mask
                    elif detourage_mode == "polygon_only":
                        inside = poly_mask_t if poly_mask_t is not None else alpha_mask
                    else:
                        inside = alpha_mask | (poly_mask_t if poly_mask_t is not None else False)

                    tpl_ok = within_tol(cur, tpl_t, tol)
                    grd_ok = within_tol(cur, grd_t, tol)
                    ok_inside_nondef = (tpl_ok | grd_ok) if mode == "build" else tpl_ok
                    ok_inside = np.where(deface_mask, grd_ok, ok_inside_nondef)
                    ok_outside = True if ignore_outside else grd_ok
                    ok = np.where(inside, ok_inside, ok_outside)
                    diffs = count_diff_mask(ok)
                else:
                    brow = con.execute("SELECT w,h,rgba FROM baselines WHERE artwork_id=?", (aid,)).fetchone()
                    if not brow:
                        budget -= 1
                        continue
                    base = np.frombuffer(brow["rgba"], dtype=np.uint8).reshape((brow["h"], brow["w"], 4))
                    base_t = base[tile.y : tile.y + tile.h, tile.x : tile.x + tile.w, :]
                    diffs = count_diff_pixels(base_t, cur, tol, stride=stride)
                    if staged and diffs >= max(3, susp_t // 2) and stride > 1:
                        diffs = count_diff_pixels(base_t, cur, tol, stride=1)

                tile_key = (aid, (tile.x, tile.y, tile.w, tile.h))
                prev = LAST_EVENT.get(tile_key, ("none", 0.0))[0]

                if diffs >= degr_t:
                    print("Dégradation en cours !")
                    title = "Dégradation en cours !"
                    desc = (
                        f"Œuvre: {a['name']} | tuile=({tile.x},{tile.y},{tile.w},{tile.h}) | "
                        f"diffs={diffs} (≥{degr_t}) | zone=({a['x']},{a['y']},{a['w']},{a['h']})"
                    )
                    if prev == "suspicion":
                        sim_embed_update(title, desc, "#E74C3C")
                    else:
                        sim_embed_send(title, desc, "#E74C3C")
                    LAST_EVENT[tile_key] = ("degradation", time.time())
                    hot.add(aid)
                elif diffs >= susp_t:
                    print("Suspicion dégradation")
                    title = "Suspicion de dégradation"
                    desc = (
                        f"Œuvre: {a['name']} | tuile=({tile.x},{tile.y},{tile.w},{tile.h}) | "
                        f"diffs={diffs} (≥{susp_t}) | zone=({a['x']},{a['y']},{a['w']},{a['h']})"
                    )
                    if prev in ("suspicion", "degradation"):
                        sim_embed_update(title, desc, "#F1C40F")
                    else:
                        sim_embed_send(title, desc, "#F1C40F")
                    LAST_EVENT[tile_key] = ("suspicion", time.time())
                    hot.add(aid)

                budget -= 1

            await asyncio.sleep(period)

        except Exception as e:
            print("[Worker] erreur:", e)
            await asyncio.sleep(0.5)

# ============================================================================
# FastAPI app & routes
# ============================================================================
app = FastAPI(title="Blue Scan (strict BM)")

# CORS large pour l’UI userscript
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/healthz")
def healthz():
    return {"ok": True, "status": "alive"}

@app.post("/config")
def set_config(c: ConfigIn):
    con = db()
    con.execute(
        """
      UPDATE config SET guild_id=?, channel_id=?, discord_webhook=?,
        poll_ms=?, scan_hz=?, tolerance=?,
        suspicion_threshold=?, degradation_threshold=?,
        stride=?, staged_scan=?,
        tile_w=?, tile_h=?, tiles_per_tick=?, ignore_outside=?,
        tiles_global_per_tick=?, one_tile_per_artwork=?, detourage_mode=?
      WHERE id=1
    """,
        (
            c.guild_id,
            c.channel_id,
            c.discord_webhook,
            c.poll_ms,
            max(0.2, c.scan_hz),
            c.tolerance,
            c.suspicion_threshold,
            c.degradation_threshold,
            max(1, c.stride),
            1 if c.staged_scan else 0,
            max(10, min(1000, c.tile_w)),
            max(10, min(1000, c.tile_h)),
            max(1, c.tiles_per_tick),
            1 if c.ignore_outside else 0,
            max(1, c.tiles_global_per_tick),
            1 if c.one_tile_per_artwork else 0,
            (c.detourage_mode or "alpha_only"),
        ),
    )
    con.commit()
    return {"ok": True}

@app.get("/config", response_model=ConfigIn)
def get_config():
    con = db()
    r = con.execute("SELECT * FROM config WHERE id=1").fetchone()
    return ConfigIn(
        guild_id=r["guild_id"] or "",
        channel_id=r["channel_id"] or "",
        discord_webhook=r["discord_webhook"] or "",
        poll_ms=int(r["poll_ms"]),
        scan_hz=float(r["scan_hz"] or 1.0),
        tolerance=int(r["tolerance"]),
        suspicion_threshold=int(r["suspicion_threshold"]),
        degradation_threshold=int(r["degradation_threshold"]),
        stride=int(r["stride"] or 1),
        staged_scan=bool(r["staged_scan"]),
        tile_w=int(r["tile_w"] or 100),
        tile_h=int(r["tile_h"] or 100),
        tiles_per_tick=int(r["tiles_per_tick"] or 1),
        ignore_outside=bool(r["ignore_outside"]),
        tiles_global_per_tick=int(r["tiles_global_per_tick"] or 64),
        one_tile_per_artwork=bool(r["one_tile_per_artwork"]),
        detourage_mode=r["detourage_mode"] or "alpha_only",
    )

@app.post("/artworks", response_model=ArtworkOut)
def add_artwork(a: ArtworkIn):
    if a.w <= 0 or a.h <= 0:
        raise HTTPException(400, "w/h > 0")
    con = db()
    added = time.strftime("%Y-%m-%d %H:%M:%S")
    cur = con.execute(
        "INSERT INTO artworks(name,x,y,w,h,added_at) VALUES(?,?,?,?,?,?)",
        (a.name, a.x, a.y, a.w, a.h, added),
    )
    con.commit()
    r = con.execute("SELECT * FROM artworks WHERE id=?", (cur.lastrowid,)).fetchone()
    return ArtworkOut(
        id=r["id"],
        name=r["name"],
        x=r["x"],
        y=r["y"],
        w=r["w"],
        h=r["h"],
        added_at=r["added_at"],
        mode=r["mode"],
    )

@app.post("/artworks/corners", response_model=ArtworkOut)
def add_artwork_corners(a: ArtworkCornersIn):
    xs = [int(p[0]) for p in a.corners]
    ys = [int(p[1]) for p in a.corners]
    x0, y0 = min(xs), min(ys)
    x1, y1 = max(xs), max(ys)
    w = x1 - x0 + 1
    h = y1 - y0 + 1
    if w <= 0 or h <= 0:
        raise HTTPException(400, "corners invalides")
    con = db()
    added = time.strftime("%Y-%m-%d %H:%M:%S")
    cur = con.execute(
        "INSERT INTO artworks(name,x,y,w,h,added_at) VALUES(?,?,?,?,?,?)",
        (a.name, x0, y0, w, h, added),
    )
    art_id = cur.lastrowid
    # Mask polygon relatif
    poly_rel = [(p[0] - x0, p[1] - y0) for p in a.corners]
    mask_img = Image.new("L", (w, h), 0)
    ImageDraw.Draw(mask_img).polygon(poly_rel, fill=255)
    arr = np.array(mask_img, dtype=np.uint8)
    con.execute(
        "REPLACE INTO masks(artwork_id,w,h,mask) VALUES(?,?,?,?)",
        (art_id, w, h, sqlite3.Binary(arr.tobytes())),
    )
    con.commit()
    r = con.execute("SELECT * FROM artworks WHERE id=?", (art_id,)).fetchone()
    return ArtworkOut(
        id=r["id"],
        name=r["name"],
        x=r["x"],
        y=r["y"],
        w=r["w"],
        h=r["h"],
        added_at=r["added_at"],
        mode=r["mode"],
    )

@app.get("/artworks", response_model=List[ArtworkOut])
def list_artworks():
    con = db()
    rows = con.execute("SELECT * FROM artworks ORDER BY id DESC").fetchall()
    return [
        ArtworkOut(
            id=r["id"],
            name=r["name"],
            x=r["x"],
            y=r["y"],
            w=r["w"],
            h=r["h"],
            added_at=r["added_at"],
            mode=r["mode"],
        )
        for r in rows
    ]

@app.delete("/artworks/{art_id}")
def del_artwork(art_id: int):
    con = db()
    con.execute("DELETE FROM templates WHERE artwork_id=?", (art_id,))
    con.execute("DELETE FROM grounds   WHERE artwork_id=?", (art_id,))
    con.execute("DELETE FROM baselines WHERE artwork_id=?", (art_id,))
    con.execute("DELETE FROM masks     WHERE artwork_id=?", (art_id,))
    con.execute("DELETE FROM artworks  WHERE id=?", (art_id,))
    con.commit()
    return {"ok": True}

# -- STRICT BM: aucun resize ; on garde la taille native du PNG
@app.post("/artworks/{art_id}/template")
def set_template(art_id: int, t: TemplateIn):
    con = db()
    a = con.execute("SELECT * FROM artworks WHERE id=?", (art_id,)).fetchone()
    if not a:
        raise HTTPException(404, "œuvre inconnue")
    if not t.data_url.startswith("data:image/"):
        raise HTTPException(400, "data_url invalide")

    header, b64 = t.data_url.split(",", 1)
    raw = base64.b64decode(b64)
    im = Image.open(io.BytesIO(raw)).convert("RGBA")
    W, H = im.size

    if (W, H) != (a["w"], a["h"]):
        con.execute("UPDATE artworks SET w=?, h=? WHERE id=?", (W, H, art_id))

    arr = np.array(im, dtype=np.uint8)
    con.execute(
        "REPLACE INTO templates(artwork_id,w,h,rgba) VALUES(?,?,?,?)",
        (art_id, W, H, sqlite3.Binary(arr.tobytes())),
    )
    con.commit()
    return {"ok": True, "w": W, "h": H}

# -- Création stricte BM via TL + Template
@app.post("/artworks/place_tl", response_model=ArtworkOut)
def place_tl(p: PlaceTLIn):
    if not p.data_url.startswith("data:image/"):
        raise HTTPException(400, "data_url invalide")
    header, b64 = p.data_url.split(",", 1)
    raw = base64.b64decode(b64)
    im = Image.open(io.BytesIO(raw)).convert("RGBA")
    W, H = im.size
    arr = np.array(im, dtype=np.uint8)

    con = db()
    added = time.strftime("%Y-%m-%d %H:%M:%S")
    cur = con.execute(
        "INSERT INTO artworks(name,x,y,w,h,added_at) VALUES(?,?,?,?,?,?)",
        (p.name, p.tl_x, p.tl_y, W, H, added),
    )
    art_id = cur.lastrowid
    con.execute(
        "REPLACE INTO templates(artwork_id,w,h,rgba) VALUES(?,?,?,?)",
        (art_id, W, H, sqlite3.Binary(arr.tobytes())),
    )
    con.commit()

    r = con.execute("SELECT * FROM artworks WHERE id=?", (art_id,)).fetchone()
    return ArtworkOut(
        id=r["id"],
        name=r["name"],
        x=r["x"],
        y=r["y"],
        w=r["w"],
        h=r["h"],
        added_at=r["added_at"],
        mode=r["mode"],
    )

@app.post("/artworks/{art_id}/snapshot")
async def snapshot_baseline(art_id: int):
    con = db()
    a = con.execute("SELECT * FROM artworks WHERE id=?", (art_id,)).fetchone()
    if not a:
        raise HTTPException(404, "œuvre inconnue")
    page = await ensure_page()
    arr = await get_region_rgba(page, a["x"], a["y"], a["w"], a["h"])
    if arr is None:
        raise HTTPException(500, "canvas introuvable")
    con.execute(
        "REPLACE INTO baselines(artwork_id,w,h,rgba) VALUES(?,?,?,?)",
        (a["id"], a["w"], a["h"], sqlite3.Binary(arr.tobytes())),
    )
    con.commit()
    return {"ok": True}

@app.post("/artworks/{art_id}/ground_snapshot")
async def snapshot_ground(art_id: int):
    con = db()
    a = con.execute("SELECT * FROM artworks WHERE id=?", (art_id,)).fetchone()
    if not a:
        raise HTTPException(404, "œuvre inconnue")
    page = await ensure_page()
    arr = await get_region_rgba(page, a["x"], a["y"], a["w"], a["h"])
    if arr is None:
        raise HTTPException(500, "canvas introuvable")
    con.execute(
        "REPLACE INTO grounds(artwork_id,w,h,rgba) VALUES(?,?,?,?)",
        (a["id"], a["w"], a["h"], sqlite3.Binary(arr.tobytes())),
    )
    con.commit()
    return {"ok": True}

@app.post("/artworks/{art_id}/mode")
def set_mode(art_id: int, m: ModeIn):
    if m.mode not in ("build", "protect"):
        raise HTTPException(400, "mode invalide")
    con = db()
    con.execute("UPDATE artworks SET mode=? WHERE id=?", (m.mode, art_id))
    con.commit()
    return {"ok": True, "mode": m.mode}

@app.post("/monitor/start")
async def monitor_start():
    global _running
    if _running:
        return {"ok": True, "status": "already-running"}
    _running = True
    # Important: ne pas bloquer la requête HTTP
    asyncio.get_event_loop().create_task(monitor_loop())
    return {"ok": True, "status": "started"}

@app.post("/monitor/stop")
async def monitor_stop():
    global _running
    _running = False
    return {"ok": True, "status": "stopped"}