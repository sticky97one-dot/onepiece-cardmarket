"""Injecte site/data.json dans site/template.html -> site/radar-one-piece.html."""
import json, os, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SITE = os.path.join(ROOT, "site")

data = json.load(open(os.path.join(SITE, "data.json"), encoding="utf-8"))
if "--sample" in sys.argv:
    data["sample"] = True
payload = json.dumps(data, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/")
tpl = open(os.path.join(SITE, "template.html"), encoding="utf-8").read()
out = os.path.join(SITE, "radar-one-piece.html")
open(out, "w", encoding="utf-8").write(tpl.replace("/*DATA*/", payload, 1))
print(out, os.path.getsize(out) // 1024, "Ko")
