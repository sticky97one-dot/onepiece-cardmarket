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
  const DEFAULTS = { target: 20, sellFee: 5, shipOut: 0.5, shipIn: 0, buyFee: 0, basis: "safe", apiKey: "", model: "claude-sonnet-5-5", autoVision: false, frDiscount: 15, cmShip: 1.5 };

  let D = null, byCode = new Map(), byGroup = new Map();
  let settings = { ...DEFAULTS };
  let current = null;          // code en cours (ex. "OP09-062")
  let pinned = false;          // code choisi à la main : on ne le remplace pas automatiquement
  let selectedId = null;       // version choisie
  let bidAuto = null, bidManual = null;
  let recent = [];             // derniers codes vus
  let lastSeen = new Set();
  let minimized = false;
  let nameIdx = new Map(), aliasIdx = new Map();   // nom normalisé -> codes ; surnom -> noms
  let candidates = [];         // codes possibles trouvés par le nom
  let hints = [];              // mots-clés vus (alt, JP, leader…)
  let source = "";             // d'où vient la carte affichée : code, nom, image, recherche
  let visionPref = null;       // {lang, alt} renvoyé par la reconnaissance d'image
  let lang = null, langSrc = "", langManual = false;   // langue de la carte en vente : EN, FR, JP
  let lastHash = null, lastVisionAt = 0, visionBusy = false;
  const STOP = new Set(["don", "event", "stage", "the", "and", "leader", "card", "pack", "deck"]);

  // ---------- utilitaires
  const eur = v => v == null ? "—" : (v >= 100 ? v.toFixed(0) : v.toFixed(2)).replace(".", ",") + " €";
  const pc = v => v == null ? "—" : (v > 0 ? "+" : "") + Math.round(v * 100) + " %";
  const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const norm = s => (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[.\-\s]+/g, " ").trim();
  const CODE_RE = /\b(OP|EB|ST|PRB)\s?[-–]?\s?0?(\d{1,2})\s?[-–—_ ]\s?(\d{3})\b|\bP\s?[-–—]\s?(\d{3})\b/gi;
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
    nameIdx = new Map(); aliasIdx = new Map();
    for (const i of D.items) {
      if (i.k !== "S" || !i.c) continue;
      const nn = norm(i.n);
      if (nn.length < 4) continue;
      if (!nameIdx.has(nn)) nameIdx.set(nn, new Set());
      nameIdx.get(nn).add(i.c);
      const toks = nn.split(" ");
      const last = toks[toks.length - 1];
      if (toks.length > 1 && last.length >= 4 && !STOP.has(last)) {
        if (!aliasIdx.has(last)) aliasIdx.set(last, new Set());
        aliasIdx.get(last).add(nn);
      }
    }
    setStatus(`Prix Cardmarket du ${new Date(D.priceDate).toLocaleDateString("fr-FR")}`);
    render();
  }

  // texte « titre » : ce qui est écrit en assez gros à l'écran (titre du lot, bandeau), hors chat
  function titleText() {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const parts = []; let n, count = 0;
    while ((n = walker.nextNode()) && count < 20000) {
      count++;
      const t = n.nodeValue.trim();
      if (t.length < 3 || t.length > 160) continue;
      const el = n.parentElement;
      if (!el || el.closest("#radar-whatnot-host")) continue;
      const fs = parseFloat(getComputedStyle(el).fontSize) || 0;
      if (fs < 15) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.bottom < 0 || r.top > innerHeight) continue;
      parts.push(t);
    }
    return parts.join(" | ");
  }

  // cartes possibles à partir d'un nom (et d'un numéro d'extension éventuel : OP09, EB02…)
  function codesFromName(text) {
    const t = " " + norm(text) + " ";
    const names = new Set();
    for (const nn of nameIdx.keys()) if (t.includes(" " + nn + " ")) names.add(nn);
    // enlève les noms contenus dans un nom plus long trouvé (ex. « luffy » dans « monkey d luffy »)
    for (const a of [...names]) for (const b of names) if (a !== b && b.includes(a)) names.delete(a);
    if (!names.size) for (const [al, set] of aliasIdx) if (t.includes(" " + al + " ")) set.forEach(x => names.add(x));
    const setTok = [...text.matchAll(/\b(OP|EB|ST|PRB)\s?0?(\d{1,2})\b/gi)].map(m => m[1].toUpperCase() + m[2].padStart(2, "0"));
    let codes = [];
    for (const nn of names) nameIdx.get(nn).forEach(c => codes.push(c));
    if (setTok.length) { const f = codes.filter(c => setTok.some(s => c.startsWith(s + "-"))); if (f.length) codes = f; }
    const top = c => Math.max(...(byCode.get(c) || []).map(i => i.t));
    return [...new Set(codes)].sort((a, b) => top(b) - top(a)).slice(0, 8);
  }

  function keywordHints(text) {
    const t = " " + norm(text) + " ", h = [];
    if (/ (alt|aa|alternate|parallel|parallele) /.test(t)) h.push("alt");
    if (/ (manga) /.test(t)) h.push("manga");
    if (/ (sp|special) /.test(t)) h.push("SP");
    if (/ (sec|secret) /.test(t)) h.push("SEC");
    if (/ (leader) /.test(t)) h.push("leader");
    if (/ (jp|jap|japonais|japonaise|japanese|japan) /.test(t)) h.push("JP");
    if (/ (fr|vf|francais|francaise|french) /.test(t)) h.push("FR");
    if (/ (en|eng|anglais|anglaise|english|va) /.test(t)) h.push("EN");
    return h;
  }

  // toutes les versions d'un code (y compris rééditions / promos rattachées à la même carte)
  function versionsOf(code) {
    const base = byCode.get(code) || [];
    const ids = new Set(base.map(i => i.id));
    const out = [...base];
    for (const i of base) for (const s of (byGroup.get(i.g) || [])) if (!ids.has(s.id) && s.c === code) { ids.add(s.id); out.push(s); }
    return out.filter(i => i.k === "S").sort((a, b) => b.t - a.t);
  }

  // ---------- langue
  const isAsia = i => /Asie|JP/.test(i.e);
  // Cardmarket : les cartes JP ont leurs propres produits ; FR et EN partagent le même produit (prix mélangés).
  function langFactor(i) {
    if (lang === "FR" && !isAsia(i)) return 1 - settings.frDiscount / 100;
    return 1;
  }
  function setLang(l, src) {
    if (!l || langManual) return;
    if (l !== lang) { lang = l; langSrc = src; }
  }

  // ---------- calcul
  function resaleOf(i) {
    let base;
    if (settings.basis === "trend") base = i.t;
    else if (settings.basis === "a30") base = i.a30 || i.t;
    else base = Math.min(i.t, i.a7 || i.t, i.a1 ? Math.max(i.a1, (i.a7 || i.t) * 0.85) : i.t);
    // la valeur ne dépasse jamais l'offre la moins chère sur Cardmarket (ignorée si < 50 % : carte abîmée probable)
    if (i.lo && i.lo >= 0.5 * base) base = Math.min(base, i.lo);
    return base * langFactor(i);
  }
  function maxBid(i) {
    const net = resaleOf(i) * (1 - settings.sellFee / 100) - settings.shipOut;
    const max = (net / (1 + settings.target / 100) - settings.shipIn) / (1 + settings.buyFee / 100);
    // pour garder la carte (investissement) : on accepte de payer jusqu'au prix du marché, sans frais de revente
    let keep = (resaleOf(i) - settings.shipIn) / (1 + settings.buyFee / 100);
    // jamais plus cher que l'acheter directement sur Cardmarket (offre la moins chère + port)
    const b0 = Math.min(i.t, i.a7 || i.t);
    if (i.lo && i.lo >= 0.5 * b0) keep = Math.min(keep, i.lo * langFactor(i) + settings.cmShip);
    // radar défavorable (déjà partie, en chute, prix peu fiable) : on ne paie pas plus que le prix « revente »
    if (verdictRadar(i).level === "bad") keep = max;
    return { max: Math.max(0, max), keep: Math.max(0, keep), resale: resaleOf(i) };
  }
  const momentum = i => i.d7 != null ? i.d7 : i.m;

  // avis du radar sur une version
  function verdictRadar(i) {
    const mo = momentum(i), cat = i.cat || [], f = i.f || [];
    if (f.includes("pic") || f.includes("fantome")) return { level: "bad", text: "Prix Cardmarket douteux (vente isolée ou offre anormale) : n'enchéris pas à l'aveugle." };
    if (cat.includes("chute") || (mo != null && mo < -0.2)) return { level: "bad", text: `En baisse (${pc(mo)}) : pas intéressante à garder, seulement si c'est une vraie affaire.` };
    if (mo != null && mo > 0.6) return { level: "bad", text: `Déjà partie (${pc(mo)}) : risque d'acheter au sommet, ne paie pas plus que le max revente.` };
    if (cat.includes("rattrapage")) return { level: "good", text: "Intéressante : version en retard alors qu'une autre version de la carte a décollé." };
    if (cat.includes("decollage")) return { level: "good", text: `Intéressante : commence à monter (${pc(mo)}) avec des ventes régulières.` };
    if (cat.includes("rebond")) return { level: "good", text: "Intéressante : repart à la hausse après une baisse." };
    if (mo != null && mo >= 0.1) return { level: "good", text: `En hausse (${pc(mo)}) : potentiel si tu restes sous ton max.` };
    if (resaleOf(i) < 5) return { level: "bad", text: "Carte à moins de 5 € : les frais et le port mangent la marge, intéressante seulement dans un lot." };
    if (f.includes("rare")) return { level: "mid", text: "Peu d'échanges sur Cardmarket : revente lente, prix moins fiable." };
    if (f.includes("nouveau")) return { level: "mid", text: "Carte récente : les prix baissent souvent les premières semaines." };
    return { level: "mid", text: "Pas de signal particulier : intéressante seulement sous le max revente." };
  }

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
    const title = titleText();
    hints = keywordHints(title);
    const hl = ["JP", "FR", "EN"].filter(x => hints.includes(x));
    if (hl.length === 1 && langSrc !== "image") setLang(hl[0], "titre");
    if (!pinned) {
      const next = fresh[0] || (current && seenNow.has(current) ? current : found[0]);
      if (next) {
        if (next !== current) { current = next; selectedId = null; bidManual = null; visionPref = null; if (!langManual && langSrc !== "titre") lang = null; if (hints.includes("JP") || hints.includes("alt")) preselect(); }
        source = "code"; candidates = [];
      } else {
        // pas de code écrit : on cherche un nom de carte dans le titre du lot
        candidates = codesFromName(title);
        if (candidates.length === 1 && candidates[0] !== current) {
          current = candidates[0]; selectedId = null; bidManual = null; visionPref = null; source = "nom";
          if (hints.includes("JP") || hints.includes("alt")) preselect();
        } else if (candidates.length > 1 && source !== "image") {
          if (!candidates.includes(current)) { current = null; selectedId = null; }
          source = "nom";
        }
      }
    }
    bidAuto = detectBid();
    if (settings.autoVision && (!found.length || !lang) && !visionBusy && Date.now() - lastVisionAt > 10000) identifyImage(true);
    render();
  }

  // ---------- reconnaissance d'image
  function biggestVideoRect() {
    let best = null, area = 0;
    for (const v of document.querySelectorAll("video")) {
      const r = v.getBoundingClientRect();
      const a = Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0)) * Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
      if (a > area) { area = a; best = r; }
    }
    return area > 40000 ? best : null;
  }

  async function cropShot(dataUrl) {
    const img = new Image();
    await new Promise((ok, ko) => { img.onload = ok; img.onerror = ko; img.src = dataUrl; });
    const k = img.width / innerWidth;
    const r = biggestVideoRect();
    let sx = 0, sy = 0, sw = img.width, sh = img.height;
    if (r) { sx = Math.max(0, r.left * k); sy = Math.max(0, r.top * k); sw = Math.min(img.width - sx, r.width * k); sh = Math.min(img.height - sy, r.height * k); }
    const scale = Math.min(1, 1280 / Math.max(sw, sh));
    const c = document.createElement("canvas");
    c.width = Math.round(sw * scale); c.height = Math.round(sh * scale);
    c.getContext("2d").drawImage(img, sx, sy, sw, sh, 0, 0, c.width, c.height);
    const h = document.createElement("canvas"); h.width = h.height = 16;
    const hc = h.getContext("2d"); hc.drawImage(c, 0, 0, 16, 16);
    const px = hc.getImageData(0, 0, 16, 16).data, hash = [];
    for (let i = 0; i < px.length; i += 4) hash.push((px[i] + px[i + 1] + px[i + 2]) / 3);
    return { b64: c.toDataURL("image/jpeg", 0.85).split(",")[1], hash };
  }
  const hashDiff = (a, b) => a.reduce((s, v, i) => s + Math.abs(v - b[i]), 0) / a.length;

  async function identifyImage(auto) {
    if (!settings.apiKey) { if (!auto) { setStatus("Ajoute ta clé API Claude dans Réglages"); root.querySelector("#settings").open = true; } return; }
    if (visionBusy) return;
    visionBusy = true; lastVisionAt = Date.now();
    try {
      const shot = await chrome.runtime.sendMessage({ type: "capture" });
      if (!shot || shot.error) throw new Error(shot ? shot.error : "capture impossible");
      const img = await cropShot(shot.dataUrl);
      if (auto && lastHash && hashDiff(img.hash, lastHash) < 12) return;   // image quasi identique : on n'appelle pas Claude
      lastHash = img.hash;
      setStatus("Analyse de l'image…");
      const out = await chrome.runtime.sendMessage({ type: "identify", image: img.b64, context: titleText().slice(0, 600), apiKey: settings.apiKey, model: settings.model });
      if (!out || out.error) throw new Error(out ? out.error : "pas de réponse");
      const res = out.res || {};
      if (!res.visible) { setStatus("Image : aucune carte lisible"); return; }
      let code = null;
      if (res.code) { CODE_RE.lastIndex = 0; const m = CODE_RE.exec(res.code); if (m && byCode.has(canonical(m))) code = canonical(m); }
      const nameCodes = res.name ? codesFromName(res.name + " " + (res.set_guess || "")) : [];
      if (!code && nameCodes.length > 1 && res.rarity && /SEC/i.test(res.rarity)) {
        const sec = nameCodes.filter(c => +c.split("-")[1] >= 118);
        if (sec.length === 1) code = sec[0];
      }
      if (!code && nameCodes.length === 1) code = nameCodes[0];
      visionPref = { lang: res.language, alt: res.alt_art, rarity: res.rarity };
      if (res.language) setLang(["JP", "CN", "KR"].includes(res.language) ? "JP" : res.language, "image");
      if (code) {
        current = code; pinned = true; source = "image"; selectedId = null; bidManual = null; candidates = [];
        recent = [code, ...recent.filter(x => x !== code)].slice(0, 6);
        preselect();
        setStatus(`Image : ${res.name || ""} ${code} (${Math.round((res.confidence || 0) * 100)} %)`);
      } else if (nameCodes.length) {
        candidates = nameCodes; current = null; selectedId = null; source = "image"; pinned = true;
        setStatus(`Image : ${res.name} — choisis le code`);
      } else setStatus(`Image : ${res.name || "carte"} non trouvée dans les prix`);
      render();
    } catch (e) {
      setStatus("Image : " + e.message);
    } finally { visionBusy = false; }
  }

  // présélectionne la version d'après la langue et « alt » vus par l'image ou écrits dans le titre
  function preselect() {
    const vs = versionsOf(current);
    const wantJP = lang === "JP";
    const wantAlt = visionPref ? visionPref.alt === true : hints.includes("alt");
    const prefix = current.split("-")[0];
    let pool = vs.filter(v => /Asie|JP/.test(v.e) === wantJP && v.e.startsWith(prefix));
    if (!pool.length) pool = vs.filter(v => /Asie|JP/.test(v.e) === wantJP);
    if (!pool.length) return;
    pool.sort((a, b) => a.t - b.t);           // la moins chère = version normale, la suivante = alt
    const pick = wantAlt ? (pool[1] || pool[0]) : pool[0];
    selectedId = pick.id;
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
    .radar{margin-top:6px;border-radius:9px;padding:8px 10px;font-size:12.5px;line-height:1.35}
    .radar.good{background:#11291e;color:#3fcf86} .radar.bad{background:#331714;color:#ff7a6b} .radar.mid{background:#1c2233;color:#c9cfdd}
    .btn{flex:1;background:#2340c9;color:#fff;border:0;border-radius:8px;padding:8px 10px;font:600 13px system-ui,sans-serif;cursor:pointer}
    .btn:hover{background:#2f4fe0}
    .cand{display:flex;flex-direction:column;gap:5px} .cand .chip{font-family:system-ui,sans-serif}
    a{color:#8ea0ff}
  </style>
  <div class="p">
    <div class="h" id="drag"><b>Radar <span>Whatnot</span></b><span class="s" id="status">Chargement…</span>
      <button id="refresh" title="Recharger les prix">↻</button><button id="min" title="Réduire">–</button></div>
    <div class="b" id="body">
      <input id="q" placeholder="Chercher : robin 062, OP09-062, teach…" autocomplete="off">
      <div class="row"><button id="vision" class="btn">📷 Identifier la carte à l'image</button></div>
      <div class="chips" id="recent"></div>
      <div id="cands"></div>
      <div class="row" id="langs"><span class="muted">Langue :</span>
        <span class="chip" data-l="EN">EN</span><span class="chip" data-l="FR">FR</span><span class="chip" data-l="JP">JP</span><span class="muted" id="langsrc"></span></div>
      <div class="row"><span class="muted" style="white-space:nowrap">Enchère actuelle</span><input id="bid" type="number" inputmode="decimal" step="1" min="0" placeholder="auto"></div>
      <div id="verdict"></div>
      <div id="card"></div>
      <details id="settings"><summary>Réglages (marge, frais)</summary>
        <div class="set" style="margin-top:8px">
          <label>Marge visée %<input id="s-target" type="number" step="1"></label>
          <label>Commission revente %<input id="s-sellFee" type="number" step="0.5"></label>
          <label>Envoi à ta charge €<input id="s-shipOut" type="number" step="0.1"></label>
          <label>Port Whatnot par carte €<input id="s-shipIn" type="number" step="0.5"></label>
          <label>Frais acheteur Whatnot %<input id="s-buyFee" type="number" step="0.5"></label>
          <label>Base de prix<select id="s-basis"><option value="safe">Prudente</option><option value="trend">Tendance</option><option value="a30">Moy. 30 j</option></select></label>
          <label style="grid-column:1 / -1">Clé API Claude (pour l'image)<input id="s-apiKey" type="password" placeholder="sk-ant-…" autocomplete="off"></label>
          <label>Modèle<select id="s-model"><option value="claude-sonnet-5-5">Précis (Sonnet)</option><option value="claude-haiku-4-5-20251001">Rapide (Haiku)</option></select></label>
          <label>Port Cardmarket €<input id="s-cmShip" type="number" step="0.1"></label>
          <label>Décote cartes FR %<input id="s-frDiscount" type="number" step="1"></label>
          <label>Image automatique<select id="s-autoVision"><option value="false">Non</option><option value="true">Oui (si pas de code)</option></select></label>
        </div>
      </details>
      <div class="muted">Le panneau lit le code ou le nom de la carte écrits à l'écran. Sinon : bouton 📷 (reconnaissance d'image) ou recherche en haut.</div>
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
    if (code) { current = code; pinned = true; source = "recherche"; candidates = []; selectedId = null; bidManual = null; recent = [code, ...recent.filter(x => x !== code)].slice(0, 6); render(); }
    else setStatus("Aucune carte trouvée pour « " + v + " »");
  });
  $("#recent").addEventListener("click", e => {
    const b = e.target.closest("[data-c]"); if (!b) return;
    if (b.dataset.c === "__auto") { pinned = false; scan(); return; }
    current = b.dataset.c; pinned = true; selectedId = null; bidManual = null; render();
  });
  $("#vision").addEventListener("click", () => identifyImage(false));
  $("#langs").addEventListener("click", e => {
    const b = e.target.closest("[data-l]"); if (!b) return;
    if (lang === b.dataset.l && langManual) { langManual = false; lang = null; langSrc = ""; }
    else { lang = b.dataset.l; langManual = true; langSrc = "choisie"; }
    if (current) preselect(); render();
  });
  $("#cands").addEventListener("click", e => {
    const b = e.target.closest("[data-c]"); if (!b) return;
    current = b.dataset.c; pinned = true; selectedId = null; bidManual = null; if (visionPref || hints.length) preselect(); render();
  });
  $("#card").addEventListener("click", e => { const v = e.target.closest("[data-id]"); if (!v) return; selectedId = +v.dataset.id; render(); });
  $("#bid").addEventListener("input", () => { const x = parseFloat($("#bid").value); bidManual = isFinite(x) ? x : null; renderVerdict(); });

  // réglages
  for (const k of Object.keys(DEFAULTS)) {
    const el = $("#s-" + k);
    el.addEventListener("input", () => {
      settings[k] = ["basis", "apiKey", "model"].includes(k) ? el.value : k === "autoVision" ? el.value === "true" : (parseFloat(el.value) || 0);
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
    for (const k of Object.keys(DEFAULTS)) { const el = $("#s-" + k); if (root.activeElement !== el) el.value = String(settings[k]); }
    $("#recent").innerHTML = recent.map(c => `<span class="chip ${c === current ? "on" : ""}" data-c="${c}">${c}</span>`).join("")
      + (pinned ? '<span class="chip" data-c="__auto">↺ auto</span>' : "");
    root.querySelectorAll("#langs [data-l]").forEach(b => b.classList.toggle("on", b.dataset.l === lang));
    $("#langsrc").textContent = lang ? `(${langSrc})` : "(inconnue : touche EN, FR ou JP)";
    $("#cands").innerHTML = candidates.length > 1 ? `<div class="cand"><span class="muted">Cartes possibles (lu : ${source === "image" ? "image" : "nom"}${hints.length ? ", " + hints.join(", ") : ""}) — touche la bonne :</span>`
      + candidates.map(c => { const v = (byCode.get(c) || [])[0]; return `<span class="chip ${c === current ? "on" : ""}" data-c="${c}">${esc(v ? v.n : "")} · ${c}</span>`; }).join("") + "</div>" : "";
    if (root.activeElement !== $("#bid")) $("#bid").value = bidManual != null ? bidManual : "";
    $("#bid").placeholder = bidAuto != null ? `auto : ${bidAuto} €` : "tape l'enchère";
    if (!D || !current) {
      $("#card").innerHTML = `<div class="muted">${D ? "En attente d'un code de carte à l'écran (ex. OP09-062)…" : ""}</div>`;
      renderVerdict(); return;
    }
    const vs = versionsOf(current);
    if (!vs.length) { $("#card").innerHTML = `<div class="muted">${esc(current)} : pas de prix Cardmarket.</div>`; renderVerdict(); return; }
    if (!vs.find(v => v.id === selectedId)) selectedId = null;
    const match = v => lang ? (lang === "JP") === isAsia(v) : true;
    const shown = vs.filter(v => v.t >= 1 || v.id === selectedId).sort((a, b) => (match(b) - match(a)) || (b.t - a.t)).slice(0, 12);
    $("#card").innerHTML = `<div class="card"><h3>${esc(vs[0].n)}</h3><div class="c">${esc(current)} · ${vs.length} version${vs.length > 1 ? "s" : ""}${source ? " · trouvé par " + source : ""}${hints.length ? " · " + hints.join(", ") : ""} · touche la version en vente<br>max revente · max pour garder</div></div>`
      + shown.map(v => {
        const mb = maxBid(v), mo = momentum(v);
        const cls = mo == null ? "flat" : mo > 0.02 ? "up" : mo < -0.02 ? "down" : "flat";
        return `<div class="v ${v.id === selectedId ? "on" : ""}" data-id="${v.id}" style="${match(v) ? "" : "opacity:.45"}">
          <div class="e">${esc(v.e)}${v.v ? " · V" + v.v : ""}</div><div class="mx" title="revente / garder">${eur(mb.max)} · ${eur(mb.keep)}</div>
          <div class="d"><span>marché ${eur(v.t)}</span><span>ventes 7 j ${eur(v.a7)}</span><span class="${cls}">${pc(mo)}</span>${tags(v)}</div></div>`;
      }).join("");
    renderVerdict();
  }

  function renderVerdict() {
    const el = $("#verdict");
    const bid = bidManual != null ? bidManual : bidAuto;
    const v = D && selectedId && current ? D.items.find(i => i.id === selectedId && i.c === current) : null;
    if (!v) { el.innerHTML = current ? '<div class="verdict none"><div class="big">Quelle version ?</div><div class="l">Touche la version annoncée (alt, normale, JP…)</div></div>' : ""; return; }
    const mb = maxBid(v);
    let c, t;
    if (bid == null) { c = "none"; t = `Revente : ≤ ${eur(mb.max)}`; }
    else if (bid <= mb.max * 0.8) { c = "good"; t = "Très bonne affaire"; }
    else if (bid <= mb.max) { c = "good"; t = "Bonne affaire"; }
    else if (bid <= mb.keep) { c = "mid"; t = "OK pour garder, pas pour revendre"; }
    else { c = "bad"; t = "Trop cher, stop"; }
    const risky = false;
    const rv = verdictRadar(v);
    const notes = [];
    if (lang === "FR" && !isAsia(v)) notes.push(`Carte FR : Cardmarket mélange FR et EN dans le même prix, décote prudente de ${settings.frDiscount} % appliquée.`);
    if (lang === "JP" && !isAsia(v)) notes.push("⚠ Carte JP mais version EN sélectionnée : choisis la ligne Asie/JP.");
    if ((lang === "EN" || lang === "FR") && isAsia(v)) notes.push("⚠ Carte EN/FR mais version Asie/JP sélectionnée.");
    if (!lang) notes.push("Langue inconnue : touche EN, FR ou JP pour un prix juste.");
    // garde-fou : grosse différence de prix entre versions de la même langue
    const same = versionsOf(current).filter(x => isAsia(x) === isAsia(v) && x.t > 0);
    const cheapest = same.reduce((m, x) => (!m || x.t < m.t) ? x : m, null);
    if (cheapest && cheapest.id !== v.id && v.t > cheapest.t * 4)
      notes.unshift(`⚠ La version de base de cette carte vaut ${eur(cheapest.t)} (V${cheapest.v || 1}). Tu as choisi une version à ${eur(v.t)} : ne mise ce prix que si tu es SÛR que c'est une alt / parallèle (compare les images sur Cardmarket).`);
    if (v.lo && bid != null && bid > v.lo * langFactor(v)) notes.push(`💡 Sur Cardmarket, la moins chère est à ${eur(v.lo)} (hors port, vérifier état et langue) : pas la peine de payer plus ici.`);
    el.innerHTML = `<div class="verdict ${c}"><div class="big">${t}</div>
      <div class="l">Pour revendre (${settings.target} % de marge) : <b>≤ ${eur(mb.max)}</b></div>
      <div class="l">Pour garder / investir : <b>≤ ${eur(mb.keep)}</b></div>
      <div class="l">Valeur retenue : ${eur(mb.resale)} (la plus basse entre tendance, ventes 7 j et offre la moins chère${v.lo ? " " + eur(v.lo) : ""})</div>
      ${bid != null ? `<div class="l">Enchère actuelle : ${eur(bid)}</div>` : ""}
      </div>
      <div class="radar ${rv.level}">${rv.level === "good" ? "✅" : rv.level === "bad" ? "⛔" : "➖"} ${esc(rv.text)}</div>
      ${notes.map(n => `<div class="muted">${esc(n)}</div>`).join("")}`;
  }

  loadData(false).then(() => { scan(); setInterval(scan, 1500); });
})();
