"""Analyse quotidienne des prix Cardmarket One Piece.

Lit data/raw (catalogue + prix du jour) et data/history (instantanés quotidiens),
calcule pour chaque produit des indicateurs de dynamique, un score de potentiel
et des alertes, puis écrit :
  site/data.json      : données du tableau de bord
  reports/latest.md   : résumé texte du jour
Aucune dépendance externe (bibliothèque standard uniquement).
"""
import csv, glob, gzip, json, math, os, re
from collections import Counter, defaultdict
from datetime import date, datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, "data", "raw")
HIST = os.path.join(ROOT, "data", "history")
SITE = os.path.join(ROOT, "site")
REPORTS = os.path.join(ROOT, "reports")

MIN_TREND_LIST = 2.0     # prix mini (EUR) pour apparaître dans les classements
MIN_TREND_KEEP = 0.25    # prix mini pour être dans la recherche
NEW_DAYS = 21            # carte ajoutée il y a moins de N jours = "nouveauté" (prix instable)
TOP_N = 40

SET_NAMES = {
    "OP01": "Romance Dawn", "OP02": "Paramount War", "OP03": "Pillars of Strength",
    "OP04": "Kingdoms of Intrigue", "OP05": "Awakening of the New Era", "OP06": "Wings of the Captain",
    "OP07": "500 Years in the Future", "OP08": "Two Legends", "OP09": "Emperors in the New World",
    "OP10": "Royal Blood", "OP11": "A Fist of Divine Speed", "OP12": "Legacy of the Master",
    "OP13": "Carrying On His Will", "EB01": "Memorial Collection", "EB02": "Anime 25th Collection",
    "PRB01": "Premium Booster", "P": "Promos",
}
# extensions "fourre-tout" de Cardmarket (promos, rééditions) : noms lisibles
EXP_OVERRIDES = {
    5262: "Promos tournois & événements", 5303: "Promos packs de participation",
    5510: "Promos boutique & Red Envelope", 5598: "Promos spéciales (lot 5598)",
    6684: "Promos spéciales (lot 6684)", 6677: "Promos diverses", 6498: "Promos diverses (2026)",
    5267: "Premium Card Collection", 5302: "Revision Pack", 5312: "Judge Pack",
    5804: "PRB01 The Best (Asie)", 5805: "PRB01 The Best", 6233: "PRB02 The Best Vol.2 (Asie)",
    6242: "PRB02 The Best Vol.2", 6625: "Best Selection Vol.2 (Asie)",
}
CODE_RE = re.compile(r"\(([A-Z]{1,5}\d{0,3}-\d{3}[A-Za-z]?)\)")


def num(v):
    """Prix en float ; None si absent ou nul (Cardmarket met 0 quand il n'y a pas de donnée)."""
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if f > 0 else None


def pct(a, b):
    if a is None or b is None or b <= 0:
        return None
    return a / b - 1


def clip(x, lo, hi):
    return max(lo, min(hi, x))


def load_json(name):
    with open(os.path.join(RAW, name), encoding="utf-8") as f:
        return json.load(f)


def load_history():
    files = sorted(glob.glob(os.path.join(HIST, "*.csv.gz")))
    days, series = [], defaultdict(dict)
    for fp in files:
        d = os.path.basename(fp)[:10]
        days.append(d)
        with gzip.open(fp, "rt", encoding="utf-8") as f:
            for row in csv.DictReader(f):
                series[int(row["idProduct"])][d] = (num(row["trend"]), num(row["low"]), num(row["avg1"]))
    return days, series


def value_back(days, s, n):
    """Tendance il y a ~n jours (instantané le plus proche disponible, au moins n jours avant)."""
    if not days:
        return None
    last = date.fromisoformat(days[-1])
    for d in reversed(days):
        if (last - date.fromisoformat(d)).days >= n and d in s and s[d][0]:
            return s[d][0]
    return None


