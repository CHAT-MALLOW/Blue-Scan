# backend/app.py
import asyncio, time, base64, io, os, sqlite3
from typing import List, Optional, Dict, Tuple
from dataclasses import dataclass

import numpy as np
from PIL import Image, ImageDraw
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, validator
from playwright.async_api import async_playwright

# ---------- Config globales ----------
DB_PATH = os.getenv("BLUE_SCAN_DB", "blue_scan.sqlite")
WPLACE_URL = "https://wplace.live/"
DEFACE_RGB = (0xDE, 0xFA, 0xCE)  # couleur spéciale "doit rester sol"

# ---------- Modèles ----------
class ConfigIn(BaseModel):
    guild_id: str = ""              # placeholders (compat)
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
    x: int; y: int; w: int; h: int

class ArtworkOut(ArtworkIn):
    id: int
    added_at: str
    mode: str  # 'build' | 'protect'

class TemplateIn(BaseModel):
    data_url: str  # data:image/...

class ModeIn(BaseModel):
    mode: str  # 'build' | 'protect'

class ArtworkCornersIn(BaseModel):
    name: str
    corners: List[List[int]]
    @validator("corners")
    def _four_points(cls, v):
        if not isinstance(v, list) or len(v) != 4: raise ValueError("corners doit contenir 4 points")
        for p in v:
            if not (isinstance(p, list) and len(p)==2): raise ValueError("chaque point = [x,y]")
        return v

class PlaceTLIn(BaseModel):
    name: str
    tl_x: int
    tl_y: int
    data_url: str  # data:image/...

# ---------- DB ----------
def db():
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA journal_mode=WAL;")
    return con

def _try_alter(con, sql):
    try: con.execute(sql); con.commit()
    except Exception: pass

def init_db():
    con = db()
    con.executescript("""
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
    """)
    cols = [r[1] for r in con.execute("PRAGMA table_info(config)")]
    if "scan_hz" not in cols:
        con.execute("ALTER TABLE config ADD COLUMN scan_hz REAL DEFAULT 1.0")
    if "tile_w" not in cols:
        con.executescript("""
          ALTER TABLE config ADD COLUMN tile_w INTEGER DEFAULT 100;
          ALTER TABLE config ADD COLUMN tile_h INTEGER DEFAULT 100;
          ALTER TABLE config ADD COLUMN tiles_per_tick INTEGER DEFAULT 1;
          ALTER TABLE config ADD COLUMN ignore_outside INTEGER DEFAULT 1;
        """)
    if "tiles_global_per_tick" not in cols:
        con.execute("ALTER TABLE config ADD COLUMN tiles_global_per_tick INTEGER DEFAULT 64")
    if "one_tile_per_artwork" not in cols:
        con.execute("ALTER TABLE config ADD COLUMN one_tile_per_artwork INTEGER DEFAULT 1")
    if "detourage_mode" not in cols:
        con.execute("ALTER TABLE config ADD COLUMN detourage_mode TEXT DEFAULT 'alpha_only'")
    _try_alter(con, "ALTER TABLE artworks ADD COLUMN mode TEXT DEFAULT 'build'")
    con.commit(); con.close()

init_db()

# ---------- Playwright ----------
@dataclass
class PwState:
    pw: any = None
    browser: any = None
    page: any = None

PW = PwState()

async def ensure_page():
    if PW.page: return PW.page
    PW.pw = await async_playwright().start()
    PW.browser = await PW.pw.chromium.launch(headless=True, args=["--disable-dev-shm-usage","--no-sandbox"])
    ctx = await PW.browser.new_context(viewport={"width":1600,"height":900})
    PW.page = await ctx.new_page()
    await PW.page.goto(WPLACE_URL, wait_until="domcontentloaded", timeout=60000)
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

