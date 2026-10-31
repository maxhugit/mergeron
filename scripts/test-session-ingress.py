#!/usr/bin/env python3
"""Exercise the actual proxy template with synthetic sessions and real Nginx.

One disposable, network-isolated container; no host ports, host mounts, real
credentials, production services or shared Docker resources.
"""
import os
from pathlib import Path
import subprocess
import uuid


ROOT = Path(__file__).resolve().parents[1]


def fixture_config() -> str:
    config = (ROOT / "deployment/config/nginx.conf.template").read_text()
    config = config.replace("${MERGERON_BACKEND_TOKEN}", "synthetic-backend-token")
    config = config.replace("${MERGERON_PREVIEW_DOMAIN}", "preview.example.test")
    config = config.replace("http://authentik:9000", "http://127.0.0.1:9081")
    config = config.replace("http://mergeron-ui:8172", "http://127.0.0.1:9082")
    fixture = r'''
    server {
        listen 9081;
        location = /outpost.goauthentik.io/auth/nginx {
            # Simulate the outpost deleting a cookie on a session-store error.
            add_header Set-Cookie $fixture_cookie always;
            if ($http_x_fixture_auth = denied) { return 401; }
            if ($http_x_fixture_auth = forbidden) { return 403; }
            if ($http_x_fixture_auth = unavailable) { return 503; }
            if ($http_cookie != "fixture_session=valid") { return 401; }
            return 204;
        }
        location = /outpost.goauthentik.io/login {
            add_header Set-Cookie "fixture_session=valid; Path=/; HttpOnly" always;
            return 200;
        }
        location = /outpost.goauthentik.io/logout {
            add_header Set-Cookie "fixture_session=; Path=/; Max-Age=0; HttpOnly" always;
            return 200;
        }
    }
    server {
        listen 9082;
        location / { return 200 "synthetic protected backend"; }
    }
'''
    # On successful verification the outpost refreshes, rather than deletes,
    # its cookie. The map is only part of the synthetic upstream, not the app.
    fixture = r'''
    map $http_x_fixture_auth $fixture_cookie {
        default "fixture_session=valid; Path=/; HttpOnly";
        denied "fixture_session=; Path=/; Max-Age=0; HttpOnly";
        forbidden "fixture_session=; Path=/; Max-Age=0; HttpOnly";
        unavailable "fixture_session=; Path=/; Max-Age=0; HttpOnly";
    }
''' + fixture
    head, separator, tail = config.rpartition("}")
    if not separator or tail.strip():
        raise RuntimeError("Unexpected ingress template structure")
    return head + fixture + "}\n"


PROBE = r'''
set -eu
envsubst '${UNUSED_FIXTURE_VARIABLE}' > /tmp/nginx.conf
nginx -t -c /tmp/nginx.conf
nginx -c /tmp/nginx.conf
trap 'nginx -s quit -c /tmp/nginx.conf >/dev/null 2>&1' EXIT
base=http://127.0.0.1:8080
request() {
    curl --silent --show-error --max-time 5 -D /tmp/headers -o /dev/null \
        -b /tmp/cookies -c /tmp/cookies -H 'Host: session.example.test' "$@"
}
status() { head -n 1 /tmp/headers | tr -d '\r' | cut -d ' ' -f 2; }
# Real browser-flow responses must still set and delete cookies normally.
request "$base/outpost.goauthentik.io/login"
test "$(status)" = 200
grep -qi '^Set-Cookie: fixture_session=valid;' /tmp/headers
for failure in denied forbidden unavailable; do
    request -H "X-Fixture-Auth: $failure" "$base/api/auth/me"
    case "$failure" in
        denied) test "$(status)" = 302 ;;
        forbidden) test "$(status)" = 403 ;;
        unavailable) test "$(status)" = 500 ;;
    esac
    if grep -qi '^Set-Cookie:' /tmp/headers; then
        echo 'A rejected auth subrequest destroyed the browser session' >&2
        exit 1
    fi
    if test "$failure" = denied; then
        grep -qi '^Cache-Control: no-store' /tmp/headers
    fi
    # The old cookie is not permission: the *next* auth check must succeed.
    request "$base/api/auth/me"
    test "$(status)" = 200
    grep -qi '^Set-Cookie: fixture_session=valid;' /tmp/headers
done
request "$base/outpost.goauthentik.io/logout"
grep -qi '^Set-Cookie: fixture_session=;.*Max-Age=0' /tmp/headers
request "$base/api/auth/me"
test "$(status)" = 302
echo 'PASS: transient failures retain the cookie, refusals block access, refresh/login/logout remain effective'
'''


if __name__ == "__main__":
    name = "mergeron-session-fixture-" + uuid.uuid4().hex
    try:
        subprocess.run(
            ["docker", "run", "--rm", "-i", "--name", name, "--network", "none",
             "--entrypoint", "sh", os.environ.get("NGINX_TEST_IMAGE", "nginx:stable"),
             "-c", PROBE],
            input=fixture_config(), text=True, check=True, timeout=60,
        )
    finally:
        # Exact fixture only, including cleanup after a timed-out Docker client.
        subprocess.run(["docker", "rm", "--force", name],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                       timeout=10, check=False)
