#!/usr/bin/env python3
"""Pipeline de curation IMSLP → catalogue de l'application.

  discover  : liste les œuvres pour flûte et leurs fichiers (métadonnées seulement)
  fetch     : télécharge les fichiers numériques (MusicXML/MIDI) et, avec --pdf, les PDF pour l'OMR
  omr       : convertit les PDF en MusicXML avec Audiveris (si installé) — à relire !
  analyse   : extrait la partie de flûte, calcule difficulté / complexité / niveau
  publish   : copie les morceaux retenus dans public/scores/ (+ .meta.json)
  catalog   : régénère public/scores/catalog.json à partir de public/scores/

Les fichiers de travail vont dans skill-work/ (ignoré par git). Lancer depuis la racine du dépôt.
"""
from __future__ import annotations

import argparse
import copy
import json
import re
import shutil
import subprocess
import sys
import zipfile
from dataclasses import asdict
from pathlib import Path
from xml.etree import ElementTree as ET

sys.path.insert(0, str(Path(__file__).parent))
from difficulty import analyse, read_root  # noqa: E402
from imslp import Imslp, ImslpWork, is_public_domain  # noqa: E402

WORK = Path("skill-work")
SCORES = Path("public/scores")
# Œuvres IMSLP déjà examinées (publiées ou écartées), versionné : chaque passage avance dans le catalogue.
SEEN = Path("content/imslp-seen.json")
FLUTE = re.compile(r"\b(flute|flûte|flauto|flöte|fl\.)", re.I)
DEFAULT_CATEGORIES = ["For flute", "For flute, piano", "For 2 flutes", "For flute, continuo"]


def slug(text: str) -> str:
    import unicodedata

    t = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", "-", t.lower()).strip("-")[:80]


# --- discover -----------------------------------------------------------------
def load_seen() -> set[str]:
    return set(json.loads(SEEN.read_text(encoding="utf-8"))) if SEEN.exists() else set()


def save_seen(seen: set[str]) -> None:
    SEEN.parent.mkdir(parents=True, exist_ok=True)
    SEEN.write_text(json.dumps(sorted(seen), ensure_ascii=False, indent=1) + "\n", encoding="utf-8")


def cmd_discover(args) -> None:
    """Examine jusqu'à --limit œuvres jamais vues (par catégorie) et note leurs fichiers.

    Les œuvres ne sont marquées « vues » qu'à la fin de `publish` (voir `mark_seen`) : une œuvre dont
    un téléchargement a échoué sera réessayée au passage suivant."""
    client = Imslp(delay=args.delay)
    out = WORK / "candidates.jsonl"
    out.parent.mkdir(exist_ok=True)
    done = {json.loads(l)["title"] for l in out.read_text().splitlines()} if out.exists() else set()
    seen = load_seen()
    with out.open("a", encoding="utf-8") as fh:
        for cat in args.category or DEFAULT_CATEGORIES:
            new = 0
            for title in client.category_members(cat, limit=10**6):
                if new >= args.limit:
                    break
                if title in done or title in seen:
                    continue
                try:
                    work = client.work(title)
                except Exception as exc:  # noqa: BLE001
                    print(f"  ! {title}: {exc}", file=sys.stderr)
                    continue
                row = asdict(work) | {"category": cat}
                row["has_symbolic"] = any(f["name"].lower().endswith((".mxl", ".xml", ".musicxml", ".mid", ".midi")) for f in row["files"])
                fh.write(json.dumps(row, ensure_ascii=False) + "\n")
                done.add(title)
                new += 1
                print(f"{'♪' if row['has_symbolic'] else '·'} {title}")


