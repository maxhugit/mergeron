from pathlib import Path
import unittest
import xml.etree.ElementTree as ET


ROOT = Path(__file__).resolve().parents[1]


class ManagerDeploymentTest(unittest.TestCase):
    def test_development_template_uses_dev_artwork_and_isolated_defaults(self):
        root = ET.parse(ROOT / 'deployment/docker-man/my-mergeron-dev-manager.xml').getroot()
        self.assertEqual(root.findtext('Name'), 'mergeron-dev-manager')
        self.assertEqual(root.findtext('Network'), 'none')
        self.assertTrue(root.findtext('Icon').endswith('/pwa-dev-icon-192.png'))
        self.assertEqual(root.find("Config[@Target='MERGERON_STACK_ENVIRONMENT']").text, 'development')
        self.assertEqual(root.find("Config[@Target='MERGERON_STACK_PREFIX']").text, 'mergeron-dev')
        self.assertEqual(root.find("Config[@Target='MERGERON_INSTALL_ENABLED']").text, 'false')
        self.assertIn('/mergeron-dev/state', root.find("Config[@Target='/host-state']").text)
        self.assertTrue(root.find("Config[@Target='MERGERON_APP_IMAGE']").text.endswith(':edge'))
        self.assertIsNone(root.find("Config[@Type='Port']"))

    @classmethod
    def setUpClass(cls) -> None:
        cls.compose = (ROOT / "deployment/compose.yml").read_text()
        cls.production_env = (ROOT / "deployment/.env.example").read_text()
        cls.development_env = (ROOT / "deployment/.env.dev.example").read_text()
        cls.workflow = (ROOT / ".github/workflows/docker-publish.yml").read_text()
        cls.quality_workflow = (ROOT / ".github/workflows/quality.yml").read_text()
        cls.dockerfile = (ROOT / "Dockerfile.manager").read_text()

    def test_compose_manager_is_isolated_and_mounts_only_declared_host_state(self) -> None:
        manager = self.compose.split("  mergeron-manager:", 1)[1]
        self.assertIn("network_mode: none", manager)
        self.assertIn("/var/run/docker.sock:/var/run/docker.sock:ro", manager)
        self.assertIn("${STATE_ROOT}:/host-state", manager)
        self.assertIn("${STATE_ROOT}/manager-run:/run/mergeron-manager", manager)
        self.assertIn(
            "${STATE_ROOT}/manager-state:/var/lib/mergeron-manager", manager
        )
        application = self.compose.split("  mergeron-ui:", 1)[1].split(
            "  mergeron-ingress:", 1
        )[0]
        self.assertIn("${STATE_ROOT}/manager-run:/run/mergeron-manager", application)
        self.assertIn("MERGERON_INSTALL_ENABLED: ${MERGERON_INSTALL_ENABLED:-false}", manager)
        self.assertIn("mem_limit: 512m", manager)
        self.assertIn("cpus: 0.25", manager)
        self.assertIn("pids_limit: 64", manager)

    def test_manager_templates_allow_bounded_snapshot_memory_without_weakening_isolation(self) -> None:
        for name in ['my-mergeron-manager.xml', 'my-mergeron-dev-manager.xml']:
            root = ET.parse(ROOT / 'deployment/docker-man' / name).getroot()
            options = root.findtext('ExtraParams')
            for expected in ['--memory 512m', '--cpus 0.25', '--pids-limit 64', '--read-only', '--cap-drop ALL', '--security-opt no-new-privileges:true']:
                self.assertIn(expected, options)
            self.assertEqual(root.findtext('Network'), 'none')
            self.assertIsNone(root.find("Config[@Type='Port']"))

    def test_dockerman_manager_has_no_network_or_published_port(self) -> None:
        root = ET.parse(
            ROOT / "deployment/docker-man/my-mergeron-manager.xml"
        ).getroot()
        self.assertEqual(root.findtext("Network"), "none")
        self.assertIn("--cap-add DAC_READ_SEARCH", root.findtext("ExtraParams"))
        manager = self.compose.split("  mergeron-manager:", 1)[1]
        self.assertIn("      - DAC_READ_SEARCH", manager)
        self.assertIsNone(root.find("Config[@Type='Port']"))
        self.assertEqual(
            root.find("Config[@Target='/var/run/docker.sock']").attrib["Mode"],
            "ro",
        )
        self.assertEqual(
            root.find("Config[@Target='/host-state']").attrib["Mode"],
            "rw",
        )

    def test_proxy_and_authentication_are_configurable_without_personal_host_defaults(self) -> None:
        manifest = (ROOT / "manager/stack-manifest.json").read_text()
        installer = (ROOT / "manager/src/installer.mjs").read_text()
        root = ET.parse(ROOT / "deployment/docker-man/my-mergeron-manager.xml").getroot()
        self.assertNotIn("net_standard", manifest)
        self.assertNotIn("/mnt/pool", installer)
        self.assertIn("MERGERON_PROXY_NETWORK: ${MERGERON_PROXY_NETWORK:-mergeron-proxy}", self.compose)
        self.assertIn("name: ${MERGERON_PROXY_NETWORK:-mergeron-proxy}", self.compose)
        self.assertEqual(root.find("Config[@Target='MERGERON_PROXY_NETWORK']").text, "mergeron-proxy")
        self.assertEqual(root.find("Config[@Target='MERGERON_AUTH_MODE']").text, "native")
        self.assertIn('MERGERON_AUTH_MODE=native', self.production_env)
        self.assertIn('MERGERON_AUTH_MODE=native', self.development_env)
        self.assertIn('MERGERON_NGINX_TEMPLATE=nginx.native.conf.template', self.production_env)
        self.assertIn('MERGERON_NGINX_TEMPLATE=nginx.native.conf.template', self.development_env)
        # An existing Compose stack without an explicit choice must fail closed,
        # not silently remount a different authentication template on recreation.
        self.assertIn('${MERGERON_NGINX_TEMPLATE:?', self.compose)
        self.assertIn("nginx.native.conf.template", self.dockerfile)
        self.assertIn("sh scripts/smoke-test-ingress.sh", self.quality_workflow)

    def test_development_profile_cannot_reuse_production_identity(self) -> None:
        self.assertIn("STATE_ROOT=/srv/mergeron/state", self.production_env)
        self.assertIn(
            "MERGERON_STACK_ENVIRONMENT=production", self.production_env
        )
        self.assertIn("MERGERON_INSTALL_ENABLED=false", self.production_env)
        self.assertIn(
            "STATE_ROOT=/srv/mergeron-dev/state", self.development_env
        )
        self.assertIn("MERGERON_STACK_PREFIX=mergeron-dev", self.development_env)
        self.assertIn(
            "MERGERON_STACK_ENVIRONMENT=development", self.development_env
        )
        self.assertIn("MERGERON_ADMIN_SUBNET=172.30.44.16/28", self.development_env)
        self.assertIn(
            "MERGERON_WEBUI_URL=https://mergeron-dev.example.com",
            self.development_env,
        )
        self.assertIn("MERGERON_INSTALL_ENABLED=false", self.development_env)

    def test_dockerman_inherits_the_images_exec_healthcheck_without_a_shell(self) -> None:
        root = ET.parse(
            ROOT / "deployment/docker-man/my-mergeron-manager.xml"
        ).getroot()
        # Docker CLI --health-cmd creates CMD-SHELL, but distroless has no /bin/sh.
        self.assertNotIn("--health-", root.findtext("ExtraParams"))
        self.assertIn('CMD ["/nodejs/bin/node", "src/healthcheck.mjs"]', self.dockerfile)

    def test_workflow_builds_and_promotes_the_manager_by_digest(self) -> None:
        self.assertIn("manager-build:", self.workflow)
        self.assertIn("file: ./Dockerfile.manager", self.workflow)
        self.assertIn("SOURCE_DIGEST: ${{ needs.manager-build.outputs.digest }}", self.workflow)
        self.assertIn("MANAGER_IMAGE_DIGEST", self.workflow)

    def test_pull_requests_build_smoke_test_and_scan_the_manager(self) -> None:
        self.assertIn("Build the minimal Manager image", self.quality_workflow)
        self.assertIn(
            "Start Manager and verify its Unix socket health check",
            self.quality_workflow,
        )
        self.assertIn(
            "Require no HIGH or CRITICAL Manager vulnerabilities",
            self.quality_workflow,
        )
        self.assertIn("needs: [checks, image, manager-image, browser-image, cli-runtime]", self.quality_workflow)
        self.assertIn("CLI_RESULT: ${{ needs.cli-runtime.result }}", self.quality_workflow)

    def test_manager_runtime_is_distroless_and_contains_no_npm_tree(self) -> None:
        self.assertIn("FROM gcr.io/distroless/nodejs22-debian13@sha256:", self.dockerfile)
        self.assertIn(
            'ENTRYPOINT ["/nodejs/bin/node", "src/server.mjs"]',
            self.dockerfile,
        )
        self.assertIn("deployment/config/squid.conf", self.dockerfile)


if __name__ == "__main__":
    unittest.main()
