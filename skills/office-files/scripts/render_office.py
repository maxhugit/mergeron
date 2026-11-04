"""Render a macro-free Office document to a verified PDF and every page as PNG."""

import json
import os
from pathlib import Path
import signal
import subprocess
import tempfile
import zipfile
from PIL import Image, ImageChops
from pypdf import PdfReader
from office_common import (
    checked_path,
    emit,
    license_aspose,
    main_guard,
    parser,
    preflight,
)


def run(command, env=None, timeout=120):
    with tempfile.TemporaryFile() as log:
        child = subprocess.Popen(
            command, stdout=log, stderr=log, env=env, start_new_session=True
        )
        try:
            code = child.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGKILL)
            child.wait()
            raise ValueError("Office conversion timed out") from None
        if code:
            raise ValueError("Office conversion process failed")


def render(source, output, dpi=120, max_pages=100, allow_evaluation=False):
    preflight(source)
    if not 72 <= dpi <= 200 or not 1 <= max_pages <= 200:
        raise ValueError("DPI or page limit outside supported bounds")
    # A new output directory prevents stale files from disguising a failed conversion.
    output.mkdir(exist_ok=False)
    try:
        pdf = output / (source.stem + ".pdf")
        native_pivot = False
        if source.suffix.lower() == ".xlsx":
            with zipfile.ZipFile(source) as package:
                native_pivot = any(
                    n.startswith("xl/pivotTables/") and n.endswith(".xml")
                    for n in package.namelist()
                )
        if native_pivot:
            # LibreOffice cannot faithfully render every native PivotChart.
            # Run Aspose in a bounded child, with the same inherited sandbox.
            worker = Path(__file__).with_name("render_excel_pdf.py")
            import sys

            command = [sys.executable, str(worker), str(source), str(pdf)]
            if allow_evaluation:
                command.append("--allow-evaluation")
            run(command)
        else:
            with tempfile.TemporaryDirectory(prefix="office-render-") as tmp:
                profile = Path(tmp) / "profile"
                user = profile / "user"
                user.mkdir(parents=True)
                (user / "registrymodifications.xcu").write_text(
                    """<?xml version="1.0" encoding="UTF-8"?>
    <oor:items xmlns:oor="http://openoffice.org/2001/registry">
    <item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop><prop oor:name="DisableMacrosExecution" oor:op="fuse"><value>true</value></prop></item>
    <item oor:path="/org.openoffice.Office.Common/Load"><prop oor:name="UpdateDocMode" oor:op="fuse"><value>0</value></prop></item>
    </oor:items>"""
                )
                env = {
                    **os.environ,
                    "SAL_USE_VCLPLUGIN": "svp",
                    "HOME": tmp,
                    "XDG_CACHE_HOME": tmp,
                    "TMPDIR": tmp,
                }
                filters = {
                    ".xlsx": "calc_pdf_Export",
                    ".docx": "writer_pdf_Export",
                    ".pptx": "impress_pdf_Export",
                }
                run(
                    [
                        "libreoffice",
                        "-env:UserInstallation=" + profile.as_uri(),
                        "--headless",
                        "--nologo",
                        "--nodefault",
                        "--nofirststartwizard",
                        "--norestore",
                        "--convert-to",
                        "pdf:" + filters[source.suffix.lower()],
                        "--outdir",
                        str(output),
                        str(source),
                    ],
                    env=env,
                )
        if not pdf.is_file() or not 100 <= pdf.stat().st_size <= 128 * 1024 * 1024:
            raise ValueError("LibreOffice produced no valid PDF")
        with pdf.open("rb") as stream:
            signature = stream.read(5)
        if signature != b"%PDF-":
            raise ValueError("LibreOffice produced no valid PDF")
        reader = PdfReader(pdf, strict=True)
        count = len(reader.pages)
        if reader.is_encrypted or not 1 <= count <= max_pages:
            raise ValueError("PDF is encrypted, empty or exceeds page limit")
        # Bound image allocation before calling Poppler.
        if any(
            float(p.mediabox.width) * float(p.mediabox.height) * (dpi / 72) ** 2
            > 40_000_000
            for p in reader.pages
        ):
            raise ValueError("PDF page dimensions exceed rendering limit")
        run(["pdftoppm", "-png", "-r", str(dpi), str(pdf), str(output / "page")])
        images = sorted(output.glob("page-*.png"))
        if len(images) != count:
            raise ValueError("Missing rendered PNG pages")
        pages = []
        for image in images:
            with Image.open(image) as im:
                im.load()
                rgb = im.convert("RGB")
                ink = ImageChops.difference(
                    rgb, Image.new("RGB", rgb.size, "white")
                ).convert("L")
                nonwhite = sum(ink.histogram()[8:]) / (rgb.width * rgb.height)
                pages.append(
                    {
                        "file": image.name,
                        "width": rgb.width,
                        "height": rgb.height,
                        "nonwhiteFraction": round(nonwhite, 6),
                        "possiblyBlank": nonwhite < 0.0001,
                    }
                )
        report = {
            "ok": True,
            "pdf": str(pdf),
            "pages": pages,
            "pageCount": count,
            "engine": "aspose" if native_pivot else "libreoffice",
            "visualReview": "required",
            "note": "Open every PNG; automated image checks do not prove layout correctness.",
        }
        (output / "render.json").write_text(json.dumps(report, indent=2))
        return report
    except BaseException:
        # Keep partial evidence, but mark it failed. Never claim it as a successful render.
        (output / "FAILED.txt").write_text(
            "Rendering failed; do not deliver partial output.\n"
        )
        raise


def main():
    p = parser(__doc__)
    p.add_argument("source")
    p.add_argument("output_dir")
    p.add_argument("--dpi", type=int, default=120)
    p.add_argument("--max-pages", type=int, default=100)
    p.add_argument(
        "--allow-evaluation",
        action="store_true",
        help="Tests only: allow Aspose watermarks when rendering native Excel pivots",
    )
    a = p.parse_args()
    emit(
        render(
            checked_path(a.source, a.root),
            checked_path(a.output_dir, a.root, output=True),
            a.dpi,
            a.max_pages,
            a.allow_evaluation,
        )
    )


if __name__ == "__main__":
    main_guard(main)
