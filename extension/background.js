// Service worker : capture de l'onglet Whatnot et identification de la carte par Claude (vision).
const PROMPT = `Cette image est extraite d'un live de vente de cartes (Whatnot). Identifie la carte du jeu "One Piece Card Game" (Bandai) que le vendeur montre au premier plan. Toutes les séries sont possibles : boosters OP, starter decks ST, extra boosters EB, premium boosters PRB, promos P, cartes DON!!.
Réponds UNIQUEMENT avec un objet JSON, sans texte autour :
{"visible": true/false, "name": "nom du personnage en anglais (ex. Nico Robin, Marshall.D.Teach) ; si tu ne le connais pas, tel qu'écrit", "code": "code imprimé en bas à droite, ex. OP09-062, ST01-012, EB02-010, P-001, ou null si illisible", "set_guess": "ex. OP09 ou null", "alt_art": true/false/null, "language": "EN" | "FR" | "JP" | "CN" | "KR" | null, "rarity": "L, C, UC, R, SR, SEC, SP, TR, manga, ou null", "confidence": nombre entre 0 et 1}
Règles :
- Lis le code imprimé avec soin (lettres + chiffres). Ne l'invente pas : null si tu ne le lis pas.
- "alt_art" = version parallèle / illustration alternative (illustration qui déborde du cadre, style différent, souvent brillante).
- "language" : langue du texte imprimé sur la carte (effet, type). FR = français, EN = anglais, JP = japonais, CN = chinois, KR = coréen.
- Si aucune carte One Piece n'est clairement visible, renvoie {"visible": false}.
Texte affiché sur la page (peut aider, peut aussi ne rien avoir à voir) : `;

async function identify({ image, context, apiKey, model }) {
  const body = {
    model: model || "claude-sonnet-5-5",
    max_tokens: 300,
    messages: [{ role: "user", content: [
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: image } },
      { type: "text", text: PROMPT + (context || "(aucun)") }
    ] }]
  };
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true"
    },
    body: JSON.stringify(body)
  });
  const j = await r.json();
  if (!r.ok) throw new Error((j.error && j.error.message) || ("HTTP " + r.status));
  const text = (j.content || []).map(c => c.text || "").join("");
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("Réponse illisible");
  return JSON.parse(m[0]);
}

chrome.runtime.onMessage.addListener((msg, sender, send) => {
  if (msg.type === "capture") {
    chrome.tabs.captureVisibleTab(sender.tab.windowId, { format: "jpeg", quality: 85 })
      .then(dataUrl => send({ dataUrl }))
      .catch(e => send({ error: String(e && e.message || e) }));
    return true;
  }
  if (msg.type === "identify") {
    identify(msg).then(res => send({ res })).catch(e => send({ error: String(e && e.message || e) }));
    return true;
  }
});
