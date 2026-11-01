#!/usr/bin/env python3
"""Check local Markdown targets and navigation from the repository README."""

from __future__ import annotations

import re
import sys
from pathlib import Path
from urllib.parse import unquote


ROOT = Path(__file__).resolve().parents[1]
IGNORED_PARTS = {".git", "node_modules"}
INLINE_LINK = re.compile(r"!?\[[^\]]*\]\(([^)]+)\)")
REFERENCE_LINK = re.compile(r"^\s*\[[^\]]+\]:\s*(\S+)", re.MULTILINE)
REFERENCE_DEFINITION = re.compile(r"^ {0,3}\[([^\]]+)\]:\s*(\S+)[^\n]*$", re.MULTILINE)
REFERENCE_USE = re.compile(r"!?\[([^\]\n]+)\](?:\[([^\]\n]*)\])?(?![\[(])")


def prose(content: str) -> str:
    """Ignore examples and comments: they are not reader-clickable links."""
    content = re.sub(r"<!--[\s\S]*?-->", "", content)
    lines: list[str] = []
    fence: str | None = None
    for line in content.splitlines():
        marker = re.match(r"^ {0,3}(`{3,}|~{3,})", line)
        if fence:
            closing = r" {0,3}" + re.escape(fence[0]) + r"{" + str(len(fence)) + r",}\s*"
            if re.fullmatch(closing, line):
                fence = None
        elif marker:
            fence = marker.group(1)
        else:
            lines.append(line)
    return re.sub(r"(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)", "", "\n".join(lines))


def link_targets(content: str, *, navigation: bool = False) -> list[str]:
    content = prose(content)
    targets = [
        match.group(1)
        for match in INLINE_LINK.finditer(content)
        if not navigation or not match.group(0).startswith("!")
    ]
    if not navigation:
        return targets + REFERENCE_LINK.findall(content)
    # An unused reference definition is not a way to navigate to a document.
    definitions = {
        " ".join(label.split()).casefold(): target
        for label, target in REFERENCE_DEFINITION.findall(content)
    }
    body = REFERENCE_DEFINITION.sub("", content)
    for match in REFERENCE_USE.finditer(body):
        if match.group(0).startswith("!"):
            continue
        label, reference = match.groups()
        key = " ".join((reference or label).split()).casefold()
        if key in definitions:
            targets.append(definitions[key])
    return targets


def markdown_files() -> list[Path]:
    return sorted(
        path
        for path in ROOT.rglob("*.md")
        if not IGNORED_PARTS.intersection(path.relative_to(ROOT).parts)
    )


def target_path(raw_target: str, source: Path) -> Path | None:
    target = raw_target.strip()
    if target.startswith("<") and ">" in target:
        target = target[1 : target.index(">")]
    else:
        parts = target.split(maxsplit=1)
        target = parts[0] if parts else ""

    target = unquote(target.split("#", maxsplit=1)[0].split("?", maxsplit=1)[0])
    if not target or target.startswith(("/", "//")) or ":" in target.split("/", 1)[0]:
        return None

    return (source.parent / target).resolve()


def unreachable_documents(files: list[Path], root: Path) -> list[Path]:
    """Only a path of actual Markdown links from README.md counts as access."""
    known = set(files)
    graph: dict[Path, set[Path]] = {}
    for source in files:
        graph[source] = set()
        targets = link_targets(source.read_text(encoding="utf-8"), navigation=True)
        for target in targets:
            resolved = target_path(target, source)
            if resolved is not None and resolved.is_dir():
                resolved = resolved / "README.md"
            if resolved in known:
                graph[source].add(resolved)
    reached: set[Path] = set()
    pending = [root / "README.md"]
    while pending:
        current = pending.pop()
        if current in reached:
            continue
        reached.add(current)
        pending.extend(graph.get(current, set()) - reached)
    return sorted(known - reached)


def main() -> int:
    broken: list[str] = []
    files = markdown_files()

    for source in files:
        content = source.read_text(encoding="utf-8")
        targets = link_targets(content)
        for raw_target in targets:
            resolved = target_path(raw_target, source)
            if resolved is not None and (
                not resolved.is_relative_to(ROOT) or not resolved.exists()
            ):
                broken.append(
                    f"{source.relative_to(ROOT)}: {raw_target} -> "
                    f"{resolved.relative_to(ROOT) if resolved.is_relative_to(ROOT) else resolved}"
                )

    orphans = unreachable_documents(files, ROOT)
    if broken:
        print("Broken relative Markdown links:", file=sys.stderr)
        print("\n".join(f"- {item}" for item in broken), file=sys.stderr)
    if orphans:
        print("Markdown documents unreachable from README.md:", file=sys.stderr)
        print(
            "\n".join(f"- {path.relative_to(ROOT)}" for path in orphans),
            file=sys.stderr,
        )
    if broken or orphans:
        return 1

    print(
        f"Checked {len(files)} Markdown files: no broken relative links; "
        "all reachable from README.md."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
