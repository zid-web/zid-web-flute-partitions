"""Tests du skill : python3 -m unittest discover -s .claude/skills/imslp-flute-curator/tests"""
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1] / "scripts"))
from curate import extract_flute_part  # noqa: E402
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


if __name__ == "__main__":
    unittest.main()
