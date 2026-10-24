"""Exercise network migration with a fake Docker CLI; never contacts a daemon."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
CONTAINERS = ["mergeron-ui", "mergeron-ingress", "mergeron-squid"]
FAKE_DOCKER = '''#!/bin/sh
if [ "$1 $2" = "container inspect" ]; then
  if [ "$3" = "--format" ]; then
    case "$4" in
      *Aliases*)
        [ "$ALIASES" = complete ] && printf '%s\\n' mergeron mergeron-ui mergeron-ingress mergeron-squid
        ;;
      *) [ "$ATTACHED" = yes ] && printf 'yes\\n';;
    esac
    exit 0
  fi
  case ",$CONTAINERS," in *",$3,"*) exit 0;; *) exit 1;; esac
fi
if [ "$1 $2" = "network inspect" ]; then exit 0; fi
if [ "$1 $2" = "network connect" ]; then
  printf '%s\\n' "$*" >> "$CALLS"
  exit 0
fi
if [ "$1 $2" = "network disconnect" ]; then
  printf '%s\\n' "$*" >> "$CALLS"
  exit 0
fi
exit 1
'''


class MigrationTests(unittest.TestCase):
    def reconcile(self, containers, attached=False, aliases="missing", proxy="mergeron-proxy"):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            docker = path / "docker"
            docker.write_text(FAKE_DOCKER)
            docker.chmod(0o755)
            calls = path / "calls"
            result = subprocess.run(
                ["sh", str(ROOT / "deployment/docker-man/reconcile-networks.sh"), "once"],
                env={**os.environ, "PATH": f"{directory}:{os.environ['PATH']}",
                     "CONTAINERS": ",".join(containers), "CALLS": str(calls),
                     "ATTACHED": "yes" if attached else "no", "ALIASES": aliases,
                     "MERGERON_PROXY_NETWORK": proxy},
                capture_output=True, text=True, check=True,
            )
            return calls.read_text().splitlines() if calls.exists() else [], result.stdout

    def test_mergeron_names_use_the_required_networks(self):
        calls, _ = self.reconcile(CONTAINERS)
        self.assertEqual(len(calls), 6)
        self.assertIn("network connect --alias mergeron --alias mergeron-ui mergeron-admin mergeron-ui", calls)
        self.assertIn("network connect --alias mergeron-ingress mergeron-proxy mergeron-ingress", calls)
        self.assertIn("network connect --alias mergeron-squid mergeron-external mergeron-squid", calls)

    def test_legacy_external_network_is_explicitly_configurable(self):
        calls, _ = self.reconcile(CONTAINERS, proxy="net_standard")
        self.assertIn("network connect --alias mergeron-ingress net_standard mergeron-ingress", calls)
        self.assertNotIn("network connect --alias mergeron-ingress mergeron-proxy mergeron-ingress", calls)

    def test_mixed_names_and_idempotent_connected_networks(self):
        calls, _ = self.reconcile(CONTAINERS)
        self.assertEqual(len(calls), 6)
        calls, _ = self.reconcile(CONTAINERS, attached=True, aliases="complete")
        self.assertEqual(calls, [])

    def test_attached_networks_with_missing_aliases_are_repaired(self):
        calls, _ = self.reconcile(CONTAINERS, attached=True)
        self.assertEqual(len(calls), 12)
        self.assertIn("network disconnect mergeron-proxy mergeron-ingress", calls)
        self.assertIn("network connect --alias mergeron-ingress mergeron-proxy mergeron-ingress", calls)

    def test_intermediate_mergeron_ui_name_is_supported(self):
        calls, _ = self.reconcile(["mergeron-ui", "mergeron-ingress", "mergeron-squid"])
        self.assertEqual(len(calls), 6)
        self.assertIn("network connect --alias mergeron --alias mergeron-ui mergeron-isolated mergeron-ui", calls)

    def test_templates_keep_primary_network_aliases_and_existing_state(self):
        for name in ("mergeron", "mergeron-ingress", "mergeron-squid"):
            root = ET.parse(ROOT / f"deployment/docker-man/my-{name}.xml").getroot()
            expected_name = "mergeron-ui" if name == "mergeron" else name
            self.assertEqual(root.findtext("Name"), expected_name)
            self.assertIn(f"--network-alias={expected_name}", root.findtext("ExtraParams"))
            if name == "mergeron":
                self.assertEqual(root.findtext("Repository"), "ghcr.io/maxhugit/mergeron:latest")
                configs = {entry.attrib['Target']: entry.text for entry in root.findall('Config')}
                self.assertEqual(configs['/home/codex'], '/mnt/user/appdata/mergeron/state/home')
                self.assertEqual(configs['WEBUI_DB_PATH'], '/home/codex/.codex/codex-webui.sqlite')

        squid = ET.parse(ROOT / "deployment/docker-man/my-mergeron-squid.xml").getroot()
        self.assertIn("/usr/bin/pidof squid", squid.findtext("ExtraParams"))
        self.assertNotIn("/dev/tcp/127.0.0.1/3128", squid.findtext("ExtraParams"))


if __name__ == "__main__":
    unittest.main()