# --- fetch --------------------------------------------------------------------
def cmd_fetch(args) -> None:
    client = Imslp(delay=args.delay)
    print("Connexion IMSLP :", client.login(), flush=True)
    raw = WORK / "raw"
    failed: set[str] = set()
    raw.mkdir(parents=True, exist_ok=True)
    manifest = WORK / "fetched.jsonl"
    with manifest.open("a", encoding="utf-8") as fh:
        for line in (WORK / "candidates.jsonl").read_text(encoding="utf-8").splitlines():
            work = json.loads(line)
            for f in work["files"]:
                name = f["name"]
                ext = Path(name).suffix.lower()
                wanted = ext in (".mxl", ".xml", ".musicxml", ".mid", ".midi") or (args.pdf and ext == ".pdf")
                if not wanted:
                    continue
                if not (args.allow_nc or is_public_domain(f.get("copyright", ""))):
                    print(f"  ⨯ licence ignorée ({f.get('copyright') or '?'}) : {name}")
                    continue
                dest = raw / f"{slug(work['title'])}--{slug(Path(name).stem)}{ext}"
                if dest.exists():
                    continue
                try:
                    client.download(name, str(dest))
                except Exception as exc:  # noqa: BLE001
                    print(f"  ! {name}: {exc}", flush=True)
                    failed.add(work["title"])
                    continue
                fh.write(json.dumps({"path": str(dest), "work": work["title"], "url": work["url"],
                                     "composer": work["composer"], "copyright": f.get("copyright", ""),
                                     "description": f.get("description", "")}, ensure_ascii=False) + "\n")
                print(f"  ↓ {dest}", flush=True)
    (WORK / "fetch-failed.json").write_text(json.dumps(sorted(failed), ensure_ascii=False), encoding="utf-8")
    print(f"{len(failed)} œuvre(s) en échec de téléchargement (réessayées au prochain passage)")


def mark_seen() -> None:
    """Ajoute à content/imslp-seen.json les œuvres examinées ce passage, sauf celles en échec."""
    candidates = WORK / "candidates.jsonl"
    if not candidates.exists():
        return
    failed_path = WORK / "fetch-failed.json"
    failed = set(json.loads(failed_path.read_text(encoding="utf-8"))) if failed_path.exists() else set()
    titles = {json.loads(l)["title"] for l in candidates.read_text(encoding="utf-8").splitlines() if l.strip()}
    save_seen(load_seen() | (titles - failed))


# --- omr / conversions -------------------------------------------------------
def cmd_omr(args) -> None:
    exe = shutil.which("audiveris") or shutil.which("Audiveris")
    if not exe:
        sys.exit("Audiveris introuvable : installez-le (https://audiveris.github.io) ou passez --audiveris CHEMIN")
    out = WORK / "omr"
    out.mkdir(parents=True, exist_ok=True)
    for pdf in sorted((WORK / "raw").glob("*.pdf")):
        print(f"OMR {pdf.name}…")
        subprocess.run([args.audiveris or exe, "-batch", "-export", "-output", str(out), str(pdf)], check=False)


def convert_midi(args) -> None:
    mscore = shutil.which("mscore") or shutil.which("musescore") or shutil.which("mscore4")
    if not mscore:
        print("MuseScore absent : les fichiers MIDI ne seront pas convertis en MusicXML.")
        return
    for mid in list((WORK / "raw").glob("*.mid")) + list((WORK / "raw").glob("*.midi")):
        target = mid.with_suffix(".mxl")
        if not target.exists():
            subprocess.run([mscore, "-o", str(target), str(mid)], check=False)


# --- analyse ------------------------------------------------------------------
def extract_flute_part(src: Path, dest: Path) -> bool:
    """Écrit une partition à une seule partie (la flûte). False si aucune flûte trouvée."""
    root = read_root(src)
    parts = root.findall("part")
    names = {sp.get("id"): (sp.findtext("part-name") or "") + " " + (sp.findtext("score-instrument/instrument-name") or "")
             for sp in root.iter("score-part")}
    flute_ids = [pid for pid, n in names.items() if FLUTE.search(n)]
    if not flute_ids and len(parts) == 1:
        flute_ids = [parts[0].get("id")]
    if not flute_ids:
        return False
    keep = flute_ids[0]
    new = copy.deepcopy(root)
    for p in new.findall("part"):
        if p.get("id") != keep:
            new.remove(p)
    pl = new.find("part-list")
    if pl is not None:
        for el in list(pl):
            if el.tag == "score-part" and el.get("id") != keep or el.tag == "part-group":
                pl.remove(el)
    dest.write_bytes(b'<?xml version="1.0" encoding="UTF-8"?>\n' + ET.tostring(new, encoding="utf-8"))
    return True


