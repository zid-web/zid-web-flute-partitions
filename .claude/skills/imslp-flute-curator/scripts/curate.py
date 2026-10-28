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
from imslp import BotCheckError, Imslp, ImslpWork, is_public_domain  # noqa: E402

WORK = Path("skill-work")
SCORES = Path("public/scores")
# Œuvres IMSLP déjà examinées (publiées ou écartées), versionné : chaque passage avance dans le catalogue.
SEEN = Path("content/imslp-seen.json")
# PDF / MusicXML déposés à la main (téléchargés sur IMSLP depuis un navigateur), convertis par le robot.
INBOX = Path("content/a-convertir")
INBOX_EXTS = (".pdf", ".mxl", ".musicxml", ".xml")
FLUTE = re.compile(r"\b(flute|flûte|flauto|flöte|fl\.)", re.I)
# Accompagnement : jamais pris pour la flûte quand les parties n'ont pas de nom d'instrument (OMR).
ACCOMPANIMENT = re.compile(r"piano|keyboard|clavier|harpsi|cembal|organ|orgue|guitar|guitare|harp|basso|continuo", re.I)
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
SYMBOLIC_EXTS = (".mxl", ".xml", ".musicxml", ".mid", ".midi")
# Les PDF ne sont convertis (OMR) que pour la flûte seule : une partition avec piano ou basse continue
# donnerait une reconnaissance bien moins fiable.
OMR_CATEGORIES = {"For flute"}
SCORE_HINT = re.compile(r"complete score|full score|^score|partition|flute|flûte|flöte|flauto", re.I)
REJECT_HINT = re.compile(r"\bparts?\b(?!.*flute)|piano|cover|title|preface|commentary|manuscript", re.I)


def pdf_page_count(path: Path) -> int:
    """Nombre de pages d'un PDF (0 si inconnu). pypdf si installé : les PDF récents rangent leurs pages
    dans des flux compressés, invisibles pour une simple recherche de texte."""
    try:
        from pypdf import PdfReader

        return len(PdfReader(path).pages)
    except ImportError:
        return len(re.findall(rb"/Type\s*/Page(?![a-zA-Z])", path.read_bytes()))
    except Exception:  # noqa: BLE001 — PDF abîmé : on laisse Audiveris essayer
        return 0


def truncate_pdf(path: Path, pages: int) -> bool:
    """Garde les `pages` premières pages (recueils d'études : on reconnaît un extrait). False sans pypdf."""
    try:
        from pypdf import PdfReader, PdfWriter
    except ImportError:
        return False
    reader, writer = PdfReader(path), PdfWriter()
    for page in reader.pages[:pages]:
        writer.add_page(page)
    with path.open("wb") as fh:
        writer.write(fh)
    return True


def pick_pdf(work: dict) -> dict | None:
    """Choisit au plus un PDF par œuvre : la partition complète, pas les parties séparées ni les notices."""
    pdfs = [f for f in work["files"] if f["name"].lower().endswith(".pdf")]
    good = [f for f in pdfs if SCORE_HINT.search(f.get("description", "")) and not REJECT_HINT.search(f.get("description", ""))]
    return (good or pdfs[:1] or [None])[0]


