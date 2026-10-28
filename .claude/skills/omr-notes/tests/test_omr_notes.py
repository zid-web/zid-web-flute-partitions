"""Tests du skill : python3 -m unittest discover -s .claude/skills/omr-notes/tests"""
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1] / "scripts"))
import omr_notes  # noqa: E402


class OmrNotesTest(unittest.TestCase):
    def test_parse_pages(self):
        self.assertEqual(omr_notes.parse_pages(None, 3), [1, 2, 3])
        self.assertEqual(omr_notes.parse_pages("2-4,8,3", 10), [2, 3, 4, 8])
        self.assertEqual(omr_notes.parse_pages("5-20", 6), [5, 6])

    def test_new_files_ignores_old_results_whatever_their_name(self):
        with tempfile.TemporaryDirectory() as d:
            folder = Path(d)
            (folder / "ancien.mxl").write_text("x")
            before = omr_notes.snapshot(folder)
            time.sleep(0.01)
            # Audiveris renomme « IMSLP79333-PMLP160747-walsh.pdf » en « IMSLP79333.mxl »
            (folder / "IMSLP79333.mxl").write_text("y")
            self.assertEqual([f.name for f in omr_notes.new_files(folder, before)], ["IMSLP79333.mxl"])

    def test_split_pdf_uses_short_page_names(self):
        from pypdf import PdfWriter

        with tempfile.TemporaryDirectory() as d:
            pdf = Path(d, "IMSLP1-PMLP2-recueil.pdf")
            writer = PdfWriter()
            for _ in range(4):
                writer.add_blank_page(width=595, height=842)
            with pdf.open("wb") as fh:
                writer.write(fh)
            pages = omr_notes.split_pdf(pdf, [2, 4], Path(d, "pages"))
            self.assertEqual([p.name for p in pages], ["page02.pdf", "page04.pdf"])
            self.assertEqual(omr_notes.pdf_pages(pages[0]), 1)


if __name__ == "__main__":
    unittest.main()
