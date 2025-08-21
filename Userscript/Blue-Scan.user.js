// ==UserScript==
// @name         Blue Scan UI — Menu minimal + Contours (upload-first) v1.0.0
// @namespace    pinouland.blue-scan.ui
// @version      1.0.0
// @description  Menu minimal ("Menu" + "Blue Scan"), Upload TL+template, Liste, Start/Stop, et mise en surbrillance des contours pour vérifier le placement. Backend auto (IP/port), appels via GM_xmlhttpRequest.
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

  // ---------- Toast debug (confirmation d’exécution) ----------
  try {
    const t = document.createElement('div');
    t.textContent = 'Blue-Scan UI chargé';
    Object.assign(t.style, { position:'fixed', top:'10px', right:'10px', zIndex:2147483647,
      background:'rgba(0,0,0,.75)', color:'#fff', padding:'6px 10px', borderRadius:'8px',
      fontSize:'12px', fontFamily:'system-ui, sans-serif' });
    document.documentElement.appendChild(t);
    setTimeout(()=>t.remove(), 1100);
  } catch {}

  // ---------- Réinjection si SPA ----------
  new MutationObserver(() => { if (!document.getElementById('bsui-root')) injectUI(); })
    .observe(document.documentElement, { childList:true, subtree:true });
  window.addEventListener('pageshow', () => { if (!document.getElementById('bsui-root')) injectUI(); });
  document.addEventListener('readystatechange', () => { if (!document.getElementById('bsui-root')) injectUI(); });

  // ---------- Découverte backend ----------
  const LS_BACKEND = "BLUE_SCAN_BACKEND_URL";
  let CURRENT_BACKEND = null;

  const norm = (u)=> String(u||'').trim().replace(/\/$/, '');
  const uniq = (a)=> Array.from(new Set(a.filter(Boolean)));

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
    for (const base of candidates()) {
      try {
        const r = await gmXHR(base + "/healthz", { timeout: 2500 });
        if (r && r.ok) {
          CURRENT_BACKEND = base;
          localStorage.setItem(LS_BACKEND, base);
          console.log("[Blue-Scan] Backend détecté:", base);
          return base;
        }
      } catch {}
    }
    CURRENT_BACKEND = norm(localStorage.getItem(LS_BACKEND)) || "http://82.112.240.14:8000";
    console.warn("[Blue-Scan] Aucun backend joignable; tentative par défaut:", CURRENT_BACKEND);
    return CURRENT_BACKEND;
  }

  function api(path, opts={}) {
    const base = CURRENT_BACKEND || localStorage.getItem(LS_BACKEND) || "http://82.112.240.14:8000";
    return gmXHR(norm(base) + path, opts);
  }

  // ---------- Helpers ----------
  const escapeHtml = (s)=> String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
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
  function dataURLFromFile(file) {
    return new Promise((res,rej)=>{ const fr=new FileReader(); fr.onerror=rej; fr.onload=()=>res(fr.result); fr.readAsDataURL(file); });
  }

  // ---------- Styles UI + overlay ----------
  GM_addStyle(`
    #bsui-root { position: fixed; right: 16px; bottom: 16px; width: 420px; z-index: 2147483647;
      color: #fff; font-family: Inter, system-ui, Segoe UI, Roboto, Arial, sans-serif;
      background: linear-gradient(180deg,#0e5bd6,#0940a8);
      border-radius: 14px; box-shadow: 0 10px 30px rgba(0,0,0,.35); overflow: hidden; }
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
    #bsui-modal .panel { position:relative; width: min(92vw, 520px); background: #0e2f73; border:1px solid rgba(255,255,255,.25);
      color:#fff; padding:16px; border-radius: 12px; box-shadow: 0 10px 30px rgba(0,0,0,.45); }
    #bsui-modal .panel h3 { margin:0 0 12px 0; font-size:16px; }
    #bsui-modal .row { display:flex; gap:8px; margin-bottom:8px; }
    #bsui-modal input { flex:1; padding:8px 10px; border-radius:10px; border:1px solid rgba(255,255,255,.25);
      background: rgba(255,255,255,.12); color:#fff; outline:none; }
    #bsui-modal .btn { padding:10px 12px; border-radius:8px; border:1px solid rgba(255,255,255,.25);
      background: rgba(255,255,255,.18); color:#fff; font-weight:700; cursor:pointer; }
    /* Overlay contours (pointer-events:none) */
    #bsui-overlay { position: fixed; inset: 0; pointer-events: none; z-index: 2147483646; display: none; }
    #bsui-overlay canvas { position:absolute; inset:0; width:100%; height:100%; }
    #bsui-overlay img { position:absolute; opacity:.35; image-rendering: pixelated; }
  `);

  // ---------- UI ----------
  function injectUI() {
    if (document.getElementById('bsui-root')) return;

    // Overlay pour contours
    const overlay = document.createElement('div');
    overlay.id = 'bsui-overlay';
    const ovCanvas = document.createElement('canvas');
    overlay.appendChild(ovCanvas);
    document.body.appendChild(overlay);

    const root = document.createElement('div');
    root.id = 'bsui-root';
    root.innerHTML = `
      <div class="h">
        <div class="title">Menu</div>
      </div>
      <div class="body" id="bs-body">
        <div class="big">Blue Scan</div>
      </div>
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
          <div class="row" style="margin-top:4px"><div class="big" style="font-size:12px; font-weight:600; opacity:.85">Le TL est l'ancre; l'image est placée à sa taille exacte.</div></div>
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
      mTL: root.querySelector("#m-tl"),
      mPin: root.querySelector("#m-pin"),
      mFile: root.querySelector("#m-file"),
      mCancel: root.querySelector("#m-cancel"),
      mOverlay: root.querySelector("#m-overlay"),
      mCreate: root.querySelector("#m-create"),
    };
    const setStatus = (m)=> (el.status.textContent = m);

    // Découverte backend
    (async () => {
      const base = await discoverBackend();
      setStatus("Backend: " + base);
      // Affiche la liste dès que possible
      renderList();
    })();

    // ---------- LISTE ----------
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
          </div>`
        ).join("");

        // Actions
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

    // ---------- Upload modal ----------
    const openModal  = ()=> (el.modal.style.display = 'flex');
    const closeModal = ()=> (el.modal.style.display = 'none');

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

    // Permet d'utiliser l'overlay affiché (façon Blue Marble) comme template
    el.mOverlay.onclick = async () => {
      try {
        const sniff = await sniffBlueMarbleTemplate();
        if (!sniff) { alert("Overlay non détecté."); return; }
        el.mFile._overlayDataURL = sniff.data_url;
        setStatus("Overlay détecté (utilisé comme template).");
      } catch { setStatus("Overlay KO."); }
    };

    // Mémorise le dernier template pour "aperçu contours" précis (optionnel)
    let lastTemplate = null; // { data_url, tl_x, tl_y, natural_w, natural_h }
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
        // capture infos pour un overlay itemisé
        const tmpImg = new Image(); tmpImg.src = data_url; await tmpImg.decode().catch(()=>{});
        lastTemplate = { data_url, tl_x:+m[1], tl_y:+m[2], natural_w: tmpImg.naturalWidth||0, natural_h: tmpImg.naturalHeight||0 };

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
          const txt = await r.text(); console.error("Create failed:", r.status, txt);
          setStatus("Échec création.");
        }
      } catch (e) { console.error(e); setStatus("Échec création."); }
    };

    // ---------- Start / Stop ----------
    let running = false;
    el.btnMonitor.onclick = async () => {
      try {
        if (!running) {
          const r = await api("/monitor/start", { method:"POST" });
          if (r.ok) { running = true; el.btnMonitor.textContent = "Stop"; setStatus("Surveillance ..."); }
          else setStatus("Start KO.");
        } else {
          const r = await api("/monitor/stop", { method:"POST" });
          if (r.ok) { running = false; el.btnMonitor.textContent = "Start"; setStatus("Arrêté."); }
          else setStatus("Stop KO.");
        }
      } catch { setStatus("Action monitor KO."); }
    };

    // ---------- Ping ----------
    el.btnPing.onclick = async () => {
      try { const r = await api("/healthz"); const txt = await r.text(); console.log("Ping:", r.status, txt); setStatus(`Ping: ${r.status}`); }
      catch (e) { console.error("Ping error", e); setStatus("Ping KO"); }
    };

    // ---------- CONTOURS : mise en surbrillance ----------
    let contoursOn = false, contoursTimer = null, overlayImg = null;

    el.btnContours.onclick = async () => {
      contoursOn = !contoursOn;
      el.btnContours.textContent = contoursOn ? "Contours ✔" : "Contours";
      overlay.style.display = contoursOn ? 'block' : 'none';

      if (contoursOn) {
        // Prépare image d’aperçu du dernier template (si dispo)
        if (overlayImg) overlayImg.remove();
        overlayImg = null;
        if (lastTemplate && lastTemplate.data_url && lastTemplate.natural_w && lastTemplate.natural_h) {
          overlayImg = document.createElement('img');
          overlayImg.src = lastTemplate.data_url;
          overlay.appendChild(overlayImg);
        }

        // Boucle de redraw
        const redraw = async () => {
          if (!contoursOn) return;
          try {
            const canvasGame = mainCanvas();
            const r = canvasGame ? canvasGame.getBoundingClientRect() : null;
            // Size canvas overlay
            const dpr = window.devicePixelRatio || 1;
            ovCanvas.width  = Math.floor(window.innerWidth  * dpr);
            ovCanvas.height = Math.floor(window.innerHeight * dpr);
            const ctx = ovCanvas.getContext('2d');
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx.clearRect(0,0,ovCanvas.width,ovCanvas.height);

            // Récup liste œuvres
            const resp = await api("/artworks");
            const arts = resp.ok ? await resp.json() : [];

            // Dessin rectangles (contours)
            if (canvasGame && r && arts.length) {
              // mapping : world -> screen (utilise r.width/canvas.width)
              const sx = (x)=> r.left + (x * r.width  / canvasGame.width);
              const sy = (y)=> r.top  + (y * r.height / canvasGame.height);
              const sw = (w)=> (w * r.width  / canvasGame.width);
              const sh = (h)=> (h * r.height / canvasGame.height);

              ctx.lineWidth = 2;
              ctx.setLineDash([6,4]);
              arts.forEach((a, idx) => {
                // Couleur alternée simple
                const hue = (idx*57)%360;
                ctx.strokeStyle = `hsl(${hue} 90% 60% / 0.95)`;
                ctx.strokeRect(sx(a.x), sy(a.y), sw(a.w), sh(a.h));
              });

              // Optionnel : “aperçu” du dernier template au bon endroit
              if (overlayImg && lastTemplate) {
                const scrX = sx(lastTemplate.tl_x);
                const scrY = sy(lastTemplate.tl_y);
                const scrW = sw(lastTemplate.natural_w);
                const scrH = sh(lastTemplate.natural_h);
                Object.assign(overlayImg.style, {
                  left: `${scrX}px`, top: `${scrY}px`,
                  width: `${scrW}px`, height: `${scrH}px`,
                });
              }
            }
          } catch (e) { /* noop */ }
        };

        await redraw();
        contoursTimer = setInterval(redraw, 250);
        window.addEventListener('resize', redraw, { passive:true });
        document.addEventListener('scroll', redraw, { passive:true });
      } else {
        if (contoursTimer) clearInterval(contoursTimer);
        contoursTimer = null;
        if (overlayImg) overlayImg.remove();
        overlayImg = null;
      }
    };

  } // injectUI

  // Boot
  function waitBodyThen(fn){ if (document.body) return fn(); const i=setInterval(()=>{ if(document.body){clearInterval(i); fn();}},50); }
  waitBodyThen(injectUI);

})();