def cmd_fetch(args) -> None:
    client = Imslp(delay=args.delay)
    status = client.login()
    print("Connexion IMSLP :", status, flush=True)
    (WORK / "login.txt").write_text(status, encoding="utf-8")
    logged_in = status.startswith("OK")
    if args.pdf and not logged_in:
        print("⚠ Sans connexion au compte, les PDF sont reportés au prochain passage.", flush=True)
    raw = WORK / "raw"
    failed: set[str] = set()
    raw.mkdir(parents=True, exist_ok=True)
    manifest = WORK / "fetched.jsonl"
    pdf_count = 0
    bot_checks = 0
    with manifest.open("a", encoding="utf-8") as fh:
        for line in (WORK / "candidates.jsonl").read_text(encoding="utf-8").splitlines():
            work = json.loads(line)
            files = [f for f in work["files"] if f["name"].lower().endswith(SYMBOLIC_EXTS)]
            if args.pdf and not files and work.get("category") in OMR_CATEGORIES:
                pdf = pick_pdf(work)
                if pdf:
                    # Sans compte, IMSLP impose une page d'attente : le téléchargement échouerait.
                    if pdf_count >= args.max_pdf or not logged_in:
                        failed.add(work["title"])  # quota atteint : l'œuvre sera reprise au passage suivant
                        continue
                    files = [pdf]
            for f in files:
                name = f["name"]
                ext = Path(name).suffix.lower()
                if not (args.allow_nc or is_public_domain(f.get("copyright", ""))):
                    print(f"  ⨯ licence ignorée ({f.get('copyright') or '?'}) : {name}")
                    continue
                dest = raw / f"{slug(work['title'])}--{slug(Path(name).stem)}{ext}"
                if dest.exists():
                    continue
                if bot_checks >= 3:
                    failed.add(work["title"])  # IMSLP refuse les robots : inutile d'insister
                    continue
                try:
                    client.download(name, str(dest))
                except BotCheckError as exc:
                    bot_checks += 1
                    print(f"  ! {name}: {exc}", flush=True)
                    failed.add(work["title"])
                    continue
                except Exception as exc:  # noqa: BLE001
                    print(f"  ! {name}: {exc}", flush=True)
                    failed.add(work["title"])
                    continue
                bot_checks = 0
                excerpt = None
                if ext == ".pdf":
                    pages = pdf_page_count(dest)
                    if pages > args.max_pages:
                        if not truncate_pdf(dest, args.max_pages):
                            print(f"  ⨯ {pages} pages (> {args.max_pages}, pypdf absent) : {name}", flush=True)
                            dest.unlink()
                            continue
                        excerpt = f"extrait, p. 1–{args.max_pages} sur {pages}"
                    print(f"  · PDF de {pages or '?'} page(s){' — ' + excerpt if excerpt else ''}", flush=True)
                    pdf_count += 1
                fh.write(json.dumps({"path": str(dest), "work": work["title"], "url": work["url"],
                                     "composer": work["composer"], "copyright": f.get("copyright", ""),
                                     "description": f.get("description", ""), "excerpt": excerpt},
                                    ensure_ascii=False) + "\n")
                print(f"  ↓ {dest}", flush=True)
    if bot_checks >= 3:
        print("⚠ IMSLP renvoie sa page anti-robot (« Bot Check ») : téléchargements arrêtés.", flush=True)
        (WORK / "bot-check.txt").write_text("1", encoding="utf-8")
    (WORK / "fetch-failed.json").write_text(json.dumps(sorted(failed), ensure_ascii=False), encoding="utf-8")
    print(f"{pdf_count} PDF à reconnaître ; {len(failed)} œuvre(s) reportée(s) ou en échec (reprises au prochain passage)")


def mark_seen() -> None:
    """Ajoute à content/imslp-seen.json les œuvres examinées ce passage, sauf celles en échec."""
    candidates = WORK / "candidates.jsonl"
    if not candidates.exists():
        return
    failed_path = WORK / "fetch-failed.json"
    failed = set(json.loads(failed_path.read_text(encoding="utf-8"))) if failed_path.exists() else set()
    titles = {json.loads(l)["title"] for l in candidates.read_text(encoding="utf-8").splitlines() if l.strip()}
    save_seen(load_seen() | (titles - failed))


# --- dépôt manuel (content/a-convertir) ---------------------------------------
def inbox_files() -> list[Path]:
    return sorted(p for p in INBOX.glob("*") if p.is_file() and p.suffix.lower() in INBOX_EXTS)


