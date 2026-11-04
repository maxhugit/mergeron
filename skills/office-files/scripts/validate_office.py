"""Reopen Office files; inspect native pivot/cache relationships and selected fields."""

import posixpath
import zipfile
from office_common import checked_path, emit, main_guard, NS, parser, preflight, xml


def relationships(z, part):
    path = posixpath.join(
        posixpath.dirname(part), "_rels", posixpath.basename(part) + ".rels"
    )
    if path not in z.namelist():
        return {}
    result = {}
    for rel in xml(z.read(path)):
        target = rel.get("Target", "")
        resolved = (
            target.lstrip("/")
            if target.startswith("/")
            else posixpath.normpath(posixpath.join(posixpath.dirname(part), target))
        )
        if resolved.startswith("../") or resolved not in z.namelist():
            raise ValueError("Dangling or invalid Office relationship")
        result[rel.get("Id")] = (rel.get("Type", "").rsplit("/", 1)[-1], resolved)
    return result


def validate(
    path, expected_rows=(), expected_columns=(), expected_values=(), require_pivot=False
):
    preflight(path)
    report = {"ok": True, "type": path.suffix.lower(), "pivots": []}
    if path.suffix.lower() == ".docx":
        from docx import Document

        d = Document(path)
        report.update(paragraphs=len(d.paragraphs), tables=len(d.tables))
    elif path.suffix.lower() == ".pptx":
        from pptx import Presentation

        d = Presentation(path)
        if not d.slides:
            raise ValueError("Presentation has no slides")
        report["slides"] = len(d.slides)
    else:
        from openpyxl import load_workbook

        d = load_workbook(path, read_only=True, data_only=False, keep_links=False)
        report["sheets"] = d.sheetnames
        d.close()
        with zipfile.ZipFile(path) as z:
            workbook = xml(z.read("xl/workbook.xml"))
            wr = relationships(z, "xl/workbook.xml")
            cache_map = {}
            for node in workbook.findall("s:pivotCaches/s:pivotCache", NS):
                rid = node.get(
                    "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"
                )
                kind, target = wr[rid]
                if kind != "pivotCacheDefinition":
                    raise ValueError("Invalid workbook cache relationship")
                cache_map[node.get("cacheId")] = target
            for part in z.namelist():
                if not part.startswith("xl/pivotTables/") or not part.endswith(".xml"):
                    continue
                pivot = xml(z.read(part))
                cache_part = cache_map.get(pivot.get("cacheId"))
                if (
                    cache_part is None
                    or ("pivotCacheDefinition", cache_part)
                    not in relationships(z, part).values()
                ):
                    raise ValueError("PivotTable has no linked pivotCache")
                cache = xml(z.read(cache_part))
                records = [
                    target
                    for kind, target in relationships(z, cache_part).values()
                    if kind == "pivotCacheRecords"
                ]
                if not records or int(xml(z.read(records[0])).get("count", "0")) < 1:
                    raise ValueError("Pivot cache records are missing or empty")
                fields = [
                    n.get("name")
                    for n in cache.findall("s:cacheFields/s:cacheField", NS)
                ]

                def names(query, attribute):
                    indexes = [int(n.get(attribute)) for n in pivot.findall(query, NS)]
                    return [
                        fields[i] for i in indexes if i >= 0
                    ]  # -2 is Excel's data axis

                rows = names("s:rowFields/s:field", "x")
                columns = names("s:colFields/s:field", "x")
                values = names("s:dataFields/s:dataField", "fld")
                for actual, expected in [
                    (rows, expected_rows),
                    (columns, expected_columns),
                    (values, expected_values),
                ]:
                    if expected and list(expected) != actual:
                        raise ValueError("Pivot fields do not match expected fields")
                report["pivots"].append(
                    {
                        "name": pivot.get("name"),
                        "rows": rows,
                        "columns": columns,
                        "values": values,
                        "cache": cache_part,
                    }
                )
            report["pivotCharts"] = sum(
                xml(z.read(n)).find(
                    ".//{http://schemas.openxmlformats.org/drawingml/2006/chart}pivotSource"
                )
                is not None
                for n in z.namelist()
                if n.startswith("xl/charts/chart") and n.endswith(".xml")
            )
        if report["pivots"]:
            from aspose.cells import Workbook

            reopened = Workbook(str(path))
            found = {p.name: p for s in reopened.worksheets for p in s.pivot_tables}
            for p in report["pivots"]:
                native = found.get(p["name"])
                if (
                    native is None
                    or [f.name for f in native.row_fields] != p["rows"]
                    or [f.name for f in native.column_fields if f.name != "Data"]
                    != p["columns"]
                    or [f.name for f in native.data_fields] != p["values"]
                ):
                    raise ValueError("Pivot did not reopen with expected native fields")
            if report["pivotCharts"] and not any(
                c.pivot_source for s in reopened.worksheets for c in s.charts
            ):
                raise ValueError("PivotChart did not reopen as a native pivot chart")
        if require_pivot and (not report["pivots"] or not report["pivotCharts"]):
            raise ValueError("Expected native PivotTable and PivotChart")
    if path.suffix.lower() != ".xlsx" and (
        require_pivot or expected_rows or expected_values or expected_columns
    ):
        raise ValueError("Pivot validation requires XLSX")
    return report


def main():
    p = parser(__doc__)
    p.add_argument("source")
    p.add_argument("--require-pivot", action="store_true")
    for field in ("row", "column", "value"):
        p.add_argument("--" + field, action="append", default=[])
    a = p.parse_args()
    emit(
        validate(
            checked_path(a.source, a.root), a.row, a.column, a.value, a.require_pivot
        )
    )


if __name__ == "__main__":
    main_guard(main)
