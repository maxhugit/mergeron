"""Create a native PivotTable and PivotChart in a new XLSX with Aspose.Cells."""

from office_common import (
    checked_path,
    emit,
    license_aspose,
    main_guard,
    parser,
    preflight,
)


def create(
    source, output, rows, values, columns=(), sheet=None, allow_evaluation=False
):
    preflight(source)
    from aspose.cells import Workbook, SaveFormat, ConsolidationFunction
    from aspose.cells.pivot import PivotFieldType
    from aspose.cells.charts import ChartType

    licensed = license_aspose(allow_evaluation)
    book = Workbook(str(source))
    ws = book.worksheets[sheet] if sheet else book.worksheets[0]
    last_row, last_col = ws.cells.max_data_row, ws.cells.max_data_column
    if last_row < 1 or last_col < 0 or last_row > 100000 or last_col > 255:
        raise ValueError(
            "Source must have headers and data within 100000 rows / 256 columns"
        )
    headers = [ws.cells.get(0, i).string_value for i in range(last_col + 1)]
    selected = list(rows) + list(columns) + list(values)
    if (
        not headers
        or any(not h.strip() for h in headers)
        or len(set(headers)) != len(headers)
    ):
        raise ValueError("Source requires unique nonempty headers")
    if (
        not rows
        or not values
        or len(set(selected)) != len(selected)
        or any(h not in headers for h in selected)
    ):
        raise ValueError("Select distinct existing row, column and value fields")
    for r in range(1, last_row + 1):
        for value in values:
            cell = ws.cells.get(r, headers.index(value))
            if (
                cell.is_formula
                or not isinstance(cell.value, (int, float))
                or isinstance(cell.value, bool)
            ):
                raise ValueError("SUM value fields must contain static numeric values")
    if any(s.name == "Pivot" for s in book.worksheets):
        raise ValueError("Source already has a Pivot sheet")
    target = book.worksheets[book.worksheets.add()]
    target.name = "Pivot"
    # A native named range avoids Aspose's string-parser ambiguity for apostrophes.
    import uuid

    data = ws.cells.create_range(0, 0, last_row + 1, last_col + 1)
    data.name = "AgentPivotSource_" + uuid.uuid4().hex
    index = target.pivot_tables.add(data.name, "A3", "AgentPivot")
    pivot = target.pivot_tables[index]
    for kind, names in [
        (PivotFieldType.ROW, rows),
        (PivotFieldType.COLUMN, columns),
        (PivotFieldType.DATA, values),
    ]:
        for name in names:
            pivot.add_field_to_area(kind, headers.index(name))
    for field in pivot.data_fields:
        field.function = ConsolidationFunction.SUM
    pivot.refresh_data()
    pivot.calculate_data()
    target.auto_fit_columns()
    left = max(6, target.cells.max_data_column + 3)
    chart = target.charts[target.charts.add(ChartType.COLUMN, 2, left, 22, left + 12)]
    chart.pivot_source = "Pivot!AgentPivot"
    chart.hide_pivot_field_buttons = False
    chart.title.text = "AgentPivot"
    from aspose.cells import PageOrientationType, PaperSizeType
    from openpyxl.utils import get_column_letter

    target.page_setup.orientation = PageOrientationType.LANDSCAPE
    target.page_setup.paper_size = PaperSizeType.PAPER_A4
    target.page_setup.print_area = (
        f"A1:{get_column_letter(left + 12)}{max(25, target.cells.max_data_row + 1)}"
    )
    target.page_setup.fit_to_pages_wide = 1
    target.page_setup.fit_to_pages_tall = 0
    book.save(str(output), SaveFormat.XLSX)
    from validate_office import validate

    result = validate(
        output,
        expected_rows=rows,
        expected_columns=columns,
        expected_values=values,
        require_pivot=True,
    )
    result.update(
        {"output": str(output), "licensed": licensed, "evaluation": not licensed}
    )
    return result


def main():
    p = parser(__doc__)
    p.add_argument("source")
    p.add_argument("output")
    p.add_argument("--row", action="append", required=True)
    p.add_argument("--value", action="append", required=True)
    p.add_argument("--column", action="append", default=[])
    p.add_argument("--sheet")
    p.add_argument(
        "--allow-evaluation",
        action="store_true",
        help="Tests only: output includes Aspose evaluation sheet/watermark",
    )
    a = p.parse_args()
    output = checked_path(a.output, a.root, output=True)
    if output.suffix.lower() != ".xlsx":
        raise ValueError("Output must be XLSX")
    emit(
        create(
            checked_path(a.source, a.root),
            output,
            a.row,
            a.value,
            a.column,
            a.sheet,
            a.allow_evaluation,
        )
    )


if __name__ == "__main__":
    main_guard(main)
