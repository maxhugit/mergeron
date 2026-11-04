import os
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from office_common import checked_path, preflight
from normalize_excel_source import normalize
from create_excel_pivot import create
from validate_office import validate
from render_office import render
from fixtures import make_fixtures


class OfficeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="office-tests-")
        self.root = Path(self.temp.name)
        make_fixtures(self.root)

    def tearDown(self):
        self.temp.cleanup()

    def test_normalize_and_types(self):
        from openpyxl import load_workbook

        out = self.root / "normalized.xlsx"
        result = normalize(self.root / "source.xlsx", out, ["Tags"])
        self.assertEqual(result["rows"], 4)
        w = load_workbook(out)
        rows = list(w.active.values)
        w.close()
        self.assertEqual(
            rows[1:],
            [("Nord", "A", 10), ("Nord", "B", 10), ("Sud", "B", 20), ("Nord", "A", 5)],
        )
        self.assertRaises(
            ValueError, normalize, out, self.root / "bad.xlsx", ["Missing"]
        )

    def test_paths_and_symlinks(self):
        self.assertRaises(ValueError, checked_path, "/etc/passwd", [self.root])
        (self.root / "escape").symlink_to("/etc/passwd")
        self.assertRaises(ValueError, checked_path, self.root / "escape", [self.root])
        self.assertRaises(
            ValueError, checked_path, self.root / "source.xlsx", [self.root], True
        )

    def test_active_content_is_rejected_before_conversion(self):
        for name, data in [
            ("xl/vbaProject.bin", b"fake macro"),
            ("xl/macrosheets/sheet1.xml", b"<x/>"),
            ("xl/embeddings/oleObject1.bin", b"fake OLE"),
            (
                "xl/_rels/external.rels",
                b'<Relationships><Relationship TargetMode="External" Target="http://example.invalid"/></Relationships>',
            ),
            ("xl/dde.xml", b"<x><instrText>DDEAUTO cmd</instrText></x>"),
            ("xl/connections.xml", b"<connections/>"),
            (
                "xl/entity.xml",
                b'<!DOCTYPE x [<!ENTITY x SYSTEM "file:///etc/passwd">]><x>&x;</x>',
            ),
        ]:
            bad = self.root / "bad.xlsx"
            shutil.copy(self.root / "source.xlsx", bad)
            with zipfile.ZipFile(bad, "a") as z:
                z.writestr(name, data)
            with patch("render_office.run") as run:
                self.assertRaises(ValueError, render, bad, self.root / "never-created")
                run.assert_not_called()
        self.assertFalse((self.root / "never-created").exists())

    def test_success_exit_without_pdf_is_failure(self):
        with patch("render_office.run"):
            self.assertRaises(
                ValueError, render, self.root / "word.docx", self.root / "no-pdf"
            )
        self.assertTrue((self.root / "no-pdf" / "FAILED.txt").is_file())

    def test_validate_all_formats(self):
        for name in ["source.xlsx", "word.docx", "slides.pptx"]:
            self.assertTrue(validate(self.root / name)["ok"])
        self.assertRaises(
            ValueError, validate, self.root / "source.xlsx", require_pivot=True
        )

    def test_native_pivot_chart_and_cache(self):
        out = self.root / "pivot.xlsx"
        report = create(
            self.root / "source.xlsx",
            out,
            ["Region"],
            ["Amount"],
            ["Tags"],
            allow_evaluation=True,
        )
        self.assertEqual(report["pivots"][0]["rows"], ["Region"])
        self.assertEqual(report["pivots"][0]["columns"], ["Tags"])
        self.assertGreaterEqual(report["pivotCharts"], 1)
        self.assertRaises(
            ValueError, validate, out, expected_rows=["Wrong"], require_pivot=True
        )
        with zipfile.ZipFile(out) as z:
            cache = report["pivots"][0]["cache"]
            broken = self.root / "broken.xlsx"
            with zipfile.ZipFile(broken, "w") as target:
                for name in z.namelist():
                    if name != cache:
                        target.writestr(name, z.read(name))
        with self.assertRaises(Exception):
            validate(broken, require_pivot=True)

    def test_missing_license_fails_closed(self):
        with patch.dict(
            os.environ, {"ASPOSE_CELLS_LICENSE_FILE": str(self.root / "missing.lic")}
        ):
            self.assertRaises(
                ValueError,
                create,
                self.root / "source.xlsx",
                self.root / "unlicensed.xlsx",
                ["Region"],
                ["Amount"],
            )
        self.assertFalse((self.root / "unlicensed.xlsx").exists())

    def test_real_pdf_and_png_all_formats(self):
        from pypdf import PdfReader

        evidence = Path(
            os.environ.get("OFFICE_TEST_EVIDENCE", str(self.root / "evidence"))
        )
        evidence.mkdir(exist_ok=True)
        for name, marker in [
            ("source.xlsx", "Region"),
            ("word.docx", "Office Word fixture"),
            ("slides.pptx", "Office PowerPoint fixture"),
        ]:
            result = render(self.root / name, evidence / name)
            self.assertEqual(result["pageCount"], 1)
            self.assertFalse(any(p["possiblyBlank"] for p in result["pages"]))
            self.assertIn(
                marker,
                "".join(p.extract_text() or "" for p in PdfReader(result["pdf"]).pages),
            )
        # Also render the actual native PivotTable/PivotChart, without rewriting it.
        pivot = self.root / "pivot.xlsx"
        create(
            self.root / "source.xlsx",
            pivot,
            ["Region"],
            ["Amount"],
            allow_evaluation=True,
        )
        result = render(pivot, evidence / "pivot.xlsx", allow_evaluation=True)
        self.assertEqual(result["engine"], "aspose")
        self.assertGreaterEqual(result["pageCount"], 2)
        from PIL import Image

        with Image.open(evidence / "pivot.xlsx" / "page-2.png") as page:
            pixels = page.convert("RGB")
            blue = sum(
                b > 100 and b > r * 1.15 and b > g * 1.03
                for r, g, b in pixels.get_flattened_data()
            )
            self.assertGreater(
                blue / (pixels.width * pixels.height),
                0.01,
                "PivotChart bars must actually be rendered",
            )
        self.assertFalse(all(p["possiblyBlank"] for p in result["pages"]))


if __name__ == "__main__":
    unittest.main()