def title_from_filename(stem: str) -> tuple[str, str]:
    """« Telemann - Fantaisie n°1 » → (« Fantaisie n°1 », « Telemann ») ; sinon (nom du fichier, "")."""
    stem = re.sub(r"[_]+", " ", stem).strip()
    stem = re.sub(r"^(IMSLP\d+-)?PMLP\d+-", "", stem, flags=re.I).strip()  # nom de fichier IMSLP : IMSLP123-PMLP45-titre
    if " - " in stem:
        composer, title = stem.split(" - ", 1)
        return title.strip(), composer.strip()
    return stem, ""


def cmd_inbox(args) -> None:
    """Prépare les fichiers déposés dans content/a-convertir pour omr → analyse → publish."""
    raw = WORK / "raw"
    raw.mkdir(parents=True, exist_ok=True)
    files = inbox_files()
    processed = []
    with (WORK / "fetched.jsonl").open("a", encoding="utf-8") as fh:
        for src in files:
            title, composer = title_from_filename(src.stem)
            ext = src.suffix.lower()
            dest = raw / f"{slug(src.stem) or 'partition'}{ext}"
            shutil.copyfile(src, dest)
            excerpt = None
            if ext == ".pdf":
                pages = pdf_page_count(dest)
                if pages > args.max_pages and truncate_pdf(dest, args.max_pages):
                    excerpt = f"extrait, p. 1–{args.max_pages} sur {pages}"
            work = f"{title} ({composer})" if composer else title
            fh.write(json.dumps({"path": str(dest), "work": work, "url": None, "composer": composer,
                                 "copyright": "À vérifier (déposé dans content/a-convertir)",
                                 "description": src.name, "excerpt": excerpt,
                                 "source": "Dépôt manuel (content/a-convertir)"}, ensure_ascii=False) + "\n")
            processed.append({"file": src.name, "stem": dest.stem})
            print(f"  ← {src.name}{' (' + excerpt + ')' if excerpt else ''}", flush=True)
    (WORK / "inbox.json").write_text(json.dumps(processed, ensure_ascii=False), encoding="utf-8")
    print(f"{len(processed)} fichier(s) déposé(s) à convertir")


def cmd_inbox_clean(_args) -> None:
    """Retire du dossier de dépôt les fichiers convertis (la pull request les supprime) ; les autres
    vont dans content/a-convertir/non-reconnus/ pour ne pas être perdus ni retraités à chaque dépôt."""
    done = WORK / "inbox.json"
    for item in json.loads(done.read_text(encoding="utf-8")) if done.exists() else []:
        src = INBOX / item["file"]
        if not src.exists():
            continue
        if item.get("status") == "ok":
            src.unlink()
        else:
            (INBOX / "non-reconnus").mkdir(exist_ok=True)
            src.replace(INBOX / "non-reconnus" / item["file"])


# --- omr / conversions -------------------------------------------------------
def find_audiveris(explicit: str | None) -> str | None:
    candidates = [explicit, shutil.which("audiveris"), shutil.which("Audiveris")]
    candidates += sorted(str(p) for p in Path("/opt").glob("*/bin/[Aa]udiveris*"))
    return next((c for c in candidates if c and Path(c).exists()), None)


def run_audiveris(exe: str, inputs: list[Path], out: Path, timeout: int) -> None:
    out.mkdir(parents=True, exist_ok=True)
    try:
        subprocess.run([exe, "-batch", "-export", "-output", str(out), "--", *map(str, inputs)],
                       check=False, timeout=timeout)
    except subprocess.TimeoutExpired:
        print(f"  ! délai dépassé ({timeout} s)", flush=True)


def split_pdf(pdf: Path, dest: Path) -> list[Path]:
    """Une page par fichier (p01.pdf, p02.pdf…). Liste vide sans pypdf."""
    try:
        from pypdf import PdfReader, PdfWriter
    except ImportError:
        return []
    dest.mkdir(parents=True, exist_ok=True)
    pages = []
    for i, page in enumerate(PdfReader(pdf).pages, 1):
        writer = PdfWriter()
        writer.add_page(page)
        target = dest / f"p{i:02d}.pdf"
        with target.open("wb") as fh:
            writer.write(fh)
        pages.append(target)
    return pages


