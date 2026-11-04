"""Small deterministic, synthetic fixtures. No user documents or macros."""

from pathlib import Path
from openpyxl import Workbook
from docx import Document
from pptx import Presentation
from pptx.util import Inches


def make_fixtures(root):
    root = Path(root)
    w = Workbook()
    s = w.active
    s.title = "Sales O'Brien"
    for row in [
        ("Region", "Tags", "Amount"),
        ("Nord", "A; B", 10),
        ("Sud", "B", 20),
        ("Nord", "A", 5),
    ]:
        s.append(row)
    s.column_dimensions["A"].width = 20
    s.column_dimensions["B"].width = 20
    s.print_area = "A1:C8"
    s.page_setup.fitToWidth = 1
    w.save(root / "source.xlsx")
    d = Document()
    d.add_heading("Office Word fixture", 0)
    d.add_paragraph("Texte accentué : été, Noël. Table et mise en page.")
    t = d.add_table(rows=2, cols=2)
    t.cell(0, 0).text = "Nord"
    t.cell(1, 1).text = "35"
    d.save(root / "word.docx")
    p = Presentation()
    slide = p.slides.add_slide(p.slide_layouts[5])
    slide.shapes.title.text = "Office PowerPoint fixture"
    slide.shapes.add_textbox(Inches(1), Inches(2), Inches(7), Inches(1)).text = (
        "Texte accentué : été et Noël"
    )
    p.save(root / "slides.pptx")
