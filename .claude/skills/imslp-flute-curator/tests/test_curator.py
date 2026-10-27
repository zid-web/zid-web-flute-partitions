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
from imslp import is_public_domain, parse_work  # noqa: E402

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
