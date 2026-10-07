"""Télécharge les images officielles Bandai des cartes listées dans images/wanted.txt.

Une ligne = "CLE CODE LANGUE" (ex. "OP05-119-JP-V2 OP05-119 JP"). Version : suffixe -V2 -> image parallèle _p1, -V3 -> _p2.
Sortie : images/out/CLE.jpg (300 px de large). Les images déjà présentes ne sont pas retéléchargées.
Aucune requête vers Cardmarket.
"""
import io, os, sys, time, urllib.request
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WANTED = os.path.join(ROOT, "images", "wanted.txt")
OUT = os.path.join(ROOT, "images", "out")
SITES = {"JP": ["https://www.onepiece-cardgame.com", "https://asia-en.onepiece-cardgame.com"],
         "EN": ["https://en.onepiece-cardgame.com", "https://asia-en.onepiece-cardgame.com"],
         "FR": ["https://fr.onepiece-cardgame.com", "https://en.onepiece-cardgame.com", "https://www.onepiece-cardgame.com"]}


def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (classeur-one-piece)"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read()


def main():
    os.makedirs(OUT, exist_ok=True)
    if not os.path.exists(WANTED):
        print("Rien à télécharger"); return
    ok = miss = 0
    log = open(os.path.join(OUT, "log.txt"), "a", encoding="utf-8")
    for line in open(WANTED, encoding="utf-8"):
        parts = line.split()
        if len(parts) < 3 or line.startswith("#"):
            continue
        key, code, lang = parts[:3]
        dest = os.path.join(OUT, key + ".jpg")
        if os.path.exists(dest):
            continue
        v = int(key.rsplit("-V", 1)[1]) if "-V" in key and key.rsplit("-V", 1)[1].isdigit() else 1
        suffixes = [""] if v <= 1 else [f"_p{v-1}", ""]
        body = None
        for site in SITES.get(lang, SITES["EN"]):
            for suf in suffixes:
                url = f"{site}/images/cardlist/card/{code}{suf}.png"
                try:
                    body = get(url); print("OK ", key, url); log.write(f"OK {key} {url}\n"); break
                except Exception as e:  # noqa
                    print("   ", key, url, e); log.write(f"-- {key} {url} {e}\n")
                time.sleep(1)
            if body:
                break
        if not body:
            miss += 1; continue
        im = Image.open(io.BytesIO(body)).convert("RGB")
        w = 300; im = im.resize((w, round(im.height * w / im.width)))
        im.save(dest, "JPEG", quality=85); ok += 1
    print(f"{ok} image(s) téléchargée(s), {miss} introuvable(s)")


if __name__ == "__main__":
    main()
