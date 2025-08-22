// ==UserScript==
// @name         Blue Scan UI — Upload + Grab 4 nums + Contours fix TL (v1.3.1)
// @namespace    pinouland.blue-scan.ui
// @version      1.3.1
// @description  Menu minimal, Upload (TL + taille native), 📍 pour lire (TlX,TlY,PxX,PxY). Contours collés au canvas ET projetés via (world - TL)*scale. Backend auto.
// @match        https://wplace.live/*
// @match        https://*.wplace.live/*
// @grant        GM_addStyle
// @grant        GM_xmlhttpRequest
// @connect      82.112.240.14
// @connect      localhost
// @connect      127.0.0.1
// @run-at       document-end
// ==/UserScript==

(function () {
  "use strict";

  // -------------------- SPA reinjection --------------------
  new MutationObserver(() => { if (!document.getElementById('bsui-root')) injectUI(); })
    .observe(document.documentElement, { childList:true, subtree:true });
  window.addEventListener('pageshow', () => { if (!document.getElementById('bsui-root')) injectUI(); });

  // -------------------- Backend auto -----------------------
  const LS_BACKEND = "BLUE_SCAN_BACKEND_URL";
  let CURRENT_BACKEND = null;
  const norm = (u)=> String(u||'').trim().replace(/\/$/, '');
  const uniq = (a)=> Array.from(new Set(a.filter(Boolean)));
  const candidates = ()=> uniq([
    norm(localStorage.getItem(LS_BACKEND)),
    norm(window.BS_BACKEND_URL || ''),
    "http://82.112.240.14:8000",
    "http://82.112.240.14",
    "http://localhost:8000",
    "http://127.0.0.1:8000",
  ]);
  const gmXHR = (url, opts={}) => new Promise((resolve, reject) => {
    GM_xmlhttpRequest({
      method: opts.method || "GET", url,
      headers: Object.assign({ "Content-Type": "application/json" }, opts.headers || {}),
      data: opts.body || null, timeout: opts.timeout || 4000,
      onload: (r) => resolve({
        ok: r.status >= 200 && r.status < 300,
        status: r.status, statusText: r.statusText,
        text: () => Promise.resolve(r.responseText||""),
        json: () => Promise.resolve().then(() => JSON.parse(r.responseText||"{}")).catch(() => ({})),
      }),
      onerror: reject, ontimeout: () => reject(new Error("timeout")),
    });
  });
  async function discoverBackend() {
    for (const base of candidates()) {
      try { const r = await gmXHR(base + "/healthz", { timeout: 2500 }); if (r && r.ok) { CURRENT_BACKEND = base; localStorage.setItem(LS_BACKEND, base); return base; } } catch {}
    }
    CURRENT_BACKEND = norm(localStorage.getItem(LS_BACKEND)) || "http://82.112.240.14:8000";
    return CURRENT_BACKEND;
  }
  const api = (path, opts={}) => gmXHR((CURRENT_BACKEND || localStorage.getItem(LS_BACKEND) || "http://82.112.240.14:8000") + path, opts);

  // -------------------- Helpers ----------------------------
  const escapeHtml = (s)=> String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  function mainCanvas() {
    const cs = Array.from(document.querySelectorAll("canvas"));
    if (!cs.length) return null;
    // le plus grand en affichage est la carte
    return cs.reduce((a,b)=> (a.clientWidth*a.clientHeight > b.clientWidth*b.clientHeight ? a : b));
  }
  async function blobUrlToDataURL(url) {
    const r = await fetch(url); const b = await r.blob();
    return await new Promise((res)=>{ const fr=new FileReader(); fr.onload=()=>res(fr.result); fr.readAsDataURL(b); });
  }
  async function sniffBlueMarbleTemplate() {
    const canvas = mainCanvas(); if (!canvas) return null;
    let best=null, score=0;
    for (const img of Array.from(document.images)) {
      const css = getComputedStyle(img), r = img.getBoundingClientRect(), area = r.width*r.height;
      const s = (css.position!=="static"?2:0) + (/(marble|template|overlay)/i.test(img.className+" "+img.id)?5:0) + (area>10000?1:0);
      if (s>0 && area>score) { best=img; score=area; }
    }
    if (!best) return null;
    let data_url = best.src;
    if (/^blob:/.test(data_url)) data_url = await blobUrlToDataURL(data_url);
    if (!/^data:image\//.test(data_url)) return null;
    return { data_url };
  }
  const dataURLFromFile = (file)=> new Promise((res,rej)=>{ const fr=new FileReader(); fr.onerror=rej; fr.onload=()=>res(fr.result); fr.readAsDataURL(file); });

  // --- Lire HUD "(Tl X: ..., Tl Y: ..., Px X: ..., Px Y: ...)" et TL courant ---
  function readHudFour() {
    const tryNode = (node) => {
      const txt = (node.textContent || "").trim();
      const m = txt.match(/\(\s*T[lL]\s*X:\s*(-?\d+)\s*,\s*T[lL]\s*Y:\s*(-?\d+)\s*,\s*P[xX]\s*X:\s*(-?\d+)\s*,\s*P[xX]\s*Y:\s*(-?\d+)\s*\)/);
      if (m) return { tl_x:+m[1], tl_y:+m[2], px_x:+m[3], px_y:+m[4] };
      return null;
    };
    const suspects = document.querySelectorAll('.leaflet-popup-content, .leaflet-container, [class*="popup"], [class*="Pixel"], [class*="pixel"]');
    for (const n of suspects) {
      const v = tryNode(n); if (v) return v;
      for (const c of n.querySelectorAll('*')) { const r = tryNode(c); if (r) return r; }
    }
    const r = tryNode(document.body); if (r) return r;
    return null;
  }
  function currentTL() {
    const hud = readHudFour();
    if (hud) return { x: hud.tl_x, y: hud.tl_y };
    // fallback URL ?x=..&y=..
    try {
      const u = new URL(location.href);
      const x = parseInt(u.searchParams.get("x")||"",10);
      const y = parseInt(u.searchParams.get("y")||"",10);
      if (Number.isFinite(x) && Number.isFinite(y)) return { x, y };
    } catch {}
    return null;
  }

  // -------------------- Styles -----------------------------
  GM_addStyle(`
    #bsui-root { position: fixed; right: 16px; bottom: 16px; width: 420px; z-index: 2147483647;
      color: #fff; font-family: Inter, system-ui, Segoe UI, Roboto, Arial, sans-serif;
      background: linear-gradient(180deg,#0e5bd6,#0940a8); border-radius: 14px;
      box-shadow: 0 10px 30px rgba(0,0,0,.35); overflow: hidden; }
    #bsui-root .h { display:flex; align-items:center; gap:8px; padding:12px 14px; background: rgba(255,255,255,.08); }
    #bsui-root .title { font-weight: 800; letter-spacing:.6px; }
    #bsui-root .body { padding:16px; max-height: 60vh; overflow:auto; display:flex; align-items:center; justify-content:center; }
    #bsui-root .big { font-size: 26px; font-weight: 900; opacity: .95; text-shadow: 0 2px 8px rgba(0,0,0,.35); }
    #bsui-root .foot { display:flex; align-items:center; justify-content:space-between; background: rgba(255,255,255,.08); padding:10px 14px; }
    #bsui-root .status { font-size:12px; opacity:.9; }
    #bsui-root .btnbar { display:flex; gap:8px; flex-wrap:wrap; }
    #bsui-root .btn { padding:10px 12px; border-radius:10px; border:1px solid rgba(255,255,255,.25);
      background: rgba(255,255,255,.15); color:#fff; font-weight:700; cursor:pointer; }
    #bsui-root .btn:hover { background: rgba(255,255,255,.22); }

    #bsui-root .list .card { background: rgba(0,0,0,.15); border:1px solid rgba(255,255,255,.18); border-radius:12px; padding:10px; margin-bottom:8px; }
    #bsui-root .list .card h4 { margin:0 0 6px 0; font-size:14px; }
    #bsui-root .list .meta { font-size:12px; opacity:.9; }
    #bsui-root .list .actions { display:flex; gap:8px; margin-top:8px; flex-wrap:wrap; }

    #bsui-modal { position: fixed; inset: 0; z-index: 2147483647; display:none; align-items:center; justify-content:center; }
    #bsui-modal .back { position:absolute; inset:0; background: rgba(0,0,0,.45); }
    #bsui-modal .panel { position:relative; width: min(92vw, 560px); background: #0e2f73; border:1px solid rgba(255,255,255,.25);
      color:#fff; padding:16px; border-radius: 12px; box-shadow: 0 10px 30px rgba(0,0,0,.45); }
    #bsui-modal .panel h3 { margin:0 0 12px 0; font-size:16px; }
    #bsui-modal .row { display:flex; gap:8px; margin-bottom:8px; align-items:center; }
    #bsui-modal input { padding:8px 10px; border-radius:10px; border:1px solid rgba(255,255,255,.25);
      background: rgba(255,255,255,.12); color:#fff; outline:none; min-width:0; }
    #bsui-modal input.small { width: 100px; text-align: center; }
    #bsui-modal .iconbtn { width:38px; height:38px; border-radius:10px; border:1px solid rgba(255,255,255,.25);
      background: rgba(255,255,255,.18); color:#fff; font-weight:900; cursor:pointer; display:flex; align-items:center; justify-content:center; }
    #bsui-modal .btn { padding:10px 12px; border-radius:8px; border:1px solid rgba(255,255,255,.25);
      background: rgba(255,255,255,.18); color:#fff; font-weight:700; cursor:pointer; }

    /* Overlay collé au canvas */
    .bsui-map-overlay { position:absolute; inset:0; pointer-events:none; z-index: 1000; }
    .bsui-map-overlay canvas { position:absolute; left:0; top:0; }
    .bsui-map-overlay img { position:absolute; opacity:.35; image-rendering: pixelated; pointer-events:none; }
  `);

  // ---------------- Overlay collé + projection (world - TL)*scale ---------------
  function makeMapOverlay() {
    const mapC = mainCanvas();
    if (!mapC || !mapC.parentElement) return null;

    const parent = mapC.parentElement;
    const cs = getComputedStyle(parent);
    if (cs.position === "static") parent.style.position = "relative";

    const wrap = document.createElement('div');
    wrap.className = 'bsui-map-overlay';

    function syncWrapToCanvas() {
      wrap.style.width  = mapC.clientWidth  + "px";
      wrap.style.height = mapC.clientHeight + "px";
      wrap.style.left = mapC.offsetLeft + "px";
      wrap.style.top  = mapC.offsetTop  + "px";
      // recopier pan/zoom
      const mc = getComputedStyle(mapC);
      wrap.style.transform = mc.transform;
      wrap.style.transformOrigin = mc.transformOrigin;
    }
    syncWrapToCanvas();
    parent.appendChild(wrap);

    const dpr = window.devicePixelRatio || 1;
    const c = document.createElement('canvas');
    wrap.appendChild(c);

    function resizeBitmap() {
      c.style.width  = mapC.clientWidth  + "px";
      c.style.height = mapC.clientHeight + "px";
      c.width  = Math.max(1, Math.round(mapC.clientWidth  * dpr));
      c.height = Math.max(1, Math.round(mapC.clientHeight * dpr));
    }
    resizeBitmap();
    const ctx = c.getContext('2d');
    ctx.setTransform(dpr,0,0,dpr,0,0);

    const previewImg = document.createElement('img');
    previewImg.style.display = 'none';
    wrap.appendChild(previewImg);

    // --- Projection : calcule scale à partir du canvas (DPR) et soustrait TL ---
    function worldToLocalRect(x, y, w, h) {
      const TL = currentTL();
      // si TL inconnu, on refuse de dessiner (évite un décalage hasardeux)
      if (!TL) return null;
      const scaleX = mapC.clientWidth  / mapC.width;
      const scaleY = mapC.clientHeight / mapC.height;
      return {
        x: (x - TL.x) * scaleX,
        y: (y - TL.y) * scaleY,
        w: w * scaleX,
        h: h * scaleY
      };
    }

    function clear(){ ctx.clearRect(0,0,c.width,c.height); }
    function drawRects(rects) {
      clear();
      const TL = currentTL();
      if (!TL) return;
      ctx.lineWidth = 2; ctx.setLineDash([6,4]);
      const scaleX = mapC.clientWidth  / mapC.width;
      const scaleY = mapC.clientHeight / mapC.height;
      rects.forEach((r,i)=>{
        const hue = (i*57)%360; ctx.strokeStyle = `hsl(${hue} 90% 60% / 0.95)`;
        const R = worldToLocalRect(r.x, r.y, r.w, r.h);
        if (R) ctx.strokeRect(R.x, R.y, R.w, R.h);
      });
      // petit HUD TL pour debug
      ctx.setLineDash([]); ctx.font = "12px sans-serif"; ctx.fillStyle = "rgba(255,255,255,.9)";
      ctx.fillText(`TL=(${TL.x},${TL.y}) scale≈${(mapC.clientWidth/mapC.width).toFixed(3)}`, 8, 16);
    }
    function showTemplate(tpl) {
      if (!tpl) { previewImg.style.display='none'; return; }
      const R = worldToLocalRect(tpl.tl_x, tpl.tl_y, tpl.natural_w, tpl.natural_h);
      if (!R) return;
      previewImg.src = tpl.data_url;
      Object.assign(previewImg.style, { display:'block', left:`${R.x}px`, top:`${R.y}px`, width:`${R.w}px`, height:`${R.h}px` });
    }
    function destroy(){ wrap.remove(); }

    const sync = () => { syncWrapToCanvas(); resizeBitmap(); ctx.setTransform(dpr,0,0,dpr,0,0); };
    const ro = new ResizeObserver(sync); ro.observe(mapC); ro.observe(parent);
    const intv = setInterval(sync, 250);
    window.addEventListener('scroll', sync, {passive:true});
    window.addEventListener('resize', sync, {passive:true});

    return { drawRects, showTemplate, destroy };
  }

  // -------------------- UI -------------------------------
  function injectUI() {
    if (document.getElementById('bsui-root')) return;

    const root = document.createElement('div');
    root.id = 'bsui-root';
    root.innerHTML = `
      <div class="h"><div class="title">Menu</div></div>
      <div class="body" id="bs-body"><div class="big">Blue Scan</div></div>
      <div class="foot">
        <div class="status" id="bs-status">Backend: résolution…</div>
        <div class="btnbar">
          <button class="btn" id="bs-btn-ping">Ping</button>
          <button class="btn" id="bs-btn-upload">Upload</button>
          <button class="btn" id="bs-btn-list">Liste</button>
          <button class="btn" id="bs-btn-monitor">Start</button>
          <button class="btn" id="bs-btn-contours">Contours</button>
        </div>
      </div>
      <div id="bsui-modal" style="display:none">
        <div class="back"></div>
        <div class="panel">
          <h3>Uploader un template (TL + taille native)</h3>
          <div class="row"><input id="m-name" placeholder="Nom de l'œuvre (optionnel)" style="flex:1"></div>
          <div class="row">
            <button class="iconbtn" id="m-grab" title="Récupérer depuis Wplace">📍</button>
            <input id="m-tlx" class="small" placeholder="TL X" inputmode="numeric">
            <input id="m-tly" class="small" placeholder="TL Y" inputmode="numeric">
            <input id="m-pxx" class="small" placeholder="PX X" inputmode="numeric">
            <input id="m-pxy" class="small" placeholder="PX Y" inputmode="numeric">
            <button class="btn" id="m-pin">Pin TL</button>
          </div>
          <div class="row"><input id="m-file" type="file" accept="image/png,image/webp" style="flex:1"></div>
          <div class="row" style="justify-content:flex-end; gap:10px">
            <button class="btn" id="m-cancel">Annuler</button>
            <button class="btn" id="m-overlay">Détecter overlay</button>
            <button class="btn" id="m-create">Créer</button>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(root);

    const el = {
      body: root.querySelector("#bs-body"),
      status: root.querySelector("#bs-status"),
      btnPing: root.querySelector("#bs-btn-ping"),
      btnUpload: root.querySelector("#bs-btn-upload"),
      btnList: root.querySelector("#bs-btn-list"),
      btnMonitor: root.querySelector("#bs-btn-monitor"),
      btnContours: root.querySelector("#bs-btn-contours"),
      modal: root.querySelector("#bsui-modal"),
      mName: root.querySelector("#m-name"),
      mGrab: root.querySelector("#m-grab"),
      mTLX: root.querySelector("#m-tlx"),
      mTLY: root.querySelector("#m-tly"),
      mPXX: root.querySelector("#m-pxx"),
      mPXY: root.querySelector("#m-pxy"),
      mPin: root.querySelector("#m-pin"),
      mFile: root.querySelector("#m-file"),
      mCancel: root.querySelector("#m-cancel"),
      mOverlay: root.querySelector("#m-overlay"),
      mCreate: root.querySelector("#m-create"),
    };
    const setStatus = (m)=> (el.status.textContent = m);

    (async () => { const base = await discoverBackend(); setStatus("Backend: " + base); renderList(); })();

    async function renderList() {
      try {
        const r = await api("/artworks");
        const arts = r.ok ? await r.json() : [];
        if (!arts || !arts.length) { el.body.innerHTML = `<div style="opacity:.9">Aucune œuvre.</div>`; return; }
        el.body.classList.add("list");
        el.body.innerHTML = arts.map(a => `
          <div class="card" data-id="${a.id}">
            <h4>${escapeHtml(a.name)}</h4>
            <div class="meta">(${a.x}, ${a.y}, ${a.w}, ${a.h}) • ${a.added_at} • mode=${a.mode}</div>
            <div class="actions">
              <button class="btn go" data-x="${a.x}" data-y="${a.y}">Aller</button>
              <button class="btn snap" data-id="${a.id}">Baseline</button>
              <button class="btn ground" data-id="${a.id}">Sol</button>
              <button class="btn tplfile" data-id="${a.id}">Maj template</button>
              <select class="modepick" data-id="${a.id}">
                <option value="build" ${a.mode === "build" ? "selected" : ""}>En construction</option>
                <option value="protect" ${a.mode === "protect" ? "selected" : ""}>Protection</option>
              </select>
              <button class="btn del" data-id="${a.id}">Supprimer</button>
            </div>
          </div>`).join("");
        el.body.querySelectorAll(".go").forEach(b => b.onclick = () => {
          const x = +b.dataset.x, y = +b.dataset.y;
          const u = new URL(location.href); u.searchParams.set("x", x); u.searchParams.set("y", y);
          window.open(u.toString(), "_blank");
        });
        el.body.querySelectorAll(".snap").forEach(b => b.onclick = async () => { const id = b.dataset.id; setStatus("Baseline..."); try { const r = await api(`/artworks/${id}/snapshot`, { method:"POST" }); setStatus(r.ok ? "Baseline OK." : "Baseline KO."); } catch { setStatus("Baseline KO."); } });
        el.body.querySelectorAll(".ground").forEach(b => b.onclick = async () => { const id = b.dataset.id; setStatus("Scan sol..."); try { const r = await api(`/artworks/${id}/ground_snapshot`, { method:"POST" }); setStatus(r.ok ? "Sol OK." : "Sol KO."); } catch { setStatus("Sol KO."); } });
        el.body.querySelectorAll(".tplfile").forEach(b => b.onclick = async () => {
          const id = b.dataset.id; const inp = document.createElement("input"); inp.type="file"; inp.accept="image/png,image/webp";
          inp.onchange = async () => { const f = inp.files?.[0]; if (!f) return; try { const data_url = await dataURLFromFile(f); const r = await api(`/artworks/${id}/template`, { method:"POST", body: JSON.stringify({ data_url }) }); setStatus(r.ok ? "Template mis à jour." : "Échec template."); } catch { setStatus("Échec template."); } };
          inp.click();
        });
        el.body.querySelectorAll(".modepick").forEach(sel => sel.onchange = async () => { const id = sel.dataset.id, mode = sel.value; try { const r = await api(`/artworks/${id}/mode`, { method:"POST", body: JSON.stringify({ mode }) }); setStatus(r.ok ? `Mode=${mode}` : "Échec mode."); } catch { setStatus("Échec mode."); } });
        el.body.querySelectorAll(".del").forEach(b => b.onclick = async () => { const id = b.dataset.id; if (!confirm("Supprimer l'œuvre ?")) return; try { await api(`/artworks/${id}`, { method:"DELETE" }); renderList(); } catch { setStatus("Échec suppression."); } });
      } catch { el.body.innerHTML = `<div style="opacity:.9">Backend injoignable ?</div>`; }
    }

    // Upload modal
    const openModal  = ()=> (el.modal.style.display = 'flex');
    const closeModal = ()=> (el.modal.style.display = 'none');
    el.btnUpload.onclick = openModal; el.mCancel.onclick = closeModal;

    el.mGrab.onclick = () => {
      const v = readHudFour();
      if (!v) { alert("Clique un pixel pour afficher (TlX,TlY,PxX,PxY) puis ré-essaie."); return; }
      el.mTLX.value = v.tl_x; el.mTLY.value = v.tl_y; el.mPXX.value = v.px_x; el.mPXY.value = v.px_y;
    };
    el.mPin.onclick = () => {
      const c = mainCanvas(); if (!c) { alert("Canvas introuvable."); return; }
      setStatus("Clique le coin haut-gauche…");
      const onClick = (ev) => {
        const r = c.getBoundingClientRect();
        const x = Math.floor(((ev.clientX - r.left) * c.width) / r.width);
        const y = Math.floor(((ev.clientY - r.top) * c.height) / r.height);
        el.mTLX.value = x; el.mTLY.value = y;
        window.removeEventListener("click", onClick, true);
      };
      window.addEventListener("click", onClick, true);
    };
    el.mOverlay.onclick = async () => { try { const sniff = await sniffBlueMarbleTemplate(); if (!sniff) { alert("Overlay non détecté."); return; } el.mFile._overlayDataURL = sniff.data_url; setStatus("Overlay détecté."); } catch { setStatus("Overlay KO."); } };
    let lastTemplate = null;
    el.mCreate.onclick = async () => {
      const tlx = parseInt(el.mTLX.value, 10), tly = parseInt(el.mTLY.value, 10);
      if (!Number.isFinite(tlx) || !Number.isFinite(tly)) { alert("Renseigne TlX et TlY."); return; }
      const name = (el.mName.value || "").trim() || "Art " + Date.now();
      const f = el.mFile.files?.[0];
      try {
        let data_url = el.mFile._overlayDataURL || null;
        if (!data_url) { if (!f) { alert("Choisis une image (PNG/WEBP) ou détecte l'overlay."); return; } data_url = await dataURLFromFile(f); }
        const tmpImg = new Image(); tmpImg.src = data_url; await tmpImg.decode().catch(()=>{});
        lastTemplate = { data_url, tl_x:tlx, tl_y:tly, natural_w: tmpImg.naturalWidth||0, natural_h: tmpImg.naturalHeight||0 };
        const r = await api("/artworks/place_tl", { method: "POST", body: JSON.stringify({ name, tl_x: tlx, tl_y: tly, data_url }) });
        if (r.ok) { setStatus(`Créée: « ${name} »`); closeModal(); renderList(); } else setStatus("Échec création.");
      } catch { setStatus("Échec création."); }
    };

    // Start/Stop + Ping
    let running = false;
    el.btnMonitor.onclick = async () => { try { if (!running) { const r = await api("/monitor/start",{method:"POST"}); if (r.ok) { running=true; el.btnMonitor.textContent="Stop"; setStatus("Surveillance ..."); } else setStatus("Start KO."); } else { const r = await api("/monitor/stop",{method:"POST"}); if (r.ok) { running=false; el.btnMonitor.textContent="Start"; setStatus("Arrêté."); } else setStatus("Stop KO."); } } catch { setStatus("Action monitor KO."); } };
    el.btnPing.onclick = async () => { try { const r = await api("/healthz"); setStatus(`Ping: ${r.status}`); } catch { setStatus("Ping KO"); } };

    // Contours
    let overlay = null, contoursOn = false, timer = null;
    function ensureOverlay(){ if (!overlay) overlay = makeMapOverlay(); return overlay; }
    async function redrawContours(){
      if (!contoursOn) return;
      const o = ensureOverlay(); if (!o) return;
      try {
        const resp = await api("/artworks"); const arts = resp.ok ? await resp.json() : [];
        o.drawRects(arts || []);
        o.showTemplate(lastTemplate || null);
      } catch {}
    }
    el.btnContours.onclick = async () => {
      contoursOn = !contoursOn;
      el.btnContours.textContent = contoursOn ? "Contours ✔" : "Contours";
      if (contoursOn) { ensureOverlay(); await redrawContours(); timer = setInterval(redrawContours, 250); }
      else { if (timer) clearInterval(timer), timer=null; if (overlay) overlay.destroy(), overlay=null; }
    };
  }

  // Boot
  if (document.body) injectUI(); else document.addEventListener('DOMContentLoaded', injectUI);

})();