def merge_pages(pages: list[Path], dest: Path) -> int:
    """Met bout à bout la partie de flûte de chaque page (ou morceau) reconnu. Renvoie le nombre gardé."""
    merged = None
    kept = 0
    for page in pages:
        try:
            root = read_root(page)
        except Exception:  # noqa: BLE001 — page illisible : on l'ignore
            continue
        pid = pick_flute_part(root, omr=True)
        part = next((p for p in root.findall("part") if p.get("id") == pid), None)
        if part is None or part.find(".//note/pitch") is None:
            continue  # page de titre, préface, page sans flûte
        kept += 1
        if merged is None:
            merged = copy.deepcopy(root)
            for p in merged.findall("part"):
                if p.get("id") != pid:
                    merged.remove(p)
            pl = merged.find("part-list")
            for el in list(pl if pl is not None else []):
                if el.tag != "score-part" or el.get("id") != pid:
                    pl.remove(el)
            target = merged.find("part")
        else:
            for measure in part.findall("measure"):
                target.append(copy.deepcopy(measure))
    if merged is None:
        return 0
    for i, measure in enumerate(target.findall("measure"), 1):
        measure.set("number", str(i))
    dest.write_bytes(b'<?xml version="1.0" encoding="UTF-8"?>\n' + ET.tostring(merged, encoding="utf-8"))
    return kept


def cmd_omr(args) -> None:
    exe = find_audiveris(args.audiveris)
    if not exe:
        sys.exit("Audiveris introuvable : installez-le (https://audiveris.github.io) ou passez --audiveris CHEMIN")
    out = WORK / "omr"
    out.mkdir(parents=True, exist_ok=True)
    for pdf in sorted((WORK / "raw").glob("*.pdf")):
        print(f"OMR {pdf.name}…", flush=True)
        run_audiveris(exe, [pdf], out, args.timeout)
        if any(out.glob(f"{pdf.stem}*.mxl")):
            continue
        # Une seule page illisible (titre, scan abîmé) fait échouer l'export de tout le recueil
        # (« Error in export ») : on reconnaît alors page par page et on garde les pages réussies.
        pages = split_pdf(pdf, WORK / "omr-pages" / pdf.stem)
        if len(pages) < 2:
            continue
        print(f"  export du recueil impossible : reconnaissance page par page ({len(pages)} pages)…", flush=True)
        page_out = WORK / "omr-pages" / pdf.stem / "mxl"
        run_audiveris(exe, pages, page_out, args.timeout)
        found = sorted(page_out.glob("p*.mxl"))
        kept = merge_pages(found, out / f"{pdf.stem}.mxl")
        recognised = len({f.name.split(".")[0] for f in found})  # une page peut contenir plusieurs morceaux
        print(f"  {recognised} page(s) reconnue(s) sur {len(pages)} ({len(found)} morceau(x), {kept} gardé(s) avec de la flûte)",
              flush=True)
    found = sorted(p.name for p in out.glob("*.mxl"))
    print(f"{len(found)} partition(s) reconnue(s) : {', '.join(found) or '—'}")


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
def pick_flute_part(root: ET.Element, omr: bool = False) -> str | None:
    """Identifiant de la partie de flûte, ou None. Audiveris ne connaît pas les instruments (il nomme
    les portées « Voice », « Piano »…) : pour une OMR, on prend la première partie à une seule portée
    qui n'est pas un accompagnement — la flûte (ou la 1ʳᵉ flûte d'un duo) est écrite en haut."""
    parts = root.findall("part")
    names = {sp.get("id"): (sp.findtext("part-name") or "") + " " + (sp.findtext("score-instrument/instrument-name") or "")
             for sp in root.iter("score-part")}
    flute_ids = [pid for pid, n in names.items() if FLUTE.search(n)]
    if flute_ids:
        return flute_ids[0]
    if len(parts) == 1:
        return parts[0].get("id")
    if omr:
        for part in parts:
            staves = {s.text for s in part.iter("staves")}
            if not ACCOMPANIMENT.search(names.get(part.get("id"), "")) and staves <= {"1"}:
                return part.get("id")
    return None


