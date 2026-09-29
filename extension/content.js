/* Radar Whatnot One Piece
 * Lit le texte affiché par la page Whatnot (titre du lot, chat, enchère), repère les codes de cartes
 * One Piece (OP09-062, EB02-010, ST10-006, P-001…) et affiche dans un panneau les prix Cardmarket
 * du jour et l'enchère maximale à ne pas dépasser pour chaque version de la carte.
 * Données : https://github.com/sticky97one-dot/onepiece-cardmarket (mises à jour chaque matin).
 */
(() => {
  if (window.__radarWhatnot) return;
  window.__radarWhatnot = true;

  const DATA_URL = "https://raw.githubusercontent.com/sticky97one-dot/onepiece-cardmarket/main/site/data.json";
  const MAX_AGE_MS = 4 * 3600 * 1000;
  const DEFAULTS = { target: 20, sellFee: 5, shipOut: 0.5, shipIn: 0, buyFee: 0, basis: "safe" };

  let D = null, byCode = new Map(), byGroup = new Map();
  let settings = { ...DEFAULTS };
  let current = null;          // code en cours (ex. "OP09-062")
  let pinned = false;          // code choisi à la main : on ne le remplace pas automatiquement
  let selectedId = null;       // version choisie
  let bidAuto = null, bidManual = null;
  let recent = [];             // derniers codes vus
  let lastSeen = new Set();
  let minimized = false;

  // ---------- utilitaires
  const eur = v => v == null ? "—" : (v >= 100 ? v.toFixed(0) : v.toFixed(2)).replace(".", ",") + " €";
  const pc = v => v == null ? "—" : (v > 0 ? "+" : "") + Math.round(v * 100) + " %";
  const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const norm = s => (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[.\-\s]+/g, " ").trim();
  const CODE_RE = /\b(OP|EB|ST|PRB)\s?0?(\d{1,2})\s?[-–—_ ]\s?(\d{3})\b|\bP\s?[-–—]\s?(\d{3})\b/gi;
  const MONEY_RE = /^(?:€\s?(\d{1,5}(?:[.,]\d{1,2})?)|(\d{1,5}(?:[.,]\d{1,2})?)\s?€)$/;

  function canonical(m) {
    if (m[4]) return `P-${m[4]}`;
    return `${m[1].toUpperCase()}${m[2].padStart(2, "0")}-${m[3]}`;
  }

  // ---------- données
  async function loadData(force) {
    const st = await chrome.storage.local.get(["radarData", "radarAt", "radarSettings", "radarPos", "radarMin"]);
    if (st.radarSettings) settings = { ...DEFAULTS, ...st.radarSettings };
    minimized = !!st.radarMin;
    if (st.radarPos) applyPos(st.radarPos);
    let data = st.radarData;
    if (force || !data || !st.radarAt || Date.now() - st.radarAt > MAX_AGE_MS) {
      try {
        setStatus("Mise à jour des prix…");
        const r = await fetch(DATA_URL + "?t=" + Math.floor(Date.now() / 3600000), { cache: "no-store" });
        if (!r.ok) throw new Error("HTTP " + r.status);
        data = await r.json();
        await chrome.storage.local.set({ radarData: data, radarAt: Date.now() });
      } catch (e) {
        if (!data) { setStatus("Impossible de charger les prix : " + e.message); return; }
      }
    }
    D = data;
    byCode = new Map(); byGroup = new Map();
    for (const i of D.items) {
      if (i.c) { if (!byCode.has(i.c)) byCode.set(i.c, []); byCode.get(i.c).push(i); }
      if (i.g) { if (!byGroup.has(i.g)) byGroup.set(i.g, []); byGroup.get(i.g).push(i); }
    }
    setStatus(`Prix Cardmarket du ${new Date(D.priceDate).toLocaleDateString("fr-FR")}`);
    render();
  }

  // toutes les versions d'un code (y compris rééditions / promos rattachées à la même carte)
  function versionsOf(code) {
    const base = byCode.get(code) || [];
    const ids = new Set(base.map(i => i.id));
    const out = [...base];
    for (const i of base) for (const s of (byGroup.get(i.g) || [])) if (!ids.has(s.id) && s.c === code) { ids.add(s.id); out.push(s); }
    return out.filter(i => i.k === "S").sort((a, b) => b.t - a.t);
  }

  // ---------- calcul
  function resaleOf(i) {
    if (settings.basis === "trend") return i.t;
    if (settings.basis === "a30") return i.a30 || i.t;
    return Math.min(i.t, i.a7 || i.t, i.a1 ? Math.max(i.a1, (i.a7 || i.t) * 0.85) : i.t);
  }
  function maxBid(i) {
    const net = resaleOf(i) * (1 - settings.sellFee / 100) - settings.shipOut;
    const max = (net / (1 + settings.target / 100) - settings.shipIn) / (1 + settings.buyFee / 100);
    // pour garder la carte (investissement) : on accepte de payer jusqu'au prix du marché, sans frais de revente
    const keep = (resaleOf(i) - settings.shipIn) / (1 + settings.buyFee / 100);
    return { max: Math.max(0, max), keep: Math.max(0, keep), resale: resaleOf(i) };
  }
  const momentum = i => i.d7 != null ? i.d7 : i.m;

  // ---------- lecture de la page
  function scan() {
    if (!D) return;
    const txt = document.body ? document.body.innerText : "";
    const found = [];
    const seenNow = new Set();
    let m;
    CODE_RE.lastIndex = 0;
    while ((m = CODE_RE.exec(txt))) {
      const c = canonical(m);
      if (byCode.has(c) && !seenNow.has(c)) { seenNow.add(c); found.push(c); }
    }
    // un code qui vient d'apparaître = probablement le nouveau lot
    const fresh = found.filter(c => !lastSeen.has(c));
    lastSeen = seenNow;
    for (const c of fresh.concat(found)) {
      recent = [c, ...recent.filter(x => x !== c)].slice(0, 6);
    }
    if (!pinned) {
      const next = fresh[0] || (current && seenNow.has(current) ? current : found[0]) || current;
      if (next && next !== current) { current = next; selectedId = null; bidManual = null; }
    }
    bidAuto = detectBid();
    render();
  }

  // enchère affichée : le montant en € écrit le plus gros à l'écran
  function detectBid() {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let best = null, bestSize = 0, n;
    let count = 0;
    while ((n = walker.nextNode()) && count < 20000) {
      count++;
      const t = n.nodeValue.trim();
      if (t.length > 12) continue;
      const mm = t.match(MONEY_RE);
      if (!mm) continue;
      const el = n.parentElement;
      if (!el || el.closest("#radar-whatnot-host")) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0 || r.bottom < 0 || r.top > innerHeight) continue;
      const size = parseFloat(getComputedStyle(el).fontSize) || 0;
      if (size > bestSize) { bestSize = size; best = parseFloat((mm[1] || mm[2]).replace(",", ".")); }
    }
    return best;
  }

  // ---------- panneau (Shadow DOM : aucun conflit avec le style de Whatnot)
  const host = document.createElement("div");
  host.id = "radar-whatnot-host";
  host.style.cssText = "position:fixed;z-index:2147483647;top:80px;right:16px;";
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `<style>
    :host{all:initial}
    .p{width:340px;max-height:78vh;display:flex;flex-direction:column;background:#141824;color:#e8ebf3;border:1px solid #2a3244;border-radius:12px;
       font:13px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;box-shadow:0 12px 32px rgba(0,0,0,.45);overflow:hidden}
    .h{display:flex;align-items:center;gap:8px;padding:9px 12px;background:#1c2233;cursor:move;user-select:none}
    .h b{font-size:13px;letter-spacing:.02em} .h b span{color:#8ea0ff}
    .h .s{flex:1;color:#98a0b5;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .h button{background:none;border:0;color:#c9cfdd;font-size:15px;cursor:pointer;padding:2px 4px}
    .b{padding:10px 12px;overflow:auto;display:flex;flex-direction:column;gap:10px}
    input,select{background:#0e1118;color:#e8ebf3;border:1px solid #2a3244;border-radius:7px;padding:7px 9px;font:13px system-ui,sans-serif;width:100%;box-sizing:border-box}
    .row{display:flex;gap:8px;align-items:center}
    .chips{display:flex;gap:5px;flex-wrap:wrap}
    .chip{background:#1c2233;border:1px solid #2a3244;color:#c9cfdd;border-radius:999px;padding:3px 8px;font:12px ui-monospace,Menlo,Consolas,monospace;cursor:pointer}
    .chip.on{border-color:#8ea0ff;color:#8ea0ff}
    .card h3{margin:0;font-size:15px} .card .c{color:#98a0b5;font:12px ui-monospace,Menlo,Consolas,monospace}
    .v{display:grid;grid-template-columns:1fr auto;gap:2px 8px;padding:8px;border:1px solid #2a3244;border-radius:9px;cursor:pointer}
    .v.on{border-color:#8ea0ff;background:#1a2140}
    .v .e{font-size:12px} .v .mx{text-align:right;font:700 15px ui-monospace,Menlo,Consolas,monospace}
    .v .d{grid-column:1 / -1;color:#98a0b5;font-size:11.5px;display:flex;gap:8px;flex-wrap:wrap}
    .up{color:#3fcf86} .down{color:#ff7a6b} .flat{color:#98a0b5}
    .tag{font-size:10.5px;text-transform:uppercase;letter-spacing:.04em;padding:1px 5px;border-radius:4px;background:#2e230f;color:#f0b04a}
    .tag.ok{background:#11291e;color:#3fcf86}
    .verdict{border-radius:10px;padding:10px 12px}
    .verdict .big{font:800 22px system-ui,sans-serif;line-height:1.1}
    .verdict .l{font:12.5px ui-monospace,Menlo,Consolas,monospace;margin-top:4px}
    .good{background:#11291e;color:#3fcf86} .mid{background:#2e230f;color:#f0b04a} .bad{background:#331714;color:#ff7a6b} .none{background:#1c2233;color:#c9cfdd}
    .muted{color:#98a0b5;font-size:11.5px}
    .set{display:grid;grid-template-columns:1fr 1fr;gap:6px} .set label{font-size:11px;color:#98a0b5;display:flex;flex-direction:column;gap:3px}
    details summary{cursor:pointer;color:#98a0b5;font-size:12px}
    a{color:#8ea0ff}
  </style>
  <div class="p">
    <div class="h" id="drag"><b>Radar <span>Whatnot</span></b><span class="s" id="status">Chargement…</span>
      <button id="refresh" title="Recharger les prix">↻</button><button id="min" title="Réduire">–</button></div>
    <div class="b" id="body">
      <input id="q" placeholder="Chercher : robin 062, OP09-062, teach…" autocomplete="off">
      <div class="chips" id="recent"></div>
      <div id="card"></div>
      <div class="row"><span class="muted" style="white-space:nowrap">Enchère actuelle</span><input id="bid" type="number" inputmode="decimal" step="1" min="0" placeholder="auto"></div>
      <div id="verdict"></div>
      <details id="settings"><summary>Réglages (marge, frais)</summary>
        <div class="set" style="margin-top:8px">
          <label>Marge visée %<input id="s-target" type="number" step="1"></label>
          <label>Commission revente %<input id="s-sellFee" type="number" step="0.5"></label>
          <label>Envoi à ta charge €<input id="s-shipOut" type="number" step="0.1"></label>
          <label>Port Whatnot par carte €<input id="s-shipIn" type="number" step="0.5"></label>
          <label>Frais acheteur Whatnot %<input id="s-buyFee" type="number" step="0.5"></label>
          <label>Base de prix<select id="s-basis"><option value="safe">Prudente</option><option value="trend">Tendance</option><option value="a30">Moy. 30 j</option></select></label>
        </div>
      </details>
      <div class="muted">Le panneau lit les codes écrits à l'écran (titre du lot, chat). Si le vendeur ne l'écrit pas, tape le nom ou le code en haut.</div>
    </div>
  </div>`;
  document.documentElement.appendChild(host);
  const $ = s => root.querySelector(s);

  function setStatus(t) { const el = $("#status"); if (el) el.textContent = t; }
  function applyPos(p) { if (p && p.top != null) { host.style.top = p.top + "px"; host.style.left = p.left + "px"; host.style.right = "auto"; } }

  // déplacer le panneau
  (() => {
    let sx, sy, ox, oy, drag = false;
    $("#drag").addEventListener("mousedown", e => {
      if (e.target.tagName === "BUTTON") return;
      drag = true; const r = host.getBoundingClientRect(); sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top; e.preventDefault();
    });
    addEventListener("mousemove", e => { if (!drag) return; applyPos({ left: Math.max(0, ox + e.clientX - sx), top: Math.max(0, oy + e.clientY - sy) }); });
    addEventListener("mouseup", () => { if (!drag) return; drag = false; const r = host.getBoundingClientRect(); chrome.storage.local.set({ radarPos: { left: r.left, top: r.top } }); });
  })();

  $("#min").addEventListener("click", () => { minimized = !minimized; chrome.storage.local.set({ radarMin: minimized }); render(); });
  $("#refresh").addEventListener("click", () => loadData(true));

  // recherche manuelle
  $("#q").addEventListener("keydown", e => {
    if (e.key !== "Enter" || !D) return;
    const v = $("#q").value.trim();
    CODE_RE.lastIndex = 0;
    const m = CODE_RE.exec(v);
    let code = m ? canonical(m) : null;
    if (!code || !byCode.has(code)) {
      const words = norm(v).split(" ").filter(Boolean);
      const hit = D.items.filter(i => i.k === "S" && i.c && words.every(w => norm(`${i.n} ${i.c} ${i.c.replace("-", "")}`).includes(w)))
        .sort((a, b) => b.t - a.t)[0];
      code = hit ? hit.c : null;
    }
    if (code) { current = code; pinned = true; selectedId = null; bidManual = null; recent = [code, ...recent.filter(x => x !== code)].slice(0, 6); render(); }
    else setStatus("Aucune carte trouvée pour « " + v + " »");
  });
  $("#recent").addEventListener("click", e => {
    const b = e.target.closest("[data-c]"); if (!b) return;
    if (b.dataset.c === "__auto") { pinned = false; scan(); return; }
    current = b.dataset.c; pinned = true; selectedId = null; bidManual = null; render();
  });
  $("#card").addEventListener("click", e => { const v = e.target.closest("[data-id]"); if (!v) return; selectedId = +v.dataset.id; render(); });
  $("#bid").addEventListener("input", () => { const x = parseFloat($("#bid").value); bidManual = isFinite(x) ? x : null; renderVerdict(); });

  // réglages
  for (const k of Object.keys(DEFAULTS)) {
    const el = $("#s-" + k);
    el.addEventListener("input", () => {
      settings[k] = k === "basis" ? el.value : (parseFloat(el.value) || 0);
      chrome.storage.local.set({ radarSettings: settings }); render();
    });
  }

  // ---------- affichage
  function tags(i) {
    const t = [];
    const mo = momentum(i);
    if ((i.cat || []).includes("rattrapage")) t.push('<span class="tag ok">En retard</span>');
    if ((i.cat || []).includes("decollage")) t.push('<span class="tag ok">Décolle</span>');
    if ((i.cat || []).includes("affaire")) t.push('<span class="tag ok">Offre sous le marché</span>');
    if (mo != null && mo > 0.6) t.push('<span class="tag">Déjà partie</span>');
    if ((i.f || []).includes("rare")) t.push('<span class="tag">Peu d\'échanges</span>');
    if ((i.f || []).includes("pic") || (i.f || []).includes("fantome")) t.push('<span class="tag">Prix douteux</span>');
    return t.join(" ");
  }

  function render() {
    $("#body").style.display = minimized ? "none" : "flex";
    $("#min").textContent = minimized ? "+" : "–";
    for (const k of Object.keys(DEFAULTS)) { const el = $("#s-" + k); if (root.activeElement !== el) el.value = settings[k]; }
    $("#recent").innerHTML = recent.map(c => `<span class="chip ${c === current ? "on" : ""}" data-c="${c}">${c}</span>`).join("")
      + (pinned ? '<span class="chip" data-c="__auto">↺ auto</span>' : "");
    if (root.activeElement !== $("#bid")) $("#bid").value = bidManual != null ? bidManual : "";
    $("#bid").placeholder = bidAuto != null ? `auto : ${bidAuto} €` : "tape l'enchère";
    if (!D || !current) {
      $("#card").innerHTML = `<div class="muted">${D ? "En attente d'un code de carte à l'écran (ex. OP09-062)…" : ""}</div>`;
      renderVerdict(); return;
    }
    const vs = versionsOf(current);
    if (!vs.length) { $("#card").innerHTML = `<div class="muted">${esc(current)} : pas de prix Cardmarket.</div>`; renderVerdict(); return; }
    if (!vs.find(v => v.id === selectedId)) selectedId = null;
    const shown = vs.filter(v => v.t >= 1 || v.id === selectedId).slice(0, 12);
    $("#card").innerHTML = `<div class="card"><h3>${esc(vs[0].n)}</h3><div class="c">${esc(current)} · ${vs.length} version${vs.length > 1 ? "s" : ""} · touche la version en vente<br>max revente · max pour garder</div></div>`
      + shown.map(v => {
        const mb = maxBid(v), mo = momentum(v);
        const cls = mo == null ? "flat" : mo > 0.02 ? "up" : mo < -0.02 ? "down" : "flat";
        return `<div class="v ${v.id === selectedId ? "on" : ""}" data-id="${v.id}">
          <div class="e">${esc(v.e)}${v.v ? " · V" + v.v : ""}</div><div class="mx" title="revente / garder">${eur(mb.max)} · ${eur(mb.keep)}</div>
          <div class="d"><span>marché ${eur(v.t)}</span><span>ventes 7 j ${eur(v.a7)}</span><span class="${cls}">${pc(mo)}</span>${tags(v)}</div></div>`;
      }).join("");
    renderVerdict();
  }

  function renderVerdict() {
    const el = $("#verdict");
    const bid = bidManual != null ? bidManual : bidAuto;
    const v = D && selectedId ? D.items.find(i => i.id === selectedId) : null;
    if (!v) { el.innerHTML = current ? '<div class="verdict none"><div class="big">Quelle version ?</div><div class="l">Touche la version annoncée (alt, normale, JP…)</div></div>' : ""; return; }
    const mb = maxBid(v);
    let c, t;
    if (bid == null) { c = "none"; t = `Revente : ≤ ${eur(mb.max)}`; }
    else if (bid <= mb.max * 0.8) { c = "good"; t = "Très bonne affaire"; }
    else if (bid <= mb.max) { c = "good"; t = "Bonne affaire"; }
    else if (bid <= mb.keep) { c = "mid"; t = "OK pour garder, pas pour revendre"; }
    else { c = "bad"; t = "Trop cher, stop"; }
    const risky = (v.f || []).some(f => ["pic", "fantome", "rare"].includes(f));
    el.innerHTML = `<div class="verdict ${c}"><div class="big">${t}</div>
      <div class="l">Pour revendre (${settings.target} % de marge) : <b>≤ ${eur(mb.max)}</b></div>
      <div class="l">Pour garder / investir : <b>≤ ${eur(mb.keep)}</b></div>
      <div class="l">Valeur Cardmarket retenue : ${eur(mb.resale)}</div>
      ${bid != null ? `<div class="l">Enchère actuelle : ${eur(bid)}</div>` : ""}
      ${risky ? '<div class="l">⚠ Prix Cardmarket peu fiable pour cette version : prudence.</div>' : ""}</div>`;
  }

  loadData(false).then(() => { scan(); setInterval(scan, 1500); });
})();
