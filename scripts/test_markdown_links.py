"""Regression tests for documentation access without network or repository writes."""

import importlib.util
import io
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location(
    "markdown_links", Path(__file__).with_name("check-markdown-links.py")
)
links = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(links)


class MarkdownLinksTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()

    def write(self, name, text):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
        return path

    def orphans(self):
        return [str(p.relative_to(self.root)) for p in links.unreachable_documents(
            sorted(self.root.rglob("*.md")), self.root
        )]

    def test_index_chain_and_return_links_make_all_documents_reachable(self):
        self.write("README.md", "[Documentation](docs/README.md)")
        self.write("docs/README.md", "[Guide](guide.md) · [Accueil](../README.md)")
        self.write("docs/guide.md", "[Sommaire](README.md)")
        self.assertEqual(self.orphans(), [])

    def test_existing_but_unlinked_document_is_an_error(self):
        self.write("README.md", "# Project\nVoir `docs/guide.md`.")
        self.write("docs/guide.md", "[Accueil](../README.md)")
        self.assertEqual(self.orphans(), ["docs/guide.md"])

    def test_unreachable_cycle_does_not_count_as_navigation(self):
        self.write("README.md", "# Project")
        self.write("docs/a.md", "[B](b.md)")
        self.write("docs/b.md", "[A](a.md)")
        self.assertEqual(self.orphans(), ["docs/a.md", "docs/b.md"])

    def test_directory_links_open_the_directory_readme(self):
        self.write("README.md", "[Documentation](docs/)")
        self.write("docs/README.md", "# Documentation")
        self.assertEqual(self.orphans(), [])

    def test_url_encoded_path_and_fragment_resolve_to_the_same_file(self):
        self.write("README.md", "[Guide](<docs/guide%20fran%C3%A7ais.md#utilisation>)")
        guide = self.write("docs/guide français.md", "# Guide")
        self.assertEqual(self.orphans(), [])
        self.assertEqual(links.target_path("docs/guide%20fran%C3%A7ais.md?plain=1#guide", self.root / "README.md"), guide)

    def test_code_samples_and_comments_are_not_navigation(self):
        self.write("README.md", """# Project
```md
[Guide](guide.md)
```
~~~~markdown
[Guide](guide.md)
~~~
~~~~
`[Guide](guide.md)`
<!-- [Guide](guide.md) -->
""")
        self.write("guide.md", "# Guide")
        self.assertEqual(self.orphans(), ["guide.md"])

    def test_reference_links_support_full_collapsed_and_shortcut_forms(self):
        for use in ["[Guide][Manual]", "[MANUAL][]", "[manual]"]:
            with self.subTest(use=use):
                self.write("README.md", use + "\n\n[manual]: guide.md\n")
                self.write("guide.md", "# Guide")
                self.assertEqual(self.orphans(), [])

    def test_unused_reference_definition_does_not_make_a_document_accessible(self):
        self.write("README.md", "# Project\n\n[guide]: guide.md\n")
        self.write("guide.md", "# Guide")
        self.assertEqual(self.orphans(), ["guide.md"])

    def test_images_are_validated_but_are_not_document_navigation(self):
        for use in ["![Guide](guide.md)", "![Guide][manual]\n\n[manual]: guide.md"]:
            with self.subTest(use=use):
                self.write("README.md", use)
                self.write("guide.md", "# Guide")
                self.assertEqual(self.orphans(), ["guide.md"])
                self.assertIn("guide.md", links.link_targets(use))

    def test_unused_definitions_are_still_checked_for_broken_targets(self):
        self.assertEqual(links.link_targets("[guide]: missing.md\n"), ["missing.md"])

    def test_external_and_anchor_only_links_are_not_filesystem_targets(self):
        source = self.root / "README.md"
        for target in ["", "#documentation", "https://example.org/guide.md", "mailto:help@example.org", "//example.org/guide.md"]:
            with self.subTest(target=target):
                self.assertIsNone(links.target_path(target, source))

    def test_removed_file_is_not_confused_with_an_external_link(self):
        source = self.write("README.md", "[Guide](missing.md)")
        target = links.target_path(links.link_targets(source.read_text())[0], source)
        self.assertEqual(target, self.root / "missing.md")
        self.assertFalse(target.exists())

    def check(self):
        output, errors = io.StringIO(), io.StringIO()
        with patch.object(links, "ROOT", self.root), redirect_stdout(output), redirect_stderr(errors):
            result = links.main()
        return result, output.getvalue(), errors.getvalue()

    def test_cli_fails_for_a_broken_link(self):
        self.write("README.md", "[Guide](missing.md)")
        result, _, errors = self.check()
        self.assertEqual(result, 1)
        self.assertIn("Broken relative Markdown links", errors)
        self.assertIn("missing.md", errors)

    def test_cli_fails_for_an_orphan_even_if_no_existing_link_is_broken(self):
        self.write("README.md", "# Project")
        self.write("guide.md", "# Guide")
        result, _, errors = self.check()
        self.assertEqual(result, 1)
        self.assertIn("unreachable from README.md", errors)
        self.assertNotIn("Broken relative", errors)

    def test_cli_accepts_a_complete_documentation_tree(self):
        self.write("README.md", "[Documentation](docs/README.md)")
        self.write("docs/README.md", "[Guide](guide.md)")
        self.write("docs/guide.md", "[Index](README.md)")
        result, output, errors = self.check()
        self.assertEqual(result, 0)
        self.assertIn("3 Markdown files", output)
        self.assertEqual(errors, "")


if __name__ == "__main__":
    unittest.main()
