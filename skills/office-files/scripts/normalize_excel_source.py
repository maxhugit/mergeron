"""Expand multivalued cells into rows (Cartesian product across chosen columns)."""

from itertools import product
from openpyxl import Workbook, load_workbook
from office_common import checked_path, emit, main_guard, parser, preflight


def normalize(source, destination, columns, separator=";", sheet=None, max_rows=100000):
    if not separator:
        raise ValueError("Separator cannot be empty")
    preflight(source)
    book = load_workbook(source, read_only=True, data_only=False, keep_links=False)
    try:
        ws = book[sheet] if sheet else book.active
        rows = ws.iter_rows(values_only=True)
        headers = list(next(rows, ()))
        if (
            not headers
            or not all(isinstance(h, str) and h.strip() for h in headers)
            or len(set(headers)) != len(headers)
        ):
            raise ValueError("Source requires unique nonempty text headers")
        if (
            not columns
            or len(columns) != len(set(columns))
            or any(c not in headers for c in columns)
        ):
            raise ValueError("Unknown or duplicate multivalue column")
        indexes = {headers.index(c) for c in columns}
        out = Workbook(write_only=True)
        target = out.create_sheet("Source")

        def append(values):
            from openpyxl.cell import WriteOnlyCell

            cells = []
            for v in values:
                cell = WriteOnlyCell(target, value=v)
                if isinstance(v, str):
                    cell.data_type = "s"  # literal text, never formula injection
                cells.append(cell)
            target.append(cells)

        append(headers)
        count = 0
        for row in rows:
            if all(v is None for v in row):
                continue
            if any(isinstance(v, str) and v.startswith("=") for v in row):
                raise ValueError(
                    "Normalize static values, not formulas; prepare a values-only source first"
                )
            choices = [
                (
                    [x.strip() for x in v.split(separator) if x.strip()] or [None]
                    if i in indexes and isinstance(v, str)
                    else [v]
                )
                for i, v in enumerate(row)
            ]
            for values in product(*choices):
                count += 1
                if count > max_rows:
                    raise ValueError("Normalized row limit exceeded")
                append(values)
        out.save(destination)
        return {
            "ok": True,
            "rows": count,
            "columns": headers,
            "output": str(destination),
        }
    finally:
        book.close()


def main():
    p = parser(__doc__)
    p.add_argument("source")
    p.add_argument("output")
    p.add_argument("--column", action="append", required=True)
    p.add_argument("--separator", default=";")
    p.add_argument("--sheet")
    a = p.parse_args()
    output = checked_path(a.output, a.root, output=True)
    if output.suffix.lower() != ".xlsx":
        raise ValueError("Output must be XLSX")
    emit(
        normalize(
            checked_path(a.source, a.root), output, a.column, a.separator, a.sheet
        )
    )


if __name__ == "__main__":
    main_guard(main)
