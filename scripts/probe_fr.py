"""Diagnostic ponctuel : repère le chemin des images sur le site officiel français."""
import os, re, urllib.request
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "images", "out", "probe.txt")
res = []
for url in ["https://fr.onepiece-cardgame.com/", "https://fr.onepiece-cardgame.com/cardlist/", "https://fr.onepiece-cardgame.com/cardlist/?series=569112"]:
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=30) as r:
            html = r.read().decode("utf-8", "ignore"); final = r.geturl()
        imgs = sorted(set(re.findall(r'(?:src|data-src)="([^"]+\.(?:png|webp|jpg)[^"]*)"', html)))
        res.append(f"## {url} -> {final} ({len(html)} o)\n" + "\n".join(i for i in imgs if "card" in i.lower())[:3000])
        res.append("series: " + " ".join(sorted(set(re.findall(r'series=(\d+)', html)))[:40]))
    except Exception as e:
        res.append(f"## {url} ERREUR {e}")
open(OUT, "w", encoding="utf-8").write("\n".join(res))
