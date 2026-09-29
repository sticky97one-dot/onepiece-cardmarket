"""Télécharge les fichiers publics Cardmarket One Piece (idGame 18) et archive un instantané du jour.

Fichiers source (mis à jour une fois par jour par Cardmarket, vers 03h heure de Paris) :
  - price_guide_18.json          : prix de tous les produits One Piece
  - products_singles_18.json     : catalogue des cartes
  - products_nonsingles_18.json  : catalogue des produits scellés (displays, boosters...)

Sortie :
  data/raw/*.json                        : dernière version brute
  data/history/AAAA-MM-JJ.csv.gz         : instantané compact du jour (historique)
"""
import csv, gzip, json, os, sys, time, urllib.request

GAME = 18
BASE = "https://downloads.s3.cardmarket.com/productCatalog"
FILES = {
    "price_guide.json": f"{BASE}/priceGuide/price_guide_{GAME}.json",
    "products_singles.json": f"{BASE}/productList/products_singles_{GAME}.json",
    "products_nonsingles.json": f"{BASE}/productList/products_nonsingles_{GAME}.json",
}
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, "data", "raw")
HIST = os.path.join(ROOT, "data", "history")
FIELDS = ["idProduct", "trend", "low", "avg", "avg1", "avg7", "avg30"]


def get(url, tries=4):
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "onepiece-price-archive/1.0"})
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.read()
        except Exception as e:  # noqa
            print(f"  essai {i+1} échoué : {e}", file=sys.stderr)
            time.sleep(10 * (i + 1))
    raise SystemExit(f"Impossible de télécharger {url}")


def main():
    os.makedirs(RAW, exist_ok=True)
    os.makedirs(HIST, exist_ok=True)
    for name, url in FILES.items():
        print("Téléchargement", url)
        body = get(url)
        json.loads(body)  # valide
        with open(os.path.join(RAW, name), "wb") as f:
            f.write(body)

    pg = json.load(open(os.path.join(RAW, "price_guide.json"), encoding="utf-8"))
    day = pg["createdAt"][:10]  # date de génération Cardmarket
    out = os.path.join(HIST, f"{day}.csv.gz")
    with gzip.open(out, "wt", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(FIELDS)
        for p in pg["priceGuides"]:
            w.writerow(["" if p.get(k) is None else p.get(k) for k in FIELDS])
    print(f"Instantané {day} : {len(pg['priceGuides'])} produits -> {out}")


if __name__ == "__main__":
    main()