def cmd_analyse(args) -> None:
    meta = {}
    manifest = WORK / "fetched.jsonl"
    if manifest.exists():
        for line in manifest.read_text(encoding="utf-8").splitlines():
            row = json.loads(line)
            meta[Path(row["path"]).stem] = row
    convert_midi(args)
    flutes = WORK / "flute"
    flutes.mkdir(parents=True, exist_ok=True)
    results = []
    sources = [(p, "native") for p in (WORK / "raw").glob("*") if p.suffix.lower() in (".mxl", ".xml", ".musicxml")]
    sources += [(p, "omr") for p in (WORK / "omr").glob("**/*.mxl")]
    for src, origin in sorted(sources):
        dest = flutes / f"{src.stem}.musicxml"
        try:
            if not extract_flute_part(src, dest):
                print(f"  · pas de partie de flûte : {src.name}")
                continue
            a = analyse(dest)
        except Exception as exc:  # noqa: BLE001
            print(f"  ! {src.name}: {exc}")
            continue
        m = meta.get(src.stem.split(".")[0], {})
        problems = []
        if a.low_midi < 59 or a.high_midi > 98:  # flûte en ut : Si3 (patte de si) → Ré7
            problems.append("hors tessiture de la flûte")
        if a.note_count < 8:
            problems.append("trop court")
        if a.multi_voice:
            problems.append("plusieurs voix")
        results.append(asdict(a) | {
            "id": slug(f"{a.composer}-{a.title}") or src.stem, "path": str(dest), "origin": origin,
            "sourceUrl": m.get("url"), "license": m.get("copyright") or "Domaine public",
            "imslpWork": m.get("work"), "problems": problems,
            "needsReview": origin == "omr" or bool(problems),
        })
        print(f"  ✓ niveau {a.level} ({a.complexity:3d}) {a.title} — {a.composer}{'  ⚠ ' + ', '.join(problems) if problems else ''}")
    results.sort(key=lambda r: (r["level"], r["complexity"]))
    (WORK / "analysed.json").write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"{len(results)} partitions analysées → {WORK / 'analysed.json'}")


