"""Tests du skill : python3 -m unittest discover -s .claude/skills/imslp-flute-curator/tests"""
import argparse
import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1] / "scripts"))
from curate import cmd_publish, extract_flute_part  # noqa: E402
from difficulty import analyse  # noqa: E402
import curate  # noqa: E402
from difficulty import read_root  # noqa: E402
from imslp import Imslp, absolute_url, check_content, is_public_domain, parse_work  # noqa: E402

ROOT = Path(__file__).parents[4]

WIKITEXT = """{{#fte:imslppage
|Instrumentation=Flute, Piano
|Composer Time Period=Baroque
}}
{{#fte:imslpfile
|File Name 1=PMLP12345-sonata.mxl
|File Description 1=Complete score (MusicXML)
|File Name 2=PMLP12345-sonata.pdf
|File Description 2=Complete score
|Copyright=Creative Commons Attribution 4.0
}}"""

DUET = """<?xml version="1.0"?><score-partwise><part-list>
<score-part id="P1"><part-name>Flute</part-name></score-part>
<score-part id="P2"><part-name>Piano</part-name></score-part></part-list>
<part id="P1"><measure number="1"><attributes><divisions>1</divisions></attributes>
<note><pitch><step>A</step><octave>4</octave></pitch><duration>1</duration></note></measure></part>
<part id="P2"><measure number="1"><note><pitch><step>C</step><octave>3</octave></pitch><duration>1</duration></note></measure></part>
</score-partwise>"""


