// Service worker : capture de l'onglet Whatnot et identification de la carte par Claude (vision).
const PROMPT = `Cette image est extraite d'un live de vente de cartes (Whatnot). Identifie la carte du jeu "One Piece Card Game" que le vendeur montre au premier plan.
Réponds UNIQUEMENT avec un objet JSON, sans texte autour :
{"visible": true/false, "name": "nom du personnage tel qu'écrit sur la carte (en anglais si possible)", "code": "code imprimé en bas à droite, ex. OP09-062, ou null si illisible", "set_guess": "ex. OP09 ou null", "alt_art": true/false/null, "language": "EN" | "JP" | null, "rarity": "L, C, UC, R, SR, SEC, SP, manga, ou null", "confidence": nombre entre 0 et 1}
Règles : ne devine pas un code que tu ne lis pas ; "alt_art" = illustration alternative / parallèle (illustration qui déborde du cadre, style différent de la version normale) ; "language" = JP si le texte de la carte est en japonais. Si aucune carte One Piece n'est clairement visible, renvoie {"visible": false}.
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