async def get_region_rgba(page, x, y, w, h) -> Optional[np.ndarray]:
    info = await page.evaluate(GET_CANVAS_INFO)
    if not info.get("ok"): return None
    # A) getImageData direct
    try:
        b64 = await page.evaluate(f"""
          (() => {{
            const cs = Array.from(document.querySelectorAll('canvas'));
            let best = cs[0], area = best.width*best.height;
            for (const c of cs) {{ const a=c.width*c.height; if (a>area) {{best=c;area=a;}} }}
            const ctx = best.getContext('2d', {{willReadFrequently:true}});
            const img = ctx.getImageData({x},{y},{w},{h});
            return btoa(String.fromCharCode.apply(null, img.data));
          }})()
        """)
        raw = base64.b64decode(b64)
        return np.frombuffer(raw, dtype=np.uint8).reshape((h, w, 4))
    except Exception:
        pass
    # B) Screenshot + resize exact
    cw,ch,bw,bh,bx,by = info["cw"],info["ch"],info["bw"],info["bh"],info["bx"],info["by"]
    sx,sy = bw/cw, bh/ch
    clip = {"x": bx + x*sx, "y": by + y*sy, "width": max(1,w*sx), "height": max(1,h*sy)}
    buf = await page.screenshot(clip=clip)
    im = Image.open(io.BytesIO(buf)).convert("RGBA").resize((w,h), Image.NEAREST)
    return np.array(im, dtype=np.uint8)

async def get_full_canvas(page) -> Optional[np.ndarray]:
    info = await page.evaluate(GET_CANVAS_INFO)
    if not info.get("ok"): return None
    cw, ch = info["cw"], info["ch"]
    # A) getImageData full
    try:
        b64 = await page.evaluate(f"""
          (() => {{
            const cs = Array.from(document.querySelectorAll('canvas'));
            let best = cs[0], area = best.width*best.height;
            for (const c of cs) {{ const a=c.width*c.height; if (a>area) {{best=c;area=a;}} }}
            const ctx = best.getContext('2d', {{willReadFrequently:true}});
            const img = ctx.getImageData(0,0,{cw},{ch});
            return btoa(String.fromCharCode.apply(null, img.data));
          }})()
        """)
        raw = base64.b64decode(b64)
        return np.frombuffer(raw, dtype=np.uint8).reshape((ch, cw, 4))
    except Exception:
        pass
    # B) Screenshot + resize exact
    bw,bh,bx,by = info["bw"],info["bh"],info["bx"],info["by"]
    buf = await PW.page.screenshot(clip={"x":bx,"y":by,"width":bw,"height":bh})
    im = Image.open(io.BytesIO(buf)).convert("RGBA").resize((cw,ch), Image.NEAREST)
    return np.array(im, dtype=np.uint8)

# ---------- Diff helpers ----------
def within_tol(a: np.ndarray, b: np.ndarray, tol: int) -> np.ndarray:
    d = np.abs(a.astype(np.int16) - b.astype(np.int16))
    return (d[...,0] <= tol) & (d[...,1] <= tol) & (d[...,2] <= tol) & (d[...,3] <= tol)

def count_diff_mask(ok_mask: np.ndarray) -> int:
    return int((~ok_mask).sum())

def count_diff_pixels(a: np.ndarray, b: np.ndarray, tol: int, stride: int=1) -> int:
    if stride<1: stride=1
    aa = a[::stride, ::stride, :]
    bb = b[::stride, ::stride, :]
    same = within_tol(aa, bb, tol)
    diff_sample = int((~same).sum())
    if stride == 1: return diff_sample
    scale = (a.shape[0]*a.shape[1])/(aa.shape[0]*aa.shape[1])
    return int(diff_sample*scale)

# ---------- Simulations "Discord" → console.log ----------
LAST_EVENT: Dict[Tuple[int, Tuple[int,int,int,int]], Tuple[str, float]] = {}

def sim_embed_send(title: str, description: str, color_hex: str):
    print(f'console.log("envoie embed: {title} | {description} | color={color_hex}")')

def sim_embed_update(title: str, description: str, color_hex: str):
    print(f'console.log("modif embed: {title} | {description} | color={color_hex}")')

# ---------- Tuilage ----------
@dataclass
class TileRect:
    x: int; y: int; w: int; h: int

@dataclass
class TilerState:
    tiles: List[TileRect]
    idx: int = 0

TILERS: Dict[int, TilerState] = {}
TPL_FP: Dict[int, tuple] = {}

