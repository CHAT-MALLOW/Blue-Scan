// ==UserScript==
// @name         Blue Scan UI — Upload-first (mobile safe) — v0.9.0
// @namespace    pinouland.blue-scan.ui
// @version      0.9.0
// @description  UI Blue-Scan pour Wplace. Menu inchangé, bouton Config remplacé par Upload: choisit une image et l'ancre TL (système Wplace). Connexion backend auto (découverte IP/port), via GM_xmlhttpRequest (OK sans HTTPS).
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

  // ---- Toast de présence (debug rapide) ----
  try {
    const t = document.createElement('div');
    t.textContent = 'Blue-Scan UI (Upload) chargé';
    Object.assign(t.style, {
      position:'fixed', top:'10px', right:'10px', zIndex:2147483647,
      background:'rgba(0,0,0,.75)', color:'#fff', padding:'6px 10px',
      borderRadius:'8px', fontSize:'12px', fontFamily:'system-ui, sans-serif'
    });
    document.documentElement.appendChild(t);
    setTimeout(()=>t.remove(), 1100);
  } catch {}

  // ---- Re-injection si le DOM bouge (SPA) ----
  new MutationObserver(() => { if (!document.getElementById('bsui-root')) injectUI(); })
    .observe(document.documentElement, { childList:true, subtree:true });
  window.addEventListener('pageshow', () => { if (!document.getElementById('bsui-root')) injectUI(); });
  document.addEventListener('readystatechange', () => { if (!document.getElementById('bsui-root')) injectUI(); });

  // ---- Découverte backend (auto) ----
  const LS_BACKEND = "BLUE_SCAN_BACKEND_URL";
  let CURRENT_BACKEND = null; // sera résolu par discoverBackend()

  function norm(u){ return String(u||'').trim().replace(/\/$/, ''); }
  function uniq(a){ return Array.from(new Set(a.filter(Boolean))); }

  function candidates() {
    return uniq([
      norm(localStorage.getItem(LS_BACKEND)),
      norm(window.BS_BACKEND_URL || ''),
      "http://82.112.240.14:8000",
      "http://82.112.240.14",
      "http://localhost:8000",
      "http://127.0.0.1:8000",
    ]);
  }

  function gmXHR(url, opts={}) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: opts.method || "GET",
        url,
        headers: Object.assign({ "Content-Type": "application/json" }, opts.headers || {}),
        data: opts.body || null,
        timeout: opts.timeout || 4000,
        onload: (r) => resolve({
          ok: r.status >= 200 && r.status < 300,
          status: r.status, statusText: r.statusText,
          text: () => Promise.resolve(r.responseText||""),
          json: () => Promise.resolve().then(() => JSON.parse(r.responseText||"{}")).catch(() => ({})),
        }),
        onerror: reject,
        ontimeout: () => reject(new Error("timeout")),
      });
    });
  }

  async function discoverBackend() {
    const list = candidates();
    for (const base of list) {
      try {
        const r = await gmXHR(base + "/healthz", { timeout: 2500 });
        if (r && r.ok) {
          CURRENT_BACKEND = base;
          localStorage.setItem(LS_BACKEND, base);
          console.log("[Blue-Scan] Backend détecté:", base);
          return base;
        }
      } catch (e) { /* continue */ }
    }
    // Rien trouvé : garde dernier connu ou défaut IP:8000
    CURRENT_BACKEND = norm(localStorage.getItem(LS_BACKEND)) || "http://82.112.240.14:8000";
    console.warn("[Blue-Scan] Aucun backend joignable; tentative par défaut:", CURRENT_BACKEND);
    return CURRENT_BACKEND;
  }

  // ---- API (utilise CURRENT_BACKEND) ----
  function api(path, opts={}) {
    const base = CURRENT_BACKEND || localStorage.getItem(LS_BACKEND) || "http://82.112.240.14:8000";
    return gmXHR(norm(base) + path, opts);
  }

  // ---- Helpers DOM & Canvas ----
  function escapeHtml(s) { return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }
  function mainCanvas() {
    const cs = Array.from(document.querySelectorAll("canvas"));
    if (!cs.length) return null;
    return cs.reduce((a,b)=> (a.width*a.height > b.width*b.height ? a : b));
  }
  async function blobUrlToDataURL(url) {
    const r = await fetch(url); const b = await r.blob();
    return await new Promise((res)=>{ const fr=new FileReader(); fr.onload=()=>res(fr.result); fr.readAsDataURL(b); });
  }
  async function sniffBlueMarbleTemplate() {
    const canvas = mainCanvas();
    if (!canvas) return null;
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
  function dataURLFromFile(file) {
    return new Promise((res,rej)=>{ const fr=new FileReader(); fr.onerror=rej; fr.onload=()=>res(fr.result); fr.readAsDataURL(file); });
  }

  // ---- UI ----
  function injectUI() {
    if (document.getElementById('bsui-root')) return;

    GM_addStyle(`
      #bsui-root { position: fixed; right: 16px; bottom: 16px; width: 420px; z-index: 2147483647;
        color: #fff; font-family: Inter, system-ui, Segoe UI, Roboto, Arial, sans-serif;
        background: linear-gradient(180deg,#0e5bd6,#0940a8);
        border-radius: 14px; box-shadow: 0 10px 30px rgba(0,0,0,.35); overflow: hidden; }
      #bsui-root .h { display:flex; align-items:center; gap:8px; padding:12px 14px; background: rgba(255,255,255,.08); }
      #bsui-root .dot { width:10px; height:10px; border-radius:50%; background:#8b97a8; }
      #bsui-root .title { font-weight: 800; }
      #bsui-root .body { padding:12px 14px; max-height: 60vh; overflow:auto; }
      #bsui-root .row { display:flex; gap:8px; margin-bottom:8px; }
      #bsui-root input, #bsui-root select { flex:1; padding:8px 10px; border-radius:10px;
        border:1px solid rgba(255,255,255,.25); background: rgba(255,255,255,.12); color:#fff; outline:none; }
      #bsui-root .btn { padding:10px 12px; border-radius:10px; border:1px solid rgba(255,255,255,.25);
        background: rgba(255,255,255,.15); color:#fff; font-weight:700; cursor:pointer; }
      #bsui-root .btn:hover { background: rgba(255,255,255,.22); }
      #bsui-root .pill { font-size:12px; border:1px solid rgba(255,255,255,.3); padding:6px 10px; border-radius:999px; }
      #bsui-root .card { background: rgba(0,0,0,.15); border:1px solid rgba(255,255,255,.18); border-radius:12px; padding:10px; margin-bottom:8px; }
      #bsui-root .card h4 { margin:0 0 6px 0; font-size:14px; }
      #bsui-root .meta { font-size:12px; opacity:.9; }
      #bsui-root .actions { display:flex; gap:8px; margin-top:8px; flex-wrap:wrap; }
      #bsui-root .foot { display:flex; align-items:center; justify-content:space-between; background: rgba(255,255,255,.08); padding:10px 14px; }
      #bsui-root .status { font-size:12px; opacity:.9; }
      #bsui-root .sep { height:1px; background: rgba(255,255,255,.2); margin:10px 0; }
      #bsui-root .muted { opacity:.8; font-size:12px; }
      #bsui-modal { position: fixed; inset: 0; z-index: 2147483647; display:none; align-items:center; justify-content:center; }
      #bsui-modal .back { position:absolute; inset:0; background: rgba(0,0,0,.45); }
      #bsui-modal .panel { position:relative; width: min(92vw, 520px); background: #0e2f73; border:1px solid rgba(255,255,255,.25);
        color:#fff; padding:16px; border-radius: 12px; box-shadow: 0 10px 30px rgba(0,0,0,.45); }
      #bsui-modal .panel h3 { margin:0 0 12px 0; font-size:16px; }
      #bsui-modal .row { display:flex; gap:8px; margin-bottom:8px; }
      #bsui-modal .btn { padding:10px 12px; border-radius:8px; border:1px solid rgba(255,255,255,.25);
        background: rgba(255,255,255,.18); color:#fff; font-weight:700; cursor:pointer; }
    `);

    const root = document.createElement('div');
    root.id = 'bsui-root';
    root.innerHTML = `
      <div class="h">
        <div class="dot" id="bs-dot"></div>
        <div class="title">Blue Scan</div>
        <div style="flex:1"></div>
        <span class="pill" id="bs-mode">Liste</span>
      </div>
      <div class="body" id="bs-body"></div>
      <div class="foot">
        <div class="status" id="bs-status">Backend: résolution…</div>
        <div style="display:flex; gap:8px">
          <button class="btn" id="bs-btn-ping">Ping</button>
          <button class="btn" id="bs-btn-upload">Upload</button>
          <button class="btn" id="bs-btn-list">Liste</button>
          <button class="btn" id="bs-btn-monitor">Start</button>
        </div>
      </div>
      <div id="bsui-modal">
        <div class="back"></div>
        <div class="panel">
          <h3>Uploader un template (TL + taille native)</h3>
          <div class="row"><input id="m-name" placeholder="Nom de l'œuvre (optionnel)"></div>
          <div class="row">
            <input id="m-tl" placeholder="TL x,y (ou clique 📍)">
            <button class="btn" id="m-pin">📍 Pin TL</button>
          </div>
          <div class="row"><input id="m-file" type="file" accept="image/png,image/webp"></div>
          <div class="row" style="justify-content:flex-end; gap:10px">
            <button class="btn" id="m-cancel">Annuler</button>
            <button class="btn" id="m-overlay">Détecter overlay</button>
            <button class="btn" id="m-create">Créer</button>
          </div>
          <div class="muted">Astuce: le TL est l'ancre; l'image est placée à sa taille exacte (style Blue Marble).</div>
        </div>
      </div>
    `;
    document.body.appendChild(root);

    const el = {
      body: root.querySelector("#bs-body"),
      status: root.querySelector("#bs-status"),
      dot: root.querySelector("#bs-dot"),
      mode: root.querySelector("#bs-mode"),
      btnPing: root.querySelector("#bs-btn-ping"),
      btnUpload: root.querySelector("#bs-btn-upload"),
      btnList: root.querySelector("#bs-btn-list"),
      btnMonitor: root.querySelector("#bs-btn-monitor"),
      modal: root.querySelector("#bsui-modal"),
      mName: root.querySelector("#m-name"),
      mTL: root.querySelector("#m-tl"),
      mPin: root.querySelector("#m-pin"),
      mFile: root.querySelector("#m-file"),
      mCancel: root.querySelector("#m-cancel"),
      mOverlay: root.querySelector("#m-overlay"),
      mCreate: root.querySelector("#m-create"),
    };
    const setStatus = (m) => (el.status.textContent = m);
    const setDot = (c) => (el.dot.style.background = c);

    // ---- Découverte backend immédiate ----
    (async () => {
      const base = await discoverBackend();
      setStatus("Backend: " + base);
      renderList(); // charge la liste d'entrée de jeu
    })();

    // ---- Liste ----
    async function renderList() {
      el.mode.textContent = "Liste";
      try {
        const r = await api("/artworks");
        const arts = r.ok ? await r.json() : [];
        if (!arts || !arts.length) { el.body.innerHTML = `<div style="opacity:.9">Aucune œuvre.</div>`; return; }
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
          </div>`
        ).join("");

        el.body.querySelectorAll(".go").forEach(b => {
          b.onclick = () => {
            const x = +b.dataset.x, y = +b.dataset.y;
            const u = new URL(location.href);
            u.searchParams.set("x", x); u.searchParams.set("y", y);
            try { navigator.clipboard?.writeText(`(${x},${y})`).catch(()=>{}); } catch {}
            window.open(u.toString(), "_blank");
          };
        });
        el.body.querySelectorAll(".snap").forEach(b => {
          b.onclick = async () => {
            const id = b.dataset.id; setStatus("Baseline...");
            try { const r = await api(`/artworks/${id}/snapshot`, { method:"POST" }); setStatus(r.ok ? "Baseline OK." : "Baseline KO."); }
            catch { setStatus("Baseline KO."); }
          };
        });
        el.body.querySelectorAll(".ground").forEach(b => {
          b.onclick = async () => {
            const id = b.dataset.id; setStatus("Scan sol...");
            try { const r = await api(`/artworks/${id}/ground_snapshot`, { method:"POST" }); setStatus(r.ok ? "Sol OK." : "Sol KO."); }
            catch { setStatus("Sol KO."); }
          };
        });
        el.body.querySelectorAll(".tplfile").forEach(b => {
          b.onclick = async () => {
            const id = b.dataset.id;
            const inp = document.createElement("input"); inp.type="file"; inp.accept="image/png,image/webp";
            inp.onchange = async () => {
              const f = inp.files?.[0]; if (!f) return;
              try {
                const data_url = await dataURLFromFile(f);
                const r = await api(`/artworks/${id}/template`, { method:"POST", body: JSON.stringify({ data_url }) });
                setStatus(r.ok ? "Template mis à jour." : "Échec template.");
              } catch { setStatus("Échec template."); }
            };
            inp.click();
          };
        });
        el.body.querySelectorAll(".modepick").forEach(sel => {
          sel.onchange = async () => {
            const id = sel.dataset.id, mode = sel.value;
            try { const r = await api(`/artworks/${id}/mode`, { method:"POST", body: JSON.stringify({ mode }) }); setStatus(r.ok ? `Mode=${mode}` : "Échec mode."); }
            catch { setStatus("Échec mode."); }
          };
        });
        el.body.querySelectorAll(".del").forEach(b => {
          b.onclick = async () => {
            const id = b.dataset.id;
            if (!confirm("Supprimer l'œuvre ?")) return;
            try { await api(`/artworks/${id}`, { method:"DELETE" }); renderList(); }
            catch { setStatus("Échec suppression."); }
          };
        });

      } catch (e) {
        el.body.innerHTML = `<div style="opacity:.9">Backend injoignable ?</div>`;
        console.error('Blue-Scan renderList error:', e);
      }
    }

    // ---- Upload modal ----
    function openModal(){ el.modal.style.display = 'flex'; }
    function closeModal(){ el.modal.style.display = 'none'; }

    el.btnUpload.onclick = openModal;
    el.mCancel.onclick = closeModal;

    el.mPin.onclick = () => {
      const canvas = mainCanvas();
      if (!canvas) { alert("Canvas introuvable."); return; }
      setStatus("Clique le coin haut-gauche sur la carte…");
      const onClick = (ev) => {
        const r = canvas.getBoundingClientRect();
        const x = Math.floor(((ev.clientX - r.left) * canvas.width) / r.width);
        const y = Math.floor(((ev.clientY - r.top) * canvas.height) / r.height);
        el.mTL.value = `${x},${y}`;
        setStatus(`TL = (${x},${y})`);
        window.removeEventListener("click", onClick, true);
      };
      window.addEventListener("click", onClick, true);
    };

    el.mOverlay.onclick = async () => {
      try {
        const sniff = await sniffBlueMarbleTemplate();
        if (!sniff) { alert("Overlay non détecté."); return; }
        el.mFile._overlayDataURL = sniff.data_url;
        setStatus("Overlay détecté (utilisé comme template).");
      } catch {
        setStatus("Overlay KO.");
      }
    };

    el.mCreate.onclick = async () => {
      const m = (el.mTL.value || "").match(/^\s*(-?\d+)\s*,\s*(-?\d+)\s*$/);
      if (!m) { alert("Indique TL x,y"); return; }
      const name = el.mName.value.trim() || "Art " + Date.now();
      const f = el.mFile.files?.[0];
      try {
        let data_url = el.mFile._overlayDataURL || null;
        if (!data_url) {
          if (!f) { alert("Choisis une image (PNG/WEBP) ou détecte l'overlay."); return; }
          data_url = await dataURLFromFile(f);
        }
        setStatus("Création…");
        const r = await api("/artworks/place_tl", {
          method: "POST",
          body: JSON.stringify({ name, tl_x: +m[1], tl_y: +m[2], data_url }),
        });
        if (r.ok) {
          setStatus(`Créée: « ${name} » (TL + taille native).`);
          closeModal();
          renderList();
        } else {
          const txt = await r.text();
          console.error("Create failed:", r.status, txt);
          setStatus("Échec création.");
        }
      } catch (e) {
        console.error(e);
        setStatus("Échec création.");
      }
    };

    // ---- Contrôles bas de panneau ----
    el.btnList.onclick = renderList;

    let running = false;
    el.btnMonitor.onclick = async () => {
      try {
        if (!running) {
          const r = await api("/monitor/start", { method:"POST" });
          if (r.ok) { running = true; el.btnMonitor.textContent = "Stop"; setDot("#1dd75f"); setStatus("Surveillance ..."); }
          else setStatus("Start KO.");
        } else {
          const r = await api("/monitor/stop", { method:"POST" });
          if (r.ok) { running = false; el.btnMonitor.textContent = "Start"; setDot("#8b97a8"); setStatus("Arrêté."); }
          else setStatus("Stop KO.");
        }
      } catch { setStatus("Action monitor KO."); }
    };

    el.btnPing.onclick = async () => {
      try { const r = await api("/healthz"); const txt = await r.text(); console.log("Ping:", r.status, txt); setStatus(`Ping: ${r.status}`); }
      catch (e) { console.error("Ping error", e); setStatus("Ping KO"); }
    };
  }

  // ---- Boot ----
  function waitBodyThen(fn){
    if (document.body) return fn();
    const i = setInterval(()=>{ if(document.body){ clearInterval(i); fn(); } }, 50);
  }
  waitBodyThen(injectUI);

})();