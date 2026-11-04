"""Internal bounded renderer for native Excel pivots (called by render_office)."""

from pathlib import Path
import sys
from office_common import license_aspose, main_guard, preflight


def main():
    source, output = Path(sys.argv[1]), Path(sys.argv[2])
    if source.suffix.lower() != ".xlsx" or output.exists():
        raise ValueError("Expected XLSX and a new PDF path")
    preflight(source)
    license_aspose("--allow-evaluation" in sys.argv[3:])
    from aspose.cells import Workbook, SaveFormat

    book = Workbook(str(source))
    book.save(str(output), SaveFormat.PDF)


if __name__ == "__main__":
    main_guard(main)