def build_tiles(w: int, h: int, tw: int, th: int) -> List[TileRect]:
    out=[]
    for yy in range(0,h,th):
        hh=min(th,h-yy)
        for xx in range(0,w,tw):
            ww=min(tw,w-xx)
            out.append(TileRect(xx,yy,ww,hh))
    return out

def next_tile(art_id: int) -> Optional[TileRect]:
    st = TILERS.get(art_id)
    if not st or not st.tiles: return None
    t = st.tiles[st.idx]
    st.idx = (st.idx+1) % len(st.tiles)
    return t

# ---------- Worker principal ----------
_running = False

async def monitor_loop():
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
            period = max(0.2, 1.0/scan_hz)

            arts = con.execute("SELECT * FROM artworks ORDER BY id ASC").fetchall()
            ids = [a["id"] for a in arts]
            if rr_ids != ids: rr_ids, rr_pos = ids, 0

            # (re)build tuiles & filtre hors-zone
            for a in arts:
                aid=a["id"]
                trow = con.execute("SELECT w,h,rgba FROM templates WHERE artwork_id=?", (aid,)).fetchone()
                fp = (trow["w"], trow["h"], len(trow["rgba"])) if trow else (0,0,0)
                rebuild = (aid not in TILERS) or (TPL_FP.get(aid) != fp)
                if rebuild:
                    tiles = build_tiles(a["w"], a["h"], tile_w, tile_h)
                    if ignore_outside:
                        tpl_alpha = None
                        poly_mask = None
                        if trow:
                            tpl = np.frombuffer(trow["rgba"], dtype=np.uint8).reshape((trow["h"], trow["w"], 4))
                            tpl_alpha = (tpl[...,3] > 0)
                        mrow = con.execute("SELECT w,h,mask FROM masks WHERE artwork_id=?", (aid,)).fetchone()
                        if mrow:
                            poly_mask = (np.frombuffer(mrow["mask"], dtype=np.uint8).reshape((mrow["h"], mrow["w"])) > 0)
                        keep=[]
                        for tr in tiles:
                            sub=None
                            if detourage_mode=="alpha_only" and tpl_alpha is not None:
                                sub = tpl_alpha[tr.y:tr.y+tr.h, tr.x:tr.x+tr.w]
                            elif detourage_mode=="polygon_only" and poly_mask is not None:
                                sub = poly_mask[tr.y:tr.y+tr.h, tr.x:tr.x+tr.w]
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

            # Frame unique
            frame = await get_full_canvas(page)
            if frame is None:
                await asyncio.sleep(period); continue

            # Planif équitable
            budget = tiles_global
            order = rr_ids[:]
            if hot:
                hot_order = [i for i in order if i in hot]
                cold_order = [i for i in order if i not in hot]
                order = hot_order + cold_order

            idx = rr_pos
            if one_per_art:
                for _ in range(len(order)):
                    if budget <= 0: break
                    aid = order[idx]; idx = (idx+1) % len(order)
                    a = next((x for x in arts if x["id"]==aid), None)
                    if not a: continue
                    tile = next_tile(aid)
                    if not tile: continue

                    y0 = a["y"]+tile.y; y1 = y0+tile.h
                    x0 = a["x"]+tile.x; x1 = x0+tile.w
                    cur = frame[y0:y1, x0:x1, :]

                    trow = con.execute("SELECT w,h,rgba FROM templates WHERE artwork_id=?", (aid,)).fetchone()
                    grow = con.execute("SELECT w,h,rgba FROM grounds   WHERE artwork_id=?", (aid,)).fetchone()
                    mrow = con.execute("SELECT w,h,mask FROM masks WHERE artwork_id=?", (aid,)).fetchone()
                    mode = a["mode"] or "build"

                    if trow and grow:
                        tpl = np.frombuffer(trow["rgba"], dtype=np.uint8).reshape((trow["h"], trow["w"], 4))
                        grd = np.frombuffer(grow["rgba"], dtype=np.uint8).reshape((grow["h"], grow["w"], 4))
                        tpl_t = tpl[tile.y:tile.y+tile.h, tile.x:tile.x+tile.w, :]
                        grd_t = grd[tile.y:tile.y+tile.h, tile.x:tile.x+tile.w, :]

                        alpha_mask = (tpl_t[...,3] > 0)
                        deface_mask = (tpl_t[...,0]==DEFACE_RGB[0]) & (tpl_t[...,1]==DEFACE_RGB[1]) & (tpl_t[...,2]==DEFACE_RGB[2])
                        poly_mask_t = None
                        if mrow:
                            msk = np.frombuffer(mrow["mask"], dtype=np.uint8).reshape((mrow["h"], mrow["w"]))
                            poly_mask_t = (msk[tile.y:tile.y+tile.h, tile.x:tile.x+tile.w] > 0)

                        if detourage_mode == "alpha_only":
                            inside = alpha_mask
                        elif detourage_mode == "polygon_only":
                            inside = poly_mask_t if poly_mask_t is not None else alpha_mask
                        else:
                            inside = alpha_mask | (poly_mask_t if poly_mask_t is not None else False)

                        tpl_ok = within_tol(cur, tpl_t, tol)
                        grd_ok = within_tol(cur, grd_t, tol)
                        ok_inside_nondef = (tpl_ok | grd_ok) if mode=="build" else tpl_ok
                        ok_inside = np.where(deface_mask, grd_ok, ok_inside_nondef)
                        ok_outside = True if ignore_outside else grd_ok
                        ok = np.where(inside, ok_inside, ok_outside)
                        diffs = count_diff_mask(ok)
                    else:
                        # Fallback baseline seulement
                        brow = con.execute("SELECT w,h,rgba FROM baselines WHERE artwork_id=?", (aid,)).fetchone()
                        if not brow:
                            budget -= 1; continue
                        base = np.frombuffer(brow["rgba"], dtype=np.uint8).reshape((brow["h"], brow["w"], 4))
                        base_t = base[tile.y:tile.y+tile.h, tile.x:tile.x+tile.w, :]
                        diffs = count_diff_pixels(base_t, cur, tol, stride=stride)
                        if staged and diffs >= max(3, susp_t//2) and stride>1:
                            diffs = count_diff_pixels(base_t, cur, tol, stride=1)

                    tile_key = (aid, (tile.x, tile.y, tile.w, tile.h))
                    prev = LAST_EVENT.get(tile_key, ("none", 0.0))[0]

                    if diffs >= degr_t:
                        print("Dégradation en cours !")
                        title = "Dégradation en cours !"
                        desc = f"Œuvre: {a['name']} | tuile=({tile.x},{tile.y},{tile.w},{tile.h}) | diffs={diffs} (≥{degr_t}) | zone=({a['x']},{a['y']},{a['w']},{a['h']})"
                        if prev == "suspicion": sim_embed_update(title, desc, "#E74C3C")
                        else:                    sim_embed_send  (title, desc, "#E74C3C")
                        LAST_EVENT[tile_key] = ("degradation", time.time()); hot.add(aid)
                    elif diffs >= susp_t:
                        print("Suspicion dégradation")
                        title = "Suspicion de dégradation"
                        desc = f"Œuvre: {a['name']} | tuile=({tile.x},{tile.y},{tile.w},{tile.h}) | diffs={diffs} (≥{susp_t}) | zone=({a['x']},{a['y']},{a['w']},{a['h']})"
                        if prev in ("suspicion","degradation"): sim_embed_update(title, desc, "#F1C40F")
                        else:                                   sim_embed_send  (title, desc, "#F1C40F")
                        LAST_EVENT[tile_key] = ("suspicion", time.time()); hot.add(aid)

                    budget -= 1
                    if budget <= 0: break

            rr_pos = idx

            # Passe 2 : consommer le reste en round-robin
            idx2 = rr_pos
            while budget > 0 and rr_ids:
                aid = rr_ids[idx2]; idx2 = (idx2+1) % len(rr_ids)
                a = next((x for x in arts if x["id"]==aid), None)
                if not a: continue
                tile = next_tile(aid)
                if not tile: continue

                y0 = a["y"]+tile.y; y1 = y0+tile.h
                x0 = a["x"]+tile.x; x1 = x0+tile.w
                cur = frame[y0:y1, x0:x1, :]

                trow = con.execute("SELECT w,h,rgba FROM templates WHERE artwork_id=?", (aid,)).fetchone()
                grow = con.execute("SELECT w,h,rgba 