def extract_flute_part(src: Path, dest: Path, omr: bool = False) -> bool:
    """Écrit une partition à une seule partie (la flûte). False si aucune flûte trouvée."""
    root = read_root(src)
    keep = pick_flute_part(root, omr)
    if not keep:
        return False
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


OMR_MIN_RHYTHM = 0.85


def rhythm_consistency(path: Path) -> float:
    """Part des mesures dont la durée correspond à la signature rythmique (1.0 = parfait).

    Indicateur de qualité de l'OMR : une note ou un silence mal reconnu « casse » la mesure.
    La première et la dernière mesure (anacrouse) sont ignorées.
    """
    root = read_root(path)
    part = root.find("part")
    if part is None:
        return 0.0
    divisions, expected = 1, None
    checked = ok = 0
    measures = part.findall("measure")
    for i, measure in enumerate(measures):
        attrs = measure.find("attributes")
        if attrs is not None:
            divisions = int(attrs.findtext("divisions") or divisions)
            if attrs.find("time/beats") is not None:
                beats = sum(int(b) for b in attrs.findtext("time/beats").split("+"))
                expected = beats * 4 / int(attrs.findtext("time/beat-type"))
        if expected is None or i in (0, len(measures) - 1):
            continue
        per_voice: dict[str, float] = {}
        for note in measure.findall("note"):
            if note.find("chord") is not None or note.find("grace") is not None:
                continue
            voice = note.findtext("voice") or "1"
            per_voice[voice] = per_voice.get(voice, 0) + int(note.findtext("duration") or 0) / divisions
        if not per_voice:
            continue
        checked += 1
        ok += abs(max(per_voice.values()) - expected) < 1e-6
    return round(ok / checked, 3) if checked else 0.0


def imslp_title(work_title: str) -> tuple[str, str]:
    """« Sonate, Op.2 (Telemann, Georg Philipp) » → (« Sonate, Op.2 », « Georg Philipp Telemann »)."""
    m = re.match(r"^(.*)\s+\(([^()]*)\)\s*$", work_title)
    if not m:
        return work_title, ""
    title, composer = m.group(1), m.group(2)
    if "," in composer:
        last, first = (x.strip() for x in composer.split(",", 1))
        composer = f"{first} {last}"
    return title, composer


