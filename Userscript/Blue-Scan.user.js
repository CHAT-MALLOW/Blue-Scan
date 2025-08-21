// ==UserScript==
// @name         Blue Scan UI — strict BM placement (TL + Template), detourage & tiles
// @namespace    pinouland.blue-scan.ui
// @version      0.6.1
// @description  Panneau bleu pour piloter le watchdog: création via TL+Template (taille native), config, liste, snapshot sol/baseline, modes, tuilage & scan simultané. (Sans Discord, logs simulés côté backend.)
// @match        https://wplace.live/*
// @grant        GM_addStyle
// @run-at       document-end
// ==/UserScript==

(function () {
  "use strict";

  // ================== Helpers de base ==================
  const LS_KEY = "BLUE_SCAN_BACKEND_URL";
  const BACKEND_URL = (localStorage.getItem(LS_KEY) || "http://localhost:8000").replace(/\/$/, "");
  const api = (p, o = {}) =>
    fetch(BACKEND_URL + p, Object.assign({ headers: { "Content-Type": "application/json" } }, o));

  function mainCanvas() {
    const cs = Array.from(document.querySelectorAll("canvas"));
    if (!cs.length) return null;
    return cs.reduce((a, b) => (a.width * a.height > b.width * b.height ? a : b));
  }

  async function blobUrlToDataURL(url) {
    const r = await fetch(url);
    const b = await r.blob();
    return await new Promise((res) => {
      const rd = new FileReader();
      rd.onload = () => res(rd.result);
      rd.readAsDataURL(b);
    });
  }

  // Essaie de repérer un overlay à la Blue Marble (meilleur candidat)
  async function sniffBlueMarbleTemplate() {
    const canvas = mainCanvas();
    if (!canvas) return null;
    let best = null, score = 0;
    for (const img of Array.from(document.images)) {
      const css = getComputedStyle(img), r = img.getBoundingClientRect(), a = r.width * r.height;
      const s = (css.position !== "static" ? 2 : 0)
              + (/(marble|template|overlay)/i.test(img.className + " " + img.id) ? 5 : 0)
              + (a > 10000 ? 1 : 0);
      if (s > 0 && a > score) { best = img; score = a; }
    }
    if (!best) return null;
    let data_url = best.src;
    if (/^blob:/.test(data_url)) data_url = await blobUrlToDataURL(data_url);
    if (!/^data:image\//.test(data_url)) return null;
    return { data_url };
  }

  function dataURLFromFile(file) {
    return new Promise((res, rej) => {
      const rd = new FileReader();
      rd.onerror = rej;
      rd.onload = () => res(rd.result);
      rd.readAsDataURL(file);
    });
  }

  // ================== Styles & Shell UI ==================
  GM_addStyle(`
    .bsui { position: fixed; right: 16px; bottom: 16px; width: 420px; z-index: 2147483647;
      color: #fff; font-family: Inter, system-ui, Segoe UI, Roboto, Arial, sans-serif;
      background: linear-gradient(180deg,#0e5bd6,#0940a8);
      border-radius: 14px; box-shadow: 0 10px 30px rgba(0,0,0,.35); overflow: hidden; }
    .bsui-h { display: flex; align-items: center; gap: 8px; padding: 12px 14px; background: rgba(255,255,255,.08); }
    .bsui-dot { width: 10px; height: 10px; border-radius: 50%; background: #8b97a8; }
    .bsui-title { font-weight: 800; }
    .bsui-body { padding: 12px 14px; max-height: 60vh; overflow: auto; }
    .bsui-row { display: flex; gap: 8px; margin-bottom: 8px; }
    .bsui-row input, .bsui-row select { flex: 1; padding: 8px 10px; border-radius: 10px;
      border: 1px solid rgba(255,255,255,.25); background: rgba(255,255,255,.12); color: #fff; outline: none; }
    .bsui-btn { padding: 10px 12px; border-radius: 10px; border: 1px solid rgba(255,255,255,.25);
      background: rgba(255,255,255,.15); color: #fff; font-weight: 700; cursor: pointer; }
    .bsui-btn:hover { background: rgba(255,255,255,.22); }
    .bsui-pill { font-size: 12px; border: 1px solid rgba(255,255,255,.3); padding: 6px 10px; border-radius: 999px; }
    .bsui-card { background: rgba(0,0,0,.15); border: 1px solid rgba(255,255,255,.18); border-radius: 12px; padding: 10px; margin-bottom: 8px; }
    .bsui-card h4 { margin: 0 0 6px 0; font-size: 14px; }
    .bsui-meta { font-size: 12px; opacity: .9; }
    .bsui-actions { display: flex; gap: 8px; margin-top: 8px; flex-wrap: wrap; }
    .bsui-foot { display: flex; align-items: center; justify-content: space-between; background: rgba(255,255,255,.08); padding: 10px 14px; }
    .bsui-status { font-size: 12px; opacity: .9; }
    .bsui-sep { height: 1px; background: rgba(255,255,255,.2); margin: 10px 0; }
    .bsui-muted { opacity: .8; font-size: 12px; }
  `);

  const root = document.createElement("div");
  root.className = "bsui";
  root.innerHTML = `
    <div class="bsui-h">
      <div class="bsui-dot" id="bs-dot"></div>
      <div class="bsui-title">Blue Scan</div>
      <div style="flex:1"></div>
      <span class="bsui-pill" id="bs-mode">Liste</span>
    </div>
    <div class="bsui-body" id="bs-body"></div>
    <div class="bsui-foot">
      <div class="bsui-status" id="bs-status">Prêt.</div>
      <div style="display:flex; gap:8px">
        <button class="bsui-btn" id="bs-btn-config">Config</button>
        <button class="bsui-btn" id="bs-btn-list">Liste</button>
        <button class="bsui-btn" id="bs-btn-monitor">Start</button>
      </div>
    </div>
  `;
  document.body.appendChild(root);

  const el = {
    body: root.querySelector("#bs-body"),
    status: root.querySelector("#bs-status"),
    dot: root.querySelector("#bs-dot"),
    mode: root.querySelector("#bs-mode"),
    btnConfig: root.querySelector("#bs-btn-config"),
    btnList: root.querySelector("#bs-btn-list"),
    btnMonitor: root.querySelector("#bs-btn-monitor"),
  };
  const setStatus = (m) => (el.status.textContent = m);
  const setDot = (c) => (el.dot.style.background = c);

  // ================== API thin client ==================
  const loadConfig = async () => (await (await api("/config")).json());
  const saveConfig = async (c) => {
    const r = await api("/config", { method: "POST", body: JSON.stringify(c) });
    if (!r.ok) throw new Error("POST /config failed");
  };
  const listArts = async () => (await (await api("/artworks")).json());

  // ================== Vues ==================
  function renderConfig(c) {
    el.mode.textContent = "Config";
    el.body.innerHTML = `
      <div class="bsui-row">
        <input id="burl" placeholder="Backend URL" value="${BACKEND_URL}">
      </div>

      <div class="bsui-row">
        <input id="scan_hz" type="number" min="0.2" step="0.1" placeholder="scan_hz" value="${c.scan_hz || 1}">
        <input id="stride" type="number" min="1" step="1" placeholder="stride" value="${c.stride || 1}">
      </div>
      <div class="bsui-row">
        <input id="tile_w" type="number" min="10" max="1000" step="10" placeholder="tile_w" value="${c.tile_w || 100}">
        <input id="tile_h" type="number" min="10" max="1000" step="10" placeholder="tile_h" value="${c.tile_h || 100}">
      </div>
      <div class="bsui-row">
        <input id="tiles_global_per_tick" type="number" min="1" step="1" placeholder="tiles_global_per_tick" value="${c.tiles_global_per_tick || 64}">
        <select id="one_tile_per_artwork">
          <option value="true" ${c.one_tile_per_artwork ? "selected" : ""}>one_tile_per_artwork: true</option>
          <option value="false" ${!c.one_tile_per_artwork ? "selected" : ""}>one_tile_per_artwork: false</option>
        </select>
      </div>
      <div class="bsui-row">
        <input id="tol" type="number" min="0" max="255" step="1" placeholder="tolerance" value="${c.tolerance}">
        <input id="susp" type="number" min="1" step="1" placeholder="suspicion_threshold" value="${c.suspicion_threshold}">
        <input id="degr" type="number" min="1" step="1" placeholder="degradation_threshold" value="${c.degradation_threshold}">
      </div>
      <div class="bsui-row">
        <select id="staged">
          <option value="true" ${c.staged_scan ? "selected" : ""}>staged_scan: true</option>
          <option value="false" ${!c.staged_scan ? "selected" : ""}>staged_scan: false</option>
        </select>
        <select id="ignore_outside">
          <option value="true" ${c.ignore_outside ? "selected" : ""}>ignore_outside: true</option>
          <option value="false" ${!c.ignore_outside ? "selected" : ""}>ignore_outside: false</option>
        </select>
        <select id="detourage_mode">
          <option value="alpha_only" ${c.detourage_mode === "alpha_only" ? "selected" : ""}>detourage: alpha_only</option>
          <option value="polygon_only" ${c.detourage_mode === "polygon_only" ? "selected" : ""}>detourage: polygon_only</option>
          <option value="alpha_or_polygon" ${c.detourage_mode === "alpha_or_polygon" ? "selected" : ""}>detourage: alpha_or_polygon</option>
        </select>
      </div>

      <div class="bsui-actions">
        <button class="bsui-btn" id="save">Enregistrer</button>
      </div>

      <div class="bsui-sep"></div>
      <h4>Créer via TL + Template (strict BM)</h4>
      <div class="bsui-row">
        <input id="tl" placeholder="TL x,y (clic 📍)">
        <button class="bsui-btn" id="pinTL">📍 Pin TL</button>
      </div>
      <div class="bsui-row">
        <input id="namebm" placeholder="Nom de l'œuvre (optionnel)">
        <input id="filepick" type="file" accept="image/png,image/webp">
      </div>
      <div class="bsui-actions">
        <button class="bsui-btn" id="createtl">Créer (TL + Template)</button>
        <button class="bsui-btn" id="createtlAuto">Créer (TL + Overlay détecté)</button>
      </div>
      <div class="bsui-muted">Le PNG est gardé à sa taille native; seule l'ancre (TL) est prise en compte, comme Blue Marble.</div>

      <div class="bsui-sep"></div>
      <h4>Ajouter une œuvre (x,y,w,h)</h4>
      <div class="bsui-row">
        <input id="name" placeholder="Nom">
        <input id="xywh" placeholder="x,y,w,h (ex: 100,200,40,40)">
      </div>
      <div class="bsui-actions">
        <button class="bsui-btn" id="add">Ajouter</button>
      </div>

      <div class="bsui-sep"></div>
      <h4>Ajouter par 4 coins</h4>
      <div class="bsui-row">
        <input id="corners" placeholder="x1,y1;x2,y2;x3,y3;x4,y4">
      </div>
      <div class="bsui-actions">
        <button class="bsui-btn" id="add4">Ajouter (4 coins)</button>
      </div>
    `;

    // ---- Interactions section Config ----
    el.body.querySelector("#save").onclick = async () => {
      try {
        const burl = el.body.querySelector("#burl").value.trim();
        if (burl) localStorage.setItem(LS_KEY, burl);
        await saveConfig({
          guild_id: "", channel_id: "", discord_webhook: "", poll_ms: 2000,
          scan_hz: Math.max(0.2, +el.body.querySelector("#scan_hz").value || 1),
          tolerance: Math.max(0, Math.min(255, +el.body.querySelector("#tol").value || 8)),
          suspicion_threshold: Math.max(1, +el.body.querySelector("#susp").value || 5),
          degradation_threshold: Math.max(1, +el.body.querySelector("#degr").value || 30),
          stride: Math.max(1, +el.body.querySelector("#stride").value || 1),
          staged_scan: el.body.querySelector("#staged").value === "true",
          tile_w: Math.max(10, Math.min(1000, +el.body.querySelector("#tile_w").value || 100)),
          tile_h: Math.max(10, Math.min(1000, +el.body.querySelector("#tile_h").value || 100)),
          tiles_per_tick: 1,
          tiles_global_per_tick: Math.max(1, +el.body.querySelector("#tiles_global_per_tick").value || 64),
          one_tile_per_artwork: el.body.querySelector("#one_tile_per_artwork").value === "true",
          ignore_outside: el.body.querySelector("#ignore_outside").value === "true",
          detourage_mode: el.body.querySelector("#detourage_mode").value,
        });
        setStatus("Config enregistrée.");
      } catch {
        setStatus("Échec enregistrement config.");
      }
    };

    const canvas = mainCanvas();
    el.body.querySelector("#pinTL").onclick = () => {
      if (!canvas) { alert("Canvas introuvable."); return; }
      setStatus("Clique le coin haut-gauche sur la carte…");
      const onClick = (ev) => {
        const r = canvas.getBoundingClientRect();
        const x = Math.floor(((ev.clientX - r.left) * canvas.width) / r.width);
        const y = Math.floor(((ev.clientY - r.top) * canvas.height) / r.height);
        el.body.querySelector("#tl").value = `${x},${y}`;
        setStatus(`TL = (${x},${y})`);
        window.removeEventListener("click", onClick, true);
      };
      window.addEventListener("click", onClick, true);
    };

    el.body.querySelector("#createtl").onclick = async () => {
      const m = (el.body.querySelector("#tl").value || "").match(/^\s*(-?\d+)\s*,\s*(-?\d+)\s*$/);
      if (!m) { alert("Indique TL x,y"); return; }
      const name = el.body.querySelector("#namebm").value.trim() || "Art " + Date.now();
      const f = el.body.querySelector("#filepick").files?.[0];
      if (!f) { alert("Choisis un template (PNG/WEBP)."); return; }
      try {
        const data_url = await dataURLFromFile(f);
        const r = await api("/artworks/place_tl", {
          method: "POST",
          body: JSON.stringify({ name, tl_x: +m[1], tl_y: +m[2], data_url }),
        });
        setStatus(r.ok ? `Créée: « ${name} » (TL + taille native).` : "Échec création TL+Template.");
      } catch {
        setStatus("Échec création TL+Template.");
      }
    };

    el.body.querySelector("#createtlAuto").onclick = async () => {
      const m = (el.body.querySelector("#tl").value || "").match(/^\s*(-?\d+)\s*,\s*(-?\d+)\s*$/);
      if (!m) { alert("Indique TL x,y"); return; }
      const name = el.body.querySelector("#namebm").value.trim() || "Art " + Date.now();
      try {
        const sniff = await sniffBlueMarbleTemplate();
        if (!sniff) { alert("Overlay non détecté."); return; }
        const r = await api("/artworks/place_tl", {
          method: "POST",
          body: JSON.stringify({ name, tl_x: +m[1], tl_y: +m[2], data_url: sniff.data_url }),
        });
        setStatus(r.ok ? `Créée: « ${name} » (TL + overlay).` : "Échec création TL+overlay.");
      } catch {
        setStatus("Échec création TL+overlay.");
      }
    };

    el.body.querySelector("#add").onclick = async () => {
      const name = el.body.querySelector("#name").value.trim() || "Art " + Date.now();
      const pos = el.body.querySelector("#xywh").value.trim();
      const m = pos.match(/^\s*(-?\d+)\s*,\s*(-?\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*$/);
      if (!m) { alert("Format attendu: x,y,w,h"); return; }
      try {
        const [_, xs, ys, ws, hs] = m;
        const r = await api("/artworks", {
          method: "POST",
          body: JSON.stringify({ name, x: +xs, y: +ys, w: +ws, h: +hs }),
        });
        setStatus(r.ok ? `Œuvre « ${name} » ajoutée.` : "Échec ajout.");
      } catch {
        setStatus("Échec ajout.");
      }
    };

    el.body.querySelector("#add4").onclick = async () => {
      const val = el.body.querySelector("#corners").value.trim();
      const parts = val.split(";").map((s) => s.trim()).filter(Boolean);
      if (parts.length !== 4) { alert("Il faut 4 points"); return; }
      const corners = parts.map((p) => p.split(",").map((n) => +n.trim()));
      const name = "Art4-" + Date.now();
      try {
        const r = await api("/artworks/corners", { method: "POST", body: JSON.stringify({ name, corners }) });
        setStatus(r.ok ? `Œuvre « ${name} » ajoutée (4 coins).` : "Échec ajout (4 coins).");
      } catch {
        setStatus("Échec ajout (4 coins).");
      }
    };
  }

  async function renderList() {
    el.mode.textContent = "Liste";
    try {
      const arts = await listArts();
      if (!arts.length) { el.body.innerHTML = `<div style="opacity:.9">Aucune œuvre.</div>`; return; }
      el.body.innerHTML = arts.map(a => `
        <div class="bsui-card" data-id="${a.id}">
          <h4>${escapeHtml(a.name)}</h4>
          <div class="bsui-meta">(${a.x}, ${a.y}, ${a.w}, ${a.h}) • ${a.added_at} • mode=${a.mode}</div>
          <div class="bsui-actions">
            <button class="bsui-btn go" data-x="${a.x}" data-y="${a.y}">Aller</button>
            <button class="bsui-btn snap" data-id="${a.id}">Snapshot baseline</button>
            <button class="bsui-btn ground" data-id="${a.id}">Scanner sol</button>
            <button class="bsui-btn tplfile" data-id="${a.id}">Mettre à jour template (strict)</button>
            <select class="modepick" data-id="${a.id}">
              <option value="build" ${a.mode === "build" ? "selected" : ""}>En construction</option>
              <option value="protect" ${a.mode === "protect" ? "selected" : ""}>Protection</option>
            </select>
            <button class="bsui-btn del" data-id="${a.id}">Supprimer</button>
          </div>
        </div>`
      ).join("");

      // actions
      el.body.querySelectorAll(".go").forEach(b => {
        b.onclick = () => {
          const x = +b.dataset.x, y = +b.dataset.y;
          const u = new URL(location.href);
          u.searchParams.set("x", x); u.searchParams.set("y", y);
          navigator.clipboard?.writeText(`(${x},${y})`).catch(() => {});
          window.open(u.toString(), "_blank");
        };
      });
      el.body.querySelectorAll(".snap").forEach(b => {
        b.onclick = async () => {
          const id = b.dataset.id;
          setStatus("Baseline...");
          try {
            const r = await api(`/artworks/${id}/snapshot`, { method: "POST" });
            setStatus(r.ok ? "Baseline OK." : "Baseline KO.");
          } catch { setStatus("Baseline KO."); }
        };
      });
      el.body.querySelectorAll(".ground").forEach(b => {
        b.onclick = async () => {
          const id = b.dataset.id;
          setStatus("Scan sol...");
          try {
            const r = await api(`/artworks/${id}/ground_snapshot`, { method: "POST" });
            setStatus(r.ok ? "Sol OK." : "Sol KO.");
          } catch { setStatus("Sol KO."); }
        };
      });
      el.body.querySelectorAll(".tplfile").forEach(b => {
        b.onclick = async () => {
          const id = b.dataset.id;
          const inp = document.createElement("input");
          inp.type = "file"; inp.accept = "image/png,image/webp";
          inp.onchange = async () => {
            const f = inp.files?.[0]; if (!f) return;
            try {
              const data_url = await dataURLFromFile(f);
              const r = await api(`/artworks/${id}/template`, { method: "POST", body: JSON.stringify({ data_url }) });
              setStatus(r.ok ? "Template mis à jour (taille native)." : "Échec template.");
            } catch { setStatus("Échec template."); }
          };
          inp.click();
        };
      });
      el.body.querySelectorAll(".modepick").forEach(sel => {
        sel.onchange = async () => {
          const id = sel.dataset.id, mode = sel.value;
          try {
            const r = await api(`/artworks/${id}/mode`, { method: "POST", body: JSON.stringify({ mode }) });
            setStatus(r.ok ? `Mode=${mode}` : "Échec mode.");
          } catch { setStatus("Échec mode."); }
        };
      });
      el.body.querySelectorAll(".del").forEach(b => {
        b.onclick = async () => {
          const id = b.dataset.id;
          if (!confirm("Supprimer l'œuvre ?")) return;
          try { await api(`/artworks/${id}`, { method: "DELETE" }); renderList(); }
          catch { setStatus("Échec suppression."); }
        };
      });
    } catch {
      el.body.innerHTML = `<div style="opacity:.9">Backend injoignable ?</div>`;
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  }

  // ================== Nav boutons ==================
  el.btnConfig.onclick = async () => { try { renderConfig(await loadConfig()); } catch { setStatus("Backend injoignable ?"); } };
  el.btnList.onclick = renderList;

  let running = false;
  el.btnMonitor.onclick = async () => {
    try {
      if (!running) {
        const r = await api("/monitor/start", { method: "POST" });
        if (r.ok) { running = true; el.bt