class CuratorTest(unittest.TestCase):
    def test_parse_work(self):
        w = parse_work("Flute Sonata (Handel, George Frideric)", WIKITEXT)
        self.assertEqual(w.composer, "Handel, George Frideric")
        self.assertEqual(w.instrumentation, "Flute, Piano")
        self.assertEqual([f.name for f in w.files], ["PMLP12345-sonata.mxl", "PMLP12345-sonata.pdf"])
        self.assertTrue(w.files[0].symbolic)
        self.assertTrue(is_public_domain(w.files[0].copyright))

    def test_licences(self):
        self.assertTrue(is_public_domain("Public Domain"))
        self.assertFalse(is_public_domain("Non-PD EU"))
        self.assertFalse(is_public_domain("Creative Commons Attribution-NonCommercial 4.0"))

    def test_extract_flute_part(self):
        with tempfile.TemporaryDirectory() as d:
            src, dest = Path(d, "duo.xml"), Path(d, "flute.musicxml")
            src.write_text(DUET)
            self.assertTrue(extract_flute_part(src, dest))
            text = dest.read_text()
            self.assertIn("Flute", text)
            self.assertNotIn("Piano", text)

    def test_levels_are_ordered(self):
        easy = analyse(ROOT / "public/scores/au-clair-de-la-lune.musicxml")
        harder = analyse(ROOT / "public/scores/menuet-en-sol.musicxml")
        self.assertEqual(easy.level, 1)
        self.assertLess(easy.complexity, harder.complexity)
        self.assertEqual((easy.low, easy.high), ("Ré4", "Si4"))

    def test_pdf_helpers(self):
        from pypdf import PdfWriter

        with tempfile.TemporaryDirectory() as d:
            pdf = Path(d, "x.pdf")
            writer = PdfWriter()
            for _ in range(9):
                writer.add_blank_page(width=595, height=842)
            with pdf.open("wb") as fh:
                writer.write(fh)
            self.assertEqual(curate.pdf_page_count(pdf), 9)
            self.assertTrue(curate.truncate_pdf(pdf, 4))
            self.assertEqual(curate.pdf_page_count(pdf), 4)
            Path(d, "abime.pdf").write_bytes(b"%PDF-1.7 tronque")
            self.assertEqual(curate.pdf_page_count(Path(d, "abime.pdf")), 0)
        work = {"files": [{"name": "a.pdf", "description": "Piano part"},
                          {"name": "b.pdf", "description": "Complete Score"},
                          {"name": "c.pdf", "description": "Preface"}]}
        self.assertEqual(curate.pick_pdf(work)["name"], "b.pdf")
        self.assertIsNone(curate.pick_pdf({"files": [{"name": "x.mxl"}]}))

    def test_imslp_title(self):
        self.assertEqual(curate.imslp_title("Flute Sonata, Op.2 (Telemann, Georg Philipp)"),
                         ("Flute Sonata, Op.2", "Georg Philipp Telemann"))
        self.assertEqual(curate.imslp_title("Syrinx"), ("Syrinx", ""))

    def test_rhythm_consistency_and_titles(self):
        sample = ROOT / "public/scores/menuet-en-sol.musicxml"
        self.assertEqual(curate.rhythm_consistency(sample), 1.0)
        with tempfile.TemporaryDirectory() as d:
            broken = Path(d, "omr.musicxml")
            # Une croche « perdue » dans la 2e mesure, comme le ferait une OMR imparfaite.
            text = sample.read_text().replace("<duration>2</duration>", "<duration>1</duration>", 6)
            broken.write_text(text)
            self.assertLess(curate.rhythm_consistency(broken), 1.0)
            curate.set_titles(broken, "Menuet", "Christian Petzold")
            a = analyse(broken)
            self.assertEqual((a.title, a.composer), ("Menuet", "Christian Petzold"))

    def test_check_content(self):
        html = b"\n  <!DOCTYPE html><html><head><title>IMSLP - Please wait</title></head></html>"
        self.assertIn("Please wait", check_content("a.mxl", html))
        self.assertIn("Please wait", check_content("a.pdf", html))
        self.assertIsNone(check_content("a.pdf", b"%PDF-1.5 ..."))
        self.assertIsNone(check_content("a.mxl", b"PK\x03\x04..."))
        self.assertIsNone(check_content("a.mxl", b'<?xml version="1.0"?><score-partwise/>'))
        self.assertIsNone(check_content("a.mid", b"MThd...."))

    def test_plain_xml_mxl(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d, "plain.mxl")
            p.write_text(DUET)
            self.assertEqual(read_root(p).tag, "score-partwise")

    def test_absolute_url(self):
        self.assertEqual(absolute_url("//imslp.org/images/4/4f/X.mxl"), "https://imslp.org/images/4/4f/X.mxl")
        self.assertEqual(absolute_url("/images/X.mxl"), "https://imslp.org/images/X.mxl")
        self.assertEqual(absolute_url("https://imslp.org/X"), "https://imslp.org/X")

    def test_login_legacy_mediawiki(self):
        calls = []

        def fake_get(url, data=None):
            calls.append(data)
            if "lgtoken" not in data:
                return json.dumps({"login": {"result": "NeedToken", "token": "abc"}}).encode()
            return json.dumps({"login": {"result": "Success"}}).encode()

        client = Imslp(delay=0)
        client._get = fake_get
        os.environ.update(IMSLP_USERNAME="u", IMSLP_PASSWORD="p")
        try:
            self.assertEqual(client.login(), "OK")
            self.assertEqual(calls[1]["lgtoken"], "abc")
            client._get = lambda url, data=None: b"<html>erreur</html>"
            self.assertIn("anonyme", client.login())  # un échec n'interrompt pas la collecte
        finally:
            del os.environ["IMSLP_USERNAME"], os.environ["IMSLP_PASSWORD"]

    def test_mark_seen_skips_failed_downloads(self):
        with tempfile.TemporaryDirectory() as d:
            cwd = os.getcwd()
            os.chdir(d)
            try:
                Path("skill-work").mkdir()
                Path("skill-work/candidates.jsonl").write_text('{"title": "A"}\n{"title": "B"}\n')
                Path("skill-work/fetch-failed.json").write_text('["B"]')
                curate.mark_seen()
                self.assertEqual(json.loads(Path("content/imslp-seen.json").read_text()), ["A"])
            finally:
                os.chdir(cwd)

    def test_publish_skips_existing_and_writes_summary(self):
        sample = ROOT / "public/scores/au-clair-de-la-lune.musicxml"
        with tempfile.TemporaryDirectory() as d:
            cwd = os.getcwd()
            os.chdir(d)
            try:
                Path("public/scores").mkdir(parents=True)
                Path("skill-work").mkdir()
                shutil.copy(sample, "public/scores/deja.musicxml")
                Path("public/scores/deja.meta.json").write_text(json.dumps({"id": "deja", "file": "deja.musicxml"}))
                shutil.copy(sample, "skill-work/new.musicxml")
                row = {"title": "T", "composer": "C", "level": 1, "complexity": 3, "low": "Ré4", "high": "Si4",
                       "license": "Public Domain", "sourceUrl": "https://imslp.org/wiki/X", "origin": "native",
                       "needsReview": False, "problems": [], "path": "skill-work/new.musicxml"}
                rows = [row | {"id": "deja"}, row | {"id": "nouveau"}]
                Path("skill-work/analysed.json").write_text(json.dumps(rows))
                args = argparse.Namespace(ids=None, min_level=1, max_level=5, per_level=0, include_review=False)
                cmd_publish(args)
                summary = Path("skill-work/summary.md").read_text()
                self.assertIn("1 nouveau(x) morceau(x)", summary)
                self.assertTrue(Path("public/scores/nouveau.meta.json").exists())
                catalog = json.loads(Path("public/scores/catalog.json").read_text())
                self.assertEqual(sorted(e["id"] for e in catalog["scores"]), ["deja", "nouveau"])
            finally:
                os.chdir(cwd)


if __name__ == "__main__":
    unittest.main()
