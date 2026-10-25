"""Ensure VEX removes only the individually reviewed header-package HIGHs."""

from collections import Counter
import json
import os
from pathlib import Path
import sys


def findings(report):
    return Counter(
        (r.get("Type"), v.get("PkgName"), v.get("PkgIdentifier", {}).get("PURL"),
         v["VulnerabilityID"], v["Severity"])
        for r in report.get("Results", []) for v in r.get("Vulnerabilities", [])
    )


def audit(raw, filtered, vex):
    if not all(any(r.get("Type") == "debian" for r in report.get("Results", [])) for report in (raw, filtered)):
        raise ValueError("Missing Debian scan results")
    allowed = set()
    for statement in vex["statements"]:
        if (statement["status"], statement["justification"]) != (
            "not_affected", "vulnerable_code_not_present"
        ):
            raise ValueError("Unexpected VEX status or justification")
        for product in statement["products"]:
            purl = product["@id"]
            if purl != "pkg:deb/debian/linux-libc-dev@6.12.113-1?arch=all&distro=debian-13.7":
                raise ValueError("VEX must match the exact reviewed header package")
            allowed.add(("debian", "linux-libc-dev", purl, statement["vulnerability"]["name"], "HIGH"))
    before, after = findings(raw), findings(filtered)
    expected = Counter({key: count for key, count in before.items() if key in allowed})
    if before - after != expected or after - before:
        raise ValueError("VEX changed findings outside the reviewed HIGH header-package scope, or failed to apply")
    return {
        "raw_high": sum(count for key, count in before.items() if key[-1] == "HIGH"),
        "actionable_high": sum(count for key, count in after.items() if key[-1] == "HIGH"),
        "reviewed_header_high": sum(expected.values()),
        "critical": sum(count for key, count in after.items() if key[-1] == "CRITICAL"),
    }


def main():
    raw, filtered, vex = (json.loads(Path(p).read_text()) for p in sys.argv[1:])
    result = audit(raw, filtered, vex)
    print(json.dumps(result, indent=2))
    if summary := os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(summary, "a") as out:
            out.write(
                "### Linux header applicability review\n\n"
                f"- Raw HIGH: **{result['raw_high']}**\n"
                f"- Reviewed header-package HIGH: **{result['reviewed_header_high']}**\n"
                f"- Actionable HIGH: **{result['actionable_high']}**\n"
                f"- CRITICAL retained: **{result['critical']}**\n\n"
                "Raw and VEX-filtered reports are both retained as artifacts. "
                "This assessment does not establish the security of the running host kernel.\n"
            )


if __name__ == "__main__":
    main()