ASIA_RE = re.compile(r"\((Non-English|Asia Region Legal|Japanese)\)", re.I)
PRODUCT_RE = re.compile(r"\s*(\(12x Booster Box\)|Booster Box Case|Booster Box|Sleeved Booster|Booster Display|Booster|"
                        r"Deck Pack|Bonus Pack|Display|Case)\b.*$", re.I)


def clean_product_name(n):
    n = ASIA_RE.sub("", n).replace("  ", " ").strip()
    return PRODUCT_RE.sub("", n).strip(" -:") or n


def expansion_labels(singles, nonsingles):
    """Nom lisible de chaque extension Cardmarket, avec la mention Asie/JP pour les éditions non anglaises."""
    codes = defaultdict(Counter)
    for p in singles:
        m = CODE_RE.search(p["name"])
        if m:
            codes[p["idExpansion"]][m.group(1).split("-")[0]] += 1
    sealed = defaultdict(list)
    for p in nonsingles:
        sealed[p["idExpansion"]].append(p["name"])
    labels = {}
    for exp in set(codes) | set(sealed):
        c = codes.get(exp)
        top, share = (c.most_common(1)[0][0], c.most_common(1)[0][1] / sum(c.values())) if c else (None, 0)
        names = sealed.get(exp, [])
        asia = any(ASIA_RE.search(n) for n in names)
        pname = Counter(clean_product_name(n) for n in names).most_common(1)[0][0] if names else None
        special = bool(pname and re.search(r"pre-release|release event|tournament|anniversary|demo|starter|deck", pname, re.I))
        if top and share >= 0.6 and top in SET_NAMES and not special and (not pname or SET_NAMES[top].lower()[:8] in pname.lower()):
            lab = f"{top} · {SET_NAMES[top]}"
        elif pname and top and share >= 0.6 and not pname.startswith(top):
            lab = f"{top} · {pname}"
        elif pname:
            lab = pname
        elif top and share >= 0.6:
            lab = f"{top} · {SET_NAMES[top]}" if top in SET_NAMES else top
        else:
            lab = f"Extension {exp}"
        if any("Pre-Errata" in n for n in names):
            lab += " · Pre-Errata"
        labels[exp] = lab + (" · Asie/JP" if asia else "")
    for exp, lab in EXP_OVERRIDES.items():
        labels[exp] = lab
    return labels


