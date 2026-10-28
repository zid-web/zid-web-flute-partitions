#!/usr/bin/env python3
"""Partition scannée (PDF ou image) → MusicXML (.mxl) → MuseScore (.mscz) + PDF de contrôle.

    python3 .claude/skills/omr-notes/scripts/omr_notes.py check
    python3 .claude/skills/omr-notes/scripts/omr_notes.py run partition.pdf [--sortie DOSSIER]
        [--pages 2-5] [--audiveris CHEMIN] [--mscore CHEMIN] [--pas-de-musescore]

Résultats : skill-work/omr-notes/<nom>/ (ignoré par git), un sous-dossier par étape :
  musicxml/  les .mxl d'Audiveris (un par morceau ; page par page si le recueil échoue)
  musescore/ les mêmes en .mscz, et un .pdf de chaque pour comparer avec l'original
"""
from __future__ import annotations

import argparse
import os
import platform
import shutil
import subprocess
import sys
from pathlib import Path

IMAGES = {".png", ".jpg", ".jpeg", ".tif", ".tiff", ".bmp"}
AUDIVERIS = {
    "Darwin": ["/Applications/Audiveris.app/Contents/MacOS/Audiveris",
               str(Path.home() / "Applications/Audiveris.app/Contents/MacOS/Audiveris")],
    "Windows": [r"C:\Program Files\Audiveris\Audiveris.exe", r"C:\Program Files\Audiveris\bin\Audiveris.bat"],
    "Linux": ["/opt/audiveris/bin/Audiveris", *sorted(str(p) for p in Path("/opt").glob("*/bin/[Aa]udiveris*"))],
}
MUSESCORE = {
    "Darwin": ["/Applications/MuseScore 4.app/Contents/MacOS/mscore",
               "/Applications/MuseScore 3.app/Contents/MacOS/mscore"],
    "Windows": [r"C:\Program Files\MuseScore 4\bin\MuseScore4.exe", r"C:\Program Files\MuseScore 3\bin\MuseScore3.exe"],
    "Linux": [],
}


def find(explicit: str | None, names: list[str], known: dict[str, list[str]]) -> str | None:
    candidates = [explicit, *(shutil.which(n) for n in names), *known.get(platform.system(), [])]
    return next((c for c in candidates if c and Path(c).exists()), None)


def find_audiveris(explicit: str | None = None) -> str | None:
    return find(explicit, ["audiveris", "Audiveris"], AUDIVERIS)


def find_musescore(explicit: str | None = None) -> str | None:
    return find(explicit, ["mscore", "mscore4", "musescore", "mscore3", "musescore3", "MuseScore4"], MUSESCORE)


def headless_env() -> dict[str, str]:
    """Sans écran (serveur, CI), MuseScore a besoin de Qt « offscreen »."""
    env = dict(os.environ)
    if platform.system() == "Linux" and not env.get("DISPLAY"):
        env.setdefault("QT_QPA_PLATFORM", "offscreen")
    return env


def audiveris_cmd(exe: str) -> list[str]:
    # Sous Linux sans écran, Audiveris (Java) a besoin d'un écran virtuel.
    if platform.system() == "Linux" and not os.environ.get("DISPLAY") and shutil.which("xvfb-run"):
        return ["xvfb-run", "-a", exe]
    return [exe]


def parse_pages(spec: str | None, total: int) -> list[int]:
    """« 2-5,8 » → [2, 3, 4, 5, 8] (numéros à partir de 1, bornés au nombre de pages)."""
    if not spec:
        return list(range(1, total + 1))
    pages: list[int] = []
    for part in spec.split(","):
        a, _, b = part.strip().partition("-")
        lo, hi = int(a), int(b or a)
        pages += [p for p in range(lo, hi + 1) if 1 <= p <= total and p not in pages]
    return pages


def new_files(folder: Path, before: dict[Path, float], pattern: str = "*.mxl") -> list[Path]:
    """Fichiers créés ou modifiés depuis `before` : Audiveris peut renommer sa sortie
    (règle d'alias « IMSLP79333-PMLP…pdf » → « IMSLP79333.mxl »), on ne devine donc pas le nom."""
    return sorted(f for f in folder.glob(pattern) if before.get(f) != f.stat().st_mtime)


def snapshot(folder: Path, pattern: str = "*.mxl") -> dict[Path, float]:
    return {f: f.stat().st_mtime for f in folder.glob(pattern)} if folder.exists() else {}


def run_audiveris(exe: str, inputs: list[Path], out: Path, timeout: int) -> None:
    out.mkdir(parents=True, exist_ok=True)
    cmd = [*audiveris_cmd(exe), "-batch", "-export", "-output", str(out), "--", *map(str, inputs)]
    print(f"→ Audiveris : {len(inputs)} fichier(s)", flush=True)
    try:
        subprocess.run(cmd, check=False, timeout=timeout, stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT)
    except subprocess.TimeoutExpired:
        print(f"  ! délai dépassé ({timeout} s)", flush=True)


def split_pdf(pdf: Path, pages: list[int], dest: Path) -> list[Path]:
    from pypdf import PdfReader, PdfWriter

    dest.mkdir(parents=True, exist_ok=True)
    reader = PdfReader(pdf)
    files = []
    for n in pages:
        writer = PdfWriter()
        writer.add_page(reader.pages[n - 1])
        target = dest / f"page{n:02d}.pdf"  # nom court : pas de renommage par Audiveris
        with target.open("wb") as fh:
            writer.write(fh)
        files.append(target)
    return files


