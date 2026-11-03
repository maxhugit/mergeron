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
        if not name.endswith(".json") or not ("sbom" in str(path).lower() or "spdx" in name.lower()):
            continue
        data = json.loads(path.read_text())
        for package in data.get("packages", data.get("components", [])):
            if "setuptools" in package.get("name", "").lower():
                print(json.dumps({"sbom": str(path), "package": package}))