def analyze():
    pg = load_json("price_guide.json")
    singles = load_json("products_singles.json")["products"]
    try:
        nonsingles = load_json("products_nonsingles.json")["products"]
    except FileNotFoundError:
        nonsingles = []
    price_date = pg["createdAt"][:10]
    days, hist = load_history()
    exp_label = expansion_labels(singles, nonsingles)

    # versions (V1, V2...) : même carte (metacard) dans la même extension
    groups = defaultdict(list)
    for p in singles:
        groups[(p.get("idMetacard"), p["idExpansion"])].append(p["idProduct"])
    version = {}
    for ids in groups.values():
        if len(ids) > 1:
            for i, pid in enumerate(sorted(ids)):
                version[pid] = i + 1

    catalog = {}
    for p in singles:
        catalog[p["idProduct"]] = (p, "S")
    for p in nonsingles:
        catalog[p["idProduct"]] = (p, "N")

    today = datetime.fromisoformat(price_date).date()
    items = []
    for g in pg["priceGuides"]:
        pid = g["idProduct"]
        if pid not in catalog:
            continue
        p, kind = catalog[pid]
        trend, low, avg = num(g.get("trend")), num(g.get("low")), num(g.get("avg"))
        a1, a7, a30 = num(g.get("avg1")), num(g.get("avg7")), num(g.get("avg30"))
        if not trend or trend < MIN_TREND_KEEP:
            continue
        m = CODE_RE.search(p["name"])
        code = m.group(1) if m else ""
        added = p.get("dateAdded", "")[:10]
        age = (today - date.fromisoformat(added)).days if added else 999

        s = hist.get(pid, {})
        tr_hist = [s[d][0] for d in days if d in s and s[d][0]]
        d1 = pct(trend, value_back(days, s, 1))
        d7 = pct(trend, value_back(days, s, 7))
        d30 = pct(trend, value_back(days, s, 30))
        streak = 0
        for i in range(len(tr_hist) - 1, 0, -1):
            if tr_hist[i] > tr_hist[i - 1] * 1.001:
                streak += 1
            else:
                break
        recent = [d for d in days[-14:] if d in s]
        sold_ratio = (sum(1 for d in recent if s[d][2]) / len(recent)) if len(recent) >= 5 else None
        low7 = None
        if days:
            for d in reversed(days):
                if (date.fromisoformat(days[-1]) - date.fromisoformat(d)).days >= 7 and d in s:
                    low7 = s[d][1]
                    break
        low_d7 = pct(low, low7)

        m7_30 = pct(a7, a30)
        m1_7 = pct(a1, a7)
        t_30 = pct(trend, a30)
        low_ratio = (low / trend) if (low and trend) else None

        thin = bool((a7 and a30 and abs(a7 - a30) < 0.005 * a30) or (low_ratio and low_ratio > 2) or not a1)
        # --- liquidité (le fichier ne donne pas de volumes : on regarde s'il y a des ventes récentes)
        if sold_ratio is not None:
            liq = 0.3 + 0.7 * sold_ratio
        else:
            liq = 1.0 if (a1 and a7 and a30) else (0.65 if (a7 and a30) else 0.35)
        if thin:
            liq *= 0.6

        # --- dynamique
        mom = 0.0
        mom += 0.40 * clip(m7_30 or 0, -0.5, 1.0)
        mom += 0.30 * clip(t_30 or 0, -0.5, 1.0)
        mom += 0.30 * clip(d7 if d7 is not None else (m7_30 or 0), -0.5, 1.0)
        conf = 0.0
        if a1 and a7 and a1 >= a7:
            conf += 0.06
        if low_ratio is not None:
            if 0.9 <= low_ratio <= 1.6:
                conf += 0.08
            elif low_ratio < 0.5:
                conf -= 0.08
        if low_d7 is not None and low_d7 > 0.05:
            conf += 0.06
        if streak >= 3:
            conf += 0.05
        raw = (mom + conf) * liq

        flags, reasons = [], []
        spike = bool(m1_7 is not None and m1_7 > 0.8 and (m7_30 or 0) < 0.15)
        phantom = bool(trend >= 20 and low_ratio is not None and low_ratio < 0.3)
        if spike:
            flags.append("pic")
            raw -= 0.15
            reasons.append("vente isolée très au-dessus de la moyenne 7 j")
        if phantom:
            flags.append("fantome")
            reasons.append("prix bas anormalement faible : vérifier les offres réelles")
        if thin and trend >= MIN_TREND_LIST:
            flags.append("rare")
            reasons.append("peu d'échanges : prix moins fiable")
        if age < NEW_DAYS:
            flags.append("nouveau")
            reasons.append(f"sortie il y a {age} j : prix encore instable")
        score = round(clip((raw + 0.05) / 0.85, 0, 1) * 100)

        if m7_30 is not None and abs(m7_30) >= 0.05:
            reasons.insert(0, f"moy. 7 j {m7_30:+.0%} vs 30 j")
        if d7 is not None and abs(d7) >= 0.05:
            reasons.insert(0, f"tendance {d7:+.0%} sur 7 j")
        if low_ratio is not None and 0.9 <= low_ratio <= 1.6 and trend >= MIN_TREND_LIST:
            reasons.append("offres tendues : prix le plus bas ≥ 90 % de la tendance")
        if streak >= 3:
            reasons.append(f"{streak} hausses de suite")

        cat = []
        liquid = liq >= 0.6
        if trend >= MIN_TREND_LIST and not spike and not phantom:
            if (0.08 <= (m7_30 or 0) <= 0.6 and (t_30 or 0) > 0.05 and 0.75 <= (low_ratio or 0) <= 1.6
                    and liquid and not thin and age >= NEW_DAYS):
                cat.append("decollage")
            if (m7_30 or 0) > 0.6 or (d7 or 0) > 0.6:
                cat.append("flambee")
            if a30 and trend < a30 * 0.8 and a1 and a7 and a1 > a7 * 1.05 and liquid:
                cat.append("rebond")
            if (m7_30 or 0) < -0.2 and (t_30 or 0) < -0.15:
                cat.append("chute")
        if spike or phantom:
            cat.append("piege")
        # offre sous le marché : la moins chère est nettement sous les ventes récentes
        disc = None
        if (not spike and not phantom and not thin and a1 and a7 and low and trend >= 10
                and low >= 0.3 * trend):
            ref = min(a1, a7, trend)
            if 0.6 * ref <= low <= 0.82 * ref:  # au-delà de -40 % : souvent carte abîmée ou offre douteuse
                disc = round(1 - low / ref, 3)
                cat.append("affaire")
                reasons.insert(0, f"offre à {low:.2f} € soit {disc:.0%} sous les ventes récentes (vérifier état et langue)")

        items.append({
            "id": pid, "n": p["name"] if re.match(r"(?i)don!!", p["name"]) else re.sub(r"\s*\([^)]*\)\s*$", "", p["name"]), "c": code,
            "v": version.get(pid), "g": p.get("idMetacard") or 0, "e": exp_label.get(p["idExpansion"], ""), "k": kind,
            "t": trend, "lo": low, "a1": a1, "a7": a7, "a30": a30,
            "d1": round(d1, 4) if d1 is not None else None,
            "d7": round(d7, 4) if d7 is not None else None,
            "d30": round(d30, 4) if d30 is not None else None,
            "m": round(m7_30, 4) if m7_30 is not None else None,
            "lr": round(low_ratio, 3) if low_ratio is not None else None,
            "liq": round(liq, 2), "s": score, "dc": disc, "f": flags, "cat": cat,
            "r": reasons[:4], "age": age,
            "h": [round(x, 2) for x in tr_hist[-30:]],
        })

    catch_up(items)

    def top(key, cond, n=TOP_N, rev=True):
        return [i["id"] for i in sorted((i for i in items if cond(i)), key=key, reverse=rev)[:n]]

    lists = {
        "decollage": top(lambda i: i["s"], lambda i: "decollage" in i["cat"] and i["k"] == "S"),
        "flambee": top(lambda i: (i["d7"] if i["d7"] is not None else i["m"]) or 0, lambda i: "flambee" in i["cat"]),
        "rebond": top(lambda i: i["s"], lambda i: "rebond" in i["cat"]),
        "scelle": top(lambda i: i["s"], lambda i: i["k"] == "N" and i["t"] >= 10),
        "chute": top(lambda i: (i["m"] or 0), lambda i: "chute" in i["cat"], rev=False),
        "piege": top(lambda i: i["t"], lambda i: "piege" in i["cat"]),
        "rattrapage": top(lambda i: i.get("cu", 0), lambda i: "rattrapage" in i["cat"]),
        "affaire": top(lambda i: (i["dc"] or 0) * min(1, i["t"] / 50), lambda i: "affaire" in i["cat"]),
    }
    out = {
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="minutes"),
        "priceDate": price_date,
        "historyDays": len(days),
        "firstDay": days[0] if days else None,
        "counts": {"produits": len(items), **{k: len(v) for k, v in lists.items()}},
        "lists": lists,
        "items": items,
    }
    os.makedirs(SITE, exist_ok=True)
    with open(os.path.join(SITE, "data.json"), "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    write_report(out)
    return out


def momentum(i):
    """Dynamique d'une version : historique 7 j si disponible, sinon moyenne 7 j vs 30 j."""
    return i["d7"] if i["d7"] is not None else i["m"]


def is_clean(i):
    return (i["a7"] and i["a30"] and not ({"rare", "pic", "fantome"} & set(i["f"])))


def catch_up(items):
    """Repère les versions d'une même carte restées en retard alors qu'une autre version a décollé.

    Même carte = même idMetacard chez Cardmarket (base, parallèle, alt art, promo, réédition...).
    """
    groups = defaultdict(list)
    for i in items:
        if i["k"] == "S" and i["g"]:
            groups[i["g"]].append(i)
    for vers in groups.values():
        for i in vers:
            i["nv"] = len(vers)
        if len(vers) < 2:
            continue
        # version "meneuse" : hausse nette mais crédible (ventes récentes au niveau, offres cohérentes)
        leaders = [x for x in vers if is_clean(x) and 0.35 <= (momentum(x) or 0) <= 2.0 and x["t"] >= 3
                   and x["a1"] and x["a1"] >= 0.8 * x["a7"] and x["lr"] and 0.6 <= x["lr"] <= 1.6]
        if not leaders:
            continue
        lead = max(leaders, key=lambda x: momentum(x) or 0)
        for i in vers:
            if i is lead or not is_clean(i) or not i["a1"] or i["t"] < 3:
                continue
            mo = momentum(i) or 0
            gap = (momentum(lead) or 0) - mo
            if mo > 0.15 or mo < -0.25 or gap < 0.3:
                continue
            # même "gamme" de version (on ne compare pas une commune à 5 € avec une alt art à 2 000 €)
            if not (0.2 <= i["t"] / lead["t"] <= 2.5) or not i["lr"] or i["lr"] < 0.75:
                continue
            tight = 1.0 if (i["lr"] and 0.8 <= i["lr"] <= 1.6) else 0.75
            i["cu"] = round(gap * i["liq"] * tight, 3)
            i["cat"].append("rattrapage")
            lv = f" V{lead['v']}" if lead["v"] else ""
            i["r"].insert(0, f"la version {lead['e']}{lv} à {lead['t']:.0f} € a pris {momentum(lead):+.0%}, "
                             f"celle-ci seulement {mo:+.0%} : retard à rattraper")
            i["r"] = i["r"][:4]


def write_report(out):
    by_id = {i["id"]: i for i in out["items"]}

    def line(i):
        v = f" V{i['v']}" if i["v"] else ""
        return (f"- **{i['n']}** {i['c']}{v} ({i['e']}) — {i['t']:.2f} € · score {i['s']}"
                f" · {', '.join(i['r'][:3])}")

    titles = {"affaire": "Offres sous le marché", "rattrapage": "Versions en retard (potentiel de rattrapage)", "decollage": "Cartes qui décollent", "flambee": "Déjà en forte hausse (prudence)",
              "rebond": "Rebonds après une baisse", "scelle": "Produits scellés",
              "chute": "En chute", "piege": "Pièges à éviter"}
    md = [f"# Radar One Piece — prix Cardmarket du {out['priceDate']}",
          f"{out['counts']['produits']} produits analysés · historique : {out['historyDays']} jour(s)\n"]
    for k, t in titles.items():
        ids = out["lists"][k][:10]
        md.append(f"## {t} ({len(out['lists'][k])})")
        md += [line(by_id[x]) for x in ids] or ["- rien aujourd'hui"]
        md.append("")
    os.makedirs(REPORTS, exist_ok=True)
    with open(os.path.join(REPORTS, "latest.md"), "w", encoding="utf-8") as f:
        f.write("\n".join(md))


if __name__ == "__main__":
    o = analyze()
    print(json.dumps(o["counts"], ensure_ascii=False))