def pdf_pages(pdf: Path) -> int:
    from pypdf import PdfReader

    return len(PdfReader(pdf).pages)


def omr(src: Path, out: Path, exe: str, pages_spec: str | None, timeout: int) -> list[Path]:
    """Reconnaissance : le fichier entier d'abord, puis page par page si l'export échoue."""
    musicxml = out / "musicxml"
    if src.suffix.lower() in IMAGES:
        before = snapshot(musicxml)
        run_audiveris(exe, [src], musicxml, timeout)
        return new_files(musicxml, before)
    try:
        total = pdf_pages(src)
    except ImportError:
        total = 0
    if pages_spec and not total:
        sys.exit("--pages demande pypdf : pip3 install pypdf")
    if not pages_spec:
        before = snapshot(musicxml)
        run_audiveris(exe, [src], musicxml, timeout)
        found = new_files(musicxml, before)
        if found or total < 2:
            if not found and not total:
                print("  (installez pypdf pour réessayer page par page : pip3 install pypdf)")
            return found
        print("  L'export du fichier entier a échoué (souvent une page illisible) : reconnaissance page par page.")
    pages = split_pdf(src, parse_pages(pages_spec, total), out / "pages")
    before = snapshot(musicxml)
    run_audiveris(exe, pages, musicxml, timeout)
    return new_files(musicxml, before)


def to_musescore(mscore: str, files: list[Path], out: Path) -> list[Path]:
    dest = out / "musescore"
    dest.mkdir(parents=True, exist_ok=True)
    made = []
    for mxl in files:
        for ext in (".mscz", ".pdf"):
            target = dest / f"{mxl.stem}{ext}"
            r = subprocess.run([mscore, "-o", str(target), str(mxl)], env=headless_env(), check=False,
                               timeout=300, capture_output=True, text=True)
            if target.exists():
                made.append(target)
            else:
                print(f"  ! MuseScore n'a pas pu créer {target.name} : {(r.stderr or r.stdout).strip()[-300:]}")
    return made


def cmd_check(args) -> int:
    a = find_audiveris(args.audiveris)
    m = find_musescore(args.mscore)
    print(f"Audiveris : {a or '❌ introuvable (https://github.com/Audiveris/audiveris/releases)'}")
    print(f"MuseScore : {m or '❌ introuvable (https://musescore.org)'}")
    try:
        import pypdf  # noqa: F401
        print("pypdf     : ✅ (reconnaissance page par page)")
    except ImportError:
        print("pypdf     : ⚠️ absent — pip3 install pypdf (utile pour les recueils PDF)")
    if platform.system() == "Linux" and not os.environ.get("DISPLAY"):
        print(f"xvfb-run  : {'✅' if shutil.which('xvfb-run') else '⚠️ absent (Audiveris sans écran)'}")
    return 0 if a else 1


def cmd_run(args) -> int:
    src = Path(args.fichier).expanduser().resolve()
    if not src.exists():
        sys.exit(f"Fichier introuvable : {src}")
    if src.suffix.lower() not in IMAGES | {".pdf"}:
        sys.exit("Formats acceptés : PDF, PNG, JPG, TIFF, BMP")
    exe = find_audiveris(args.audiveris)
    if not exe:
        sys.exit("Audiveris introuvable : https://github.com/Audiveris/audiveris/releases (ou --audiveris CHEMIN)")
    out = Path(args.sortie).expanduser().resolve() if args.sortie else Path("skill-work/omr-notes").resolve() / src.stem
    print(f"Partition : {src}\nSortie    : {out}")

    found = omr(src, out, exe, args.pages, args.timeout)
    if not found:
        print("\n❌ Aucune page reconnue : scan trop abîmé ? Essayez l'interface d'Audiveris.")
        return 1
    made: list[Path] = []
    if not args.pas_de_musescore:
        mscore = find_musescore(args.mscore)
        if mscore:
            print(f"→ MuseScore : {len(found)} fichier(s)", flush=True)
            made = to_musescore(mscore, found, out)
        else:
            print("  (MuseScore introuvable : pas de .mscz ; ouvrez les .mxl dans MuseScore)")

    print(f"\n✅ {len(found)} fichier(s) MusicXML :")
    for f in found:
        print(f"   {f}")
    if made:
        print(f"✅ {len(made)} fichier(s) MuseScore / PDF de contrôle :")
        for f in made:
            print(f"   {f}")
    print("\nÀ relire dans MuseScore (rythmes, armure, signature) avant de déposer le .mxl corrigé "
          "dans content/a-convertir/.")
    return 0


def main() -> None:
    p = argparse.ArgumentParser(description="OMR (Audiveris) → MusicXML → MuseScore")
    p.add_argument("--audiveris", help="chemin de l'exécutable Audiveris")
    p.add_argument("--mscore", help="chemin de l'exécutable MuseScore")
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("check", help="vérifie Audiveris, MuseScore et pypdf")
    r = sub.add_parser("run", help="traite une partition")
    r.add_argument("fichier", help="PDF ou image de la partition")
    r.add_argument("--sortie", help="dossier de sortie (défaut : skill-work/omr-notes/<nom>)")
    r.add_argument("--pages", help="pages à reconnaître, ex. 2-5,8 (PDF)")
    r.add_argument("--timeout", type=int, default=1800, help="secondes au maximum par passage d'Audiveris")
    r.add_argument("--pas-de-musescore", action="store_true", help="s'arrêter au MusicXML")
    args = p.parse_args()
    sys.exit({"check": cmd_check, "run": cmd_run}[args.cmd](args))


if __name__ == "__main__":
    main()
