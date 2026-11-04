"""Shared OOXML preflight. The enclosing Codex sandbox remains authoritative."""

import argparse
import json
import os
from pathlib import Path
import zipfile
from lxml import etree

MAX_BYTES = 128 * 1024 * 1024
NS = {
    "s": "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
    "r": "http://schemas.openxmlformats.org/package/2006/relationships",
}


def parser(description):
    p = argparse.ArgumentParser(description=description)
    p.add_argument(
        "--root",
        action="append",
        help="Authorized input/output root; defaults to cwd. Does not widen the sandbox.",
    )
    return p


def checked_path(value, roots=None, output=False):
    path = Path(value).expanduser().resolve()
    allowed = [Path(r).resolve() for r in (roots or [os.getcwd()])]
    if not any(path.is_relative_to(r) for r in allowed):
        raise ValueError("Path outside authorized roots")
    if output:
        if path.exists():
            raise ValueError("Output already exists; choose a new path")
        if not path.parent.is_dir():
            raise ValueError("Output parent must already exist")
    elif not path.is_file():
        raise ValueError("Input file not found")
    return path


def xml(data):
    if b"<!DOCTYPE" in data.upper() or b"<!ENTITY" in data.upper():
        raise ValueError("DTD and entities are forbidden")
    node = etree.fromstring(
        data,
        etree.XMLParser(
            resolve_entities=False,
            no_network=True,
            remove_comments=True,
            remove_pis=True,
        ),
    )
    if node.getroottree().docinfo.doctype:
        raise ValueError("DTD and entities are forbidden")
    return node


def preflight(path):
    if path.suffix.lower() not in (".xlsx", ".docx", ".pptx"):
        raise ValueError("Only macro-free XLSX, DOCX and PPTX are supported")
    if path.stat().st_size > MAX_BYTES:
        raise ValueError("Office input exceeds 128 MiB")
    with zipfile.ZipFile(path) as z:
        entries = z.infolist()
        names = [i.filename for i in entries]
        if (
            len(entries) > 10000
            or len(names) != len(set(names))
            or sum(i.file_size for i in entries) > MAX_BYTES
        ):
            raise ValueError(
                "Office archive exceeds limits or contains duplicate parts"
            )
        if z.testzip():
            raise ValueError("Corrupt Office archive")
        for name in names:
            lower = name.lower()
            if name.startswith("/") or ".." in Path(name).parts or "\\" in name:
                raise ValueError("Invalid Office part path")
            if any(
                term in lower
                for term in (
                    "vbaproject",
                    "vbadata",
                    "macrosheet",
                    "/activex/",
                    "/embeddings/",
                    "/externallinks/",
                    "/querytables/",
                    "/webextensions/",
                    "xl/connections.xml",
                )
            ):
                raise ValueError("Macros and embedded executable objects are forbidden")
            if lower.endswith((".xml", ".rels")):
                node = xml(z.read(name))
                if name == "[Content_Types].xml" and any(
                    "macroenabled" in str(v).lower()
                    for n in node.iter()
                    for v in n.attrib.values()
                ):
                    raise ValueError("Macro-enabled document is forbidden")
                for n in node.iter():
                    tag = etree.QName(n).localname
                    text = (n.text or "").upper()
                    if (
                        tag == "instrText"
                        and any(
                            word in text
                            for word in (
                                "DDE",
                                "INCLUDETEXT",
                                "INCLUDEPICTURE",
                                "DATABASE",
                                "LINK ",
                            )
                        )
                    ) or (
                        tag == "f"
                        and any(
                            word in text
                            for word in ("WEBSERVICE(", "HYPERLINK(", "RTD(", "|")
                        )
                    ):
                        raise ValueError(
                            "External or executable document fields are forbidden"
                        )
                if lower.endswith(".rels") and any(
                    n.get("TargetMode", "").lower() == "external" for n in node
                ):
                    raise ValueError(
                        "External relationships are forbidden; supply a self-contained document"
                    )
        expected = {
            ".xlsx": "xl/workbook.xml",
            ".docx": "word/document.xml",
            ".pptx": "ppt/presentation.xml",
        }[path.suffix.lower()]
        if expected not in names:
            raise ValueError("Office type and package disagree")


def license_aspose(allow_evaluation=False):
    # A dedicated read-only secret mount is visible through the outer ro-bind.
    # /run/secrets remains entirely masked by Mergeron's document sandbox.
    from aspose.cells import License

    path = Path(
        os.environ.get(
            "ASPOSE_CELLS_LICENSE_FILE", "/opt/office-license/Aspose.Cells.lic"
        )
    )
    if not path.is_file():
        if allow_evaluation:
            return False
        raise ValueError(
            "Aspose license missing; mount a read-only secret or explicitly use --allow-evaluation for tests"
        )
    if path.stat().st_size > 1024 * 1024 or os.access(path, os.W_OK):
        raise ValueError("Aspose license must be a small read-only secret")
    try:
        License().set_license(str(path))
    except Exception:
        raise ValueError("Aspose license could not be applied") from None
    return True


def emit(value):
    print(json.dumps(value, ensure_ascii=False))


def main_guard(fn):
    try:
        fn()
    except Exception as error:
        # Never echo native exceptions which can contain license XML or document data.
        message = (
            str(error)
            if isinstance(error, (ValueError, FileNotFoundError))
            else type(error).__name__
        )
        print(
            json.dumps({"ok": False, "error": message}), file=__import__("sys").stderr
        )
        raise SystemExit(1)
