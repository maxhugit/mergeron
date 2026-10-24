from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]


class AuthentikIngressConfigurationTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.nginx = (ROOT / "deployment/config/nginx.conf.template").read_text()
        cls.traefik = (ROOT / "deployment/traefik/mergeron.yml").read_text()
        cls.native = (ROOT / "deployment/config/nginx.native.conf.template").read_text()

    def test_native_browser_route_never_injects_a_service_token_or_identity(self) -> None:
        browser = self.native.split("        location / {", 1)[1]
        self.assertNotIn("MERGERON_BACKEND_TOKEN", browser)
        self.assertNotIn("auth_request", self.native)
        self.assertNotIn("authentik_backend", self.native)
        for header in ["Source", "Subject", "Email"]:
            self.assertIn(f'proxy_set_header X-Webui-Auth-{header} "";', browser)
        self.assertIn("proxy_set_header Upgrade $http_upgrade;", browser)
        self.assertIn("proxy_request_buffering off;", browser)

    def test_native_machine_endpoints_keep_their_scoped_credentials(self) -> None:
        for route, source in [("/api/files/serve", "document"), ("/api/onlyoffice/callback", "service"), ("/_health", "service")]:
            block = self.native.split(f"location = {route} {{", 1)[1].split("}", 1)[0]
            # Token interpolation itself contains a brace.
            self.assertIn("proxy_pass $mergeron_backend", block)
            self.assertIn(f"proxy_set_header X-Webui-Auth-Source {source};", self.native.split(f"location = {route} {{", 1)[1].split("\n        }", 1)[0])
        self.assertIn("allow 127.0.0.1;", self.native)
        self.assertIn("deny all;", self.native)

    def test_traefik_does_not_duplicate_authentication(self) -> None:
        web_router = self.traefik.split("mergeron-web:", 1)[1]
        web_router = web_router.split("services:", 1)[0]
        self.assertNotIn("- authentik", web_router)
        self.assertIn("- mergeron-security-headers", web_router)

    def test_nginx_exposes_authentik_browser_flow(self) -> None:
        self.assertIn("location /outpost.goauthentik.io", self.nginx)
        self.assertIn("location @goauthentik_proxy_signin", self.nginx)
        self.assertIn(
            "error_page 401 = @goauthentik_proxy_signin;", self.nginx
        )

    def test_refreshed_session_cookie_reaches_the_browser(self) -> None:
        self.assertIn(
            "auth_request_set $auth_cookie $upstream_http_set_cookie;",
            self.nginx,
        )
        self.assertIn("add_header Set-Cookie $auth_cookie always;", self.nginx)

    def test_application_identity_comes_from_authentik_subrequest(self) -> None:
        self.assertIn(
            "auth_request_set $identity_uid $upstream_http_x_authentik_uid;",
            self.nginx,
        )
        self.assertIn(
            "proxy_set_header X-Webui-Auth-Subject $identity_uid;", self.nginx
        )


if __name__ == "__main__":
    unittest.main()
