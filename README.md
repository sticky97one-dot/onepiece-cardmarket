# Radar One Piece — veille des prix Cardmarket

Collecte chaque jour le guide des prix public de Cardmarket pour One Piece (idGame 18),
garde l'historique jour par jour et calcule les cartes à potentiel.

- `scripts/fetch.py` : télécharge les prix + catalogues, archive `data/history/AAAA-MM-JJ.csv.gz`
- `scripts/analyze.py` : indicateurs, score de potentiel, catégories (décollage, rebond, déjà partie, scellé, chute, pièges)
- `scripts/build_page.py` : génère le tableau de bord `site/radar-one-piece.html`
- `.github/workflows/daily.yml` : exécution automatique chaque matin
