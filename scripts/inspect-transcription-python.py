"""Inspect installed Python distributions and embedded SBOM provenance, read-only."""
import importlib.metadata
import json
import os
from pathlib import Path
import sys

print(json.dumps({"python": sys.version, "setuptools": importlib.metadata.version("setuptools")}))
# Wolfi package SBOMs may describe dependencies independently of Python metadata.
# Keep these reports intact; show their source instead of hiding scan findings.
for directory, subdirectories, filenames in os.walk("/", followlinks=False):
    if directory == "/":
        subdirectories[:] = [name for name in subdirectories if name not in {"proc", "sys", "dev", "tmp"}]
    for name in filenames:
        path = Path(directory) / name
        if name == "METADATA" and "setuptools" in str(path):
            print(json.dumps({"metadata": str(path), "identity": [line for line in path.read_text().splitlines() if line.startswith(("Name: ", "Version: "))]}))
        if not name.endswith((".spdx", ".spdx.json", ".cdx", ".cdx.json")):
            continue
        print(json.dumps({"embeddedSbom": str(path)}))
        text = path.read_text()
        try:
            data = json.loads(text)
        except ValueError:
            # SPDX also permits the tag/value representation.
            print(json.dumps({"sbom": str(path), "setuptoolsReferences": [line for line in text.splitlines() if "setuptools" in line.lower()]}))
            continue
        for package in data.get("packages", data.get("components", [])):
            if "setuptools" in package.get("name", "").lower():
                print(json.dumps({"sbom": str(path), "package": package}))