def set_titles(path: Path, title: str, composer: str) -> None:
    """Remplace titre et compositeur (l'OMR met souvent le nom du fichier)."""
    root = read_root(path)
    work = root.find("work")
    if work is None:
        work = ET.Element("work")
        root.insert(0, work)
    (work.find("work-title") if work.find("work-title") is not None else ET.SubElement(work, "work-title")).text = title
    for mt in root.findall("movement-title"):
        root.remove(mt)
    ident = root.find("identification")
    if ident is None:
        ident = ET.Element("identification")
        root.insert(1, ident)
    creator = next((c for c in ident.findall("creator") if c.get("type") == "composer"), None)
    if creator is None:
        creator = ET.SubElement(ident, "creator", type="composer")
    creator.text = composer
    path.write_bytes(b'<?xml version="1.0" encoding="UTF-8"?>\n' + ET.tostring(root, encoding="utf-8"))


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
    sources += [(p, "omr") for p in (WORK / "omr").glob("*.mxl")]
    for src, origin in sorted(sources):
        dest = flutes / f"{src.stem}.musicxml"
        m = meta.get(src.stem.split(".")[0], {})
        try:
            if not extract_flute_part(src, dest, omr=origin == "omr"):
                print(f"  · pas de partie de flûte : {src.name}")
                continue
            if m.get("work"):
                title, composer = imslp_title(m["work"])
                set_titles(dest, f"{title} ({m['excerpt']})" if m.get("excerpt") else title, composer)
            a = analyse(dest)
        except Exception as exc:  # noqa: BLE001
            print(f"  ! {src.name}: {exc}")
            continue
        problems = []
        rhythm = rhythm_consistency(dest)
        if origin == "omr" and rhythm < OMR_MIN_RHYTHM:
            problems.append(f"reconnaissance incertaine ({round(rhythm * 100)} % de mesures justes)")
        if a.low_midi < 59 or a.high_midi > 98:  # flûte en ut : Si3 (patte de si) → Ré7
            problems.append("hors tessiture de la flûte")
        if a.note_count < 8:
            problems.append("trop court")
        if a.multi_voice:
            problems.append("plusieurs voix")
        results.append(asdict(a) | {
            "id": slug(f"{a.composer}-{a.title}") or src.stem, "path": str(dest), "origin": origin,
            "sourceUrl": m.get("url"), "license": m.get("copyright") or "Domaine public",
            "imslpWork": m.get("work"), "problems": problems, "rhythm": rhythm, "source": m.get("source", "IMSLP"),
            "needsReview": bool(problems),
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
                "source": r.get("source", "IMSLP"), "sourceUrl": r.get("sourceUrl"), "license": r["license"], "origin": r["origin"],
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
    login = WORK / "login.txt"
    if login.exists():
        status = login.read_text(encoding="utf-8")
        lines += [f"Connexion au compte IMSLP : {status}." + ("" if status.startswith("OK") else
                  " ⚠️ **Les PDF n'ont pas pu être téléchargés** (IMSLP impose une attente sans compte) : "
                  "vérifier les secrets IMSLP_USERNAME / IMSLP_PASSWORD puis relancer."), ""]
    if (WORK / "bot-check.txt").exists():
        lines += ["⚠️ **IMSLP bloque les téléchargements automatiques** (page « Bot Check ») : déposer les PDF voulus "
                  "dans `content/a-convertir/` (voir son README), le robot les convertit.", ""]
    candidates = WORK / "candidates.jsonl"
    if candidates.exists():
        works = [json.loads(l) for l in candidates.read_text(encoding="utf-8").splitlines() if l.strip()]
        failed_path = WORK / "fetch-failed.json"
        failed = json.loads(failed_path.read_text(encoding="utf-8")) if failed_path.exists() else []
        pdfs = len(list((WORK / "raw").glob("*.pdf"))) if (WORK / "raw").exists() else 0
        lines += [f"{len(works)} œuvres IMSLP examinées, dont {sum(w.get('has_symbolic', False) for w in works)} "
                  f"avec un fichier numérique (MusicXML/MIDI) ; {pdfs} PDF envoyé(s) à la reconnaissance (OMR) ; "
                  f"{len(failed)} œuvre(s) reportée(s) ou en échec (reprises au prochain passage).", ""]
    if published:
        lines += ["| Niveau | Complexité | Titre | Compositeur | Tessiture | Origine | Licence | Source |",
                  "|---|---|---|---|---|---|---|---|"]
        for r in sorted(published, key=lambda r: (r["level"], r["complexity"])):
            src = f"[IMSLP]({r['sourceUrl']})" if r.get("sourceUrl") else "—"
            origin = (f"🔍 reconnue ({round(r.get('rhythm', 0) * 100)} % mesures justes)"
                      if r["origin"] == "omr" else "MusicXML")
            lines.append(f"| {r['level']} | {r['complexity']} | {r['title']} | {r['composer']} | "
                         f"{r['low']}–{r['high']} | {origin} | {r['license']} | {src} |")
    inbox = WORK / "inbox.json"
    if inbox.exists():
        items = json.loads(inbox.read_text(encoding="utf-8"))
        if items:
            lines += ["", "### Fichiers déposés dans `content/a-convertir`", ""]
            for item in items:
                mine = [r for r in rows if Path(r["path"]).stem.split(".")[0] == item["stem"]]
                ok = [r for r in mine if r in published]
                item["status"] = "ok" if ok else "rejected" if mine else "failed"
                if ok:
                    lines.append(f"- ✅ {item['file']} → « {ok[0]['title']} », niveau {ok[0]['level']}"
                                 + (f", {round(ok[0].get('rhythm', 0) * 100)} % de mesures justes" if ok[0]["origin"] == "omr" else ""))
                elif mine:
                    lines.append(f"- ⚠️ {item['file']} : écarté ({', '.join(mine[0]['problems']) or 'déjà au catalogue'})")
                else:
                    lines.append(f"- ❌ {item['file']} : non reconnu (scan illisible, ou pas de partie de flûte)")
            inbox.write_text(json.dumps(items, ensure_ascii=False), encoding="utf-8")
            lines += ["", "Les fichiers convertis sont retirés du dossier par cette pull request ; les autres sont rangés "
                      "dans `content/a-convertir/non-reconnus/` (à corriger dans Audiveris ou MuseScore puis à redéposer "
                      "en .mxl). Licence à vérifier sur la page IMSLP de chaque œuvre (domaine public ou Creative Commons)."]
    review = [r for r in rows if r["needsReview"]]
    if review:
        lines += ["", f"<details><summary>{len(review)} partition(s) écartée(s)</summary>", ""]
        lines += [f"- {r['title']} — {r['composer']} : {', '.join(r['problems'])}" for r in review]
        lines += ["", "</details>"]
    lines += ["", "**Avant de fusionner** : ouvrir l'aperçu Vercel de cette pull request et lancer « Écouter » sur chaque",
              "nouveau morceau. Les morceaux 🔍 viennent d'un PDF scanné : comparer avec le PDF IMSLP (lien Source),",
              "une fausse note s'entend souvent. Pour refuser un morceau, supprimer ses deux fichiers",
              "`public/scores/<id>.*` dans la pull request ; pour tout refuser, fermer la pull request."]
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
    f = sub.add_parser("fetch"); f.add_argument("--allow-nc", action="store_true")
    f.add_argument("--pdf", action="store_true", help="télécharge aussi un PDF par œuvre pour flûte seule (pour l'OMR)")
    f.add_argument("--max-pdf", type=int, default=8, help="PDF au maximum par passage")
    f.add_argument("--max-pages", type=int, default=6, help="pages au maximum par PDF")
    o = sub.add_parser("omr"); o.add_argument("--audiveris")
    o.add_argument("--timeout", type=int, default=900, help="secondes au maximum par PDF")
    sub.add_parser("analyse")
    pub = sub.add_parser("publish")
    pub.add_argument("--ids", nargs="*"); pub.add_argument("--min-level", type=int, default=1)
    pub.add_argument("--max-level", type=int, default=5); pub.add_argument("--per-level", type=int, default=0)
    pub.add_argument("--include-review", action="store_true", help="publie aussi les OMR non relues (déconseillé)")
    sub.add_parser("catalog")
    ib = sub.add_parser("inbox", help="prépare les fichiers déposés dans content/a-convertir")
    ib.add_argument("--max-pages", type=int, default=12)
    sub.add_parser("inbox-clean", help="retire de content/a-convertir les fichiers traités")
    args = p.parse_args()
    {"discover": cmd_discover, "fetch": cmd_fetch, "omr": cmd_omr, "analyse": cmd_analyse,
     "publish": cmd_publish, "catalog": cmd_catalog,
     "inbox": cmd_inbox, "inbox-clean": cmd_inbox_clean}[args.cmd](args)


if __name__ == "__main__":
    main()