# --- publish / catalog -------------------------------------------------------
def cmd_publish(args) -> None:
    rows = json.loads((WORK / "analysed.json").read_text(encoding="utf-8"))
    existing = {p.name.removesuffix(".meta.json") for p in SCORES.glob("*.meta.json")}
    chosen = [r for r in rows if (not args.ids or r["id"] in args.ids)
              and r["id"] not in existing
              and (args.min_level <= r["level"] <= args.max_level)
              and (args.include_review or not r["needsReview"])]
    per_level: dict[int, int] = {}
    published = []
    SCORES.mkdir(parents=True, exist_ok=True)
    for r in chosen:
        if args.per_level and per_level.get(r["level"], 0) >= args.per_level:
            continue
        per_level[r["level"]] = per_level.get(r["level"], 0) + 1
        existing.add(r["id"])
        target = SCORES / f"{r['id']}.musicxml"
        shutil.copyfile(r["path"], target)
        meta = {"id": r["id"], "title": r["title"], "composer": r["composer"], "file": target.name,
                "source": "IMSLP", "sourceUrl": r.get("sourceUrl"), "license": r["license"], "origin": r["origin"],
                "imslpWork": r.get("imslpWork")}
        (SCORES / f"{r['id']}.meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
        published.append(r)
        print(f"  → {target}")
    write_summary(published, rows)
    mark_seen()
    cmd_catalog(args)


def write_summary(published: list[dict], rows: list[dict]) -> None:
    """Résumé Markdown (corps de la pull request du robot de curation)."""
    lines = [f"**{len(published)} nouveau(x) morceau(x)** sur {len(rows)} partitions analysées.", ""]
    candidates = WORK / "candidates.jsonl"
    if candidates.exists():
        works = [json.loads(l) for l in candidates.read_text(encoding="utf-8").splitlines() if l.strip()]
        failed_path = WORK / "fetch-failed.json"
        failed = json.loads(failed_path.read_text(encoding="utf-8")) if failed_path.exists() else []
        lines += [f"{len(works)} œuvres IMSLP examinées, dont {sum(w.get('has_symbolic', False) for w in works)} "
                  f"avec un fichier numérique (MusicXML/MIDI) ; {len(failed)} en échec de téléchargement "
                  "(réessayées au prochain passage).", ""]
    if published:
        lines += ["| Niveau | Complexité | Titre | Compositeur | Tessiture | Licence | Source |",
                  "|---|---|---|---|---|---|---|"]
        for r in sorted(published, key=lambda r: (r["level"], r["complexity"])):
            src = f"[IMSLP]({r['sourceUrl']})" if r.get("sourceUrl") else "—"
            lines.append(f"| {r['level']} | {r['complexity']} | {r['title']} | {r['composer']} | "
                         f"{r['low']}–{r['high']} | {r['license']} | {src} |")
    review = [r for r in rows if r["needsReview"]]
    if review:
        lines += ["", f"<details><summary>{len(review)} partition(s) écartée(s) ou à relire</summary>", ""]
        lines += [f"- {r['title']} — {r['composer']} : {', '.join(r['problems']) or 'OMR à relire'}" for r in review]
        lines += ["", "</details>"]
    lines += ["", "**Avant de fusionner** : ouvrir l'aperçu Vercel de cette pull request, lancer « Écouter » sur chaque",
              "nouveau morceau et vérifier la licence sur IMSLP. Fermer la pull request (ou retirer un fichier) pour refuser."]
    (WORK / "summary.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


def cmd_catalog(_args) -> None:
    entries = []
    for meta_path in sorted(SCORES.glob("*.meta.json")):
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        a = analyse(SCORES / meta["file"])
        if meta.get("levelOverride"):
            a.level = int(meta["levelOverride"])
        entries.append({
            "id": meta["id"], "title": meta.get("title") or a.title, "composer": meta.get("composer") or a.composer,
            **a.catalog_fields(), "file": meta["file"], "source": meta.get("source", ""),
            "sourceUrl": meta.get("sourceUrl"), "license": meta.get("license", "Domaine public"),
            "origin": meta.get("origin", "native"), "tags": meta.get("tags", []),
        })
    entries.sort(key=lambda e: (e["level"], e["complexity"]))
    (SCORES / "catalog.json").write_text(json.dumps({"version": 1, "scores": entries}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"catalog.json : {len(entries)} morceaux")


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--delay", type=float, default=1.0, help="secondes entre deux requêtes IMSLP")
    sub = p.add_subparsers(dest="cmd", required=True)
    d = sub.add_parser("discover"); d.add_argument("--category", action="append")
    d.add_argument("--limit", type=int, default=200, help="œuvres nouvelles examinées par catégorie")
    f = sub.add_parser("fetch"); f.add_argument("--pdf", action="store_true"); f.add_argument("--allow-nc", action="store_true")
    o = sub.add_parser("omr"); o.add_argument("--audiveris")
    sub.add_parser("analyse")
    pub = sub.add_parser("publish")
    pub.add_argument("--ids", nargs="*"); pub.add_argument("--min-level", type=int, default=1)
    pub.add_argument("--max-level", type=int, default=5); pub.add_argument("--per-level", type=int, default=0)
    pub.add_argument("--include-review", action="store_true", help="publie aussi les OMR non relues (déconseillé)")
    sub.add_parser("catalog")
    args = p.parse_args()
    {"discover": cmd_discover, "fetch": cmd_fetch, "omr": cmd_omr, "analyse": cmd_analyse,
     "publish": cmd_publish, "catalog": cmd_catalog}[args.cmd](args)


if __name__ == "__main__":
    main()
