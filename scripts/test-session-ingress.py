#!/usr/bin/env python3
"""Exercise the actual proxy template with synthetic sessions and real Nginx.

One disposable, network-isolated container; no host ports, host mounts, real
credentials, production services or shared Docker resources.
"""
import os
import io
from pathlib import Path
import subprocess
import tarfile
import uuid


ROOT = Path(__file__).resolve().parents[1]


def fixture_config() -> str:
    config = (ROOT / "deployment/config/nginx.conf.template").read_text()
    config = config.replace("${MERGERON_BACKEND_TOKEN}", "synthetic-backend-token")
    config = config.replace("${MERGERON_PREVIEW_DOMAIN}", "preview.example.test")
    config = config.replace("http://authentik:9000", "http://127.0.0.1:9081")
    config = config.replace("http://mergeron-ui:8172", "http://127.0.0.1:9082")
    return config.replace('pid /var/run/nginx.pid;', 'pid /tmp/front.pid;')


def fixture_bundle() -> bytes:
    auth = r'''
pid /tmp/auth.pid;
events { worker_connections 32; }
http {
    access_log off;
    error_log /dev/stderr warn;
    map $http_x_fixture_auth $fixture_cookie {
        default "fixture_session=valid; Path=/; HttpOnly";
        denied "fixture_session=; Path=/; Max-Age=0; HttpOnly";
        forbidden "fixture_session=; Path=/; Max-Age=0; HttpOnly";
        unavailable "fixture_session=; Path=/; Max-Age=0; HttpOnly";
    }
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
}
'''
    backend = r'''
pid /tmp/backend.pid;
events { worker_connections 32; }
http {
    access_log off;
    error_log /dev/stderr warn;
    server {
        listen 9082;
        location / { return 200 "synthetic protected backend"; }
    }
}
'''
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode='w', format=tarfile.USTAR_FORMAT) as archive:
        for name, content in [('front.conf', fixture_config()), ('auth.conf', auth), ('backend.conf', backend)]:
            data = content.encode('utf-8')
            info = tarfile.TarInfo(name)
            info.size, info.mode = len(data), 0o600
            archive.addfile(info, io.BytesIO(data))
    return output.getvalue()


PROBE = r'''
set -eu
tar -xf - -C /tmp
start() {
    nginx -t -c /tmp/$1.conf
    nginx -g 'daemon off;' -c /tmp/$1.conf &
    for attempt in $(seq 1 50); do
        if test -s /tmp/$1.pid; then return; fi
        sleep 0.1
    done
    exit 1
}
for part in auth backend front; do start "$part"; done
cleanup() {
    for part in front backend auth; do nginx -s quit -c /tmp/$part.conf >/dev/null 2>&1 || true; done
    wait
}
trap cleanup EXIT
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
# Real listener/process interruption in this synthetic network-none fixture.
for part in backend auth front; do
    pid=$(cat /tmp/$part.pid)
    nginx -s quit -c /tmp/$part.conf
    wait "$pid"
    if kill -0 "$pid" 2>/dev/null; then exit 1; fi
    if test "$part" = front; then
        if request "$base/api/auth/me"; then exit 1; fi
    else
        request "$base/api/auth/me"
        if test "$part" = backend; then test "$(status)" = 502; else test "$(status)" = 500; fi
        if grep -qi '^Set-Cookie: fixture_session=;.*Max-Age=0' /tmp/headers; then exit 1; fi
    fi
    start "$part"
    request "$base/api/auth/me"
    test "$(status)" = 200
done
request "$base/outpost.goauthentik.io/logout"
grep -qi '^Set-Cookie: fixture_session=;.*Max-Age=0' /tmp/headers
request "$base/api/auth/me"
test "$(status)" = 302
echo 'PASS: real backend/auth/proxy outages recover, refusals block access, refresh/login/logout remain effective'
'''


if __name__ == "__main__":
    name = "mergeron-session-fixture-" + uuid.uuid4().hex
    try:
        subprocess.run(
            ["docker", "run", "--rm", "-i", "--name", name, "--network", "none",
             "--label", "io.mergeron.test=session-recovery",
             "--read-only", "--user", "101:101", "--cap-drop", "ALL",
             "--security-opt", "no-new-privileges:true", "--pids-limit", "64",
             "--memory", "128m", "--cpus", "0.5",
             "--tmpfs", "/tmp:rw,nosuid,nodev,size=8m,uid=101,gid=101",
             "--tmpfs", "/var/cache/nginx:rw,nosuid,nodev,size=8m,uid=101,gid=101",
             "--entrypoint", "sh", os.environ.get("NGINX_TEST_IMAGE", "nginx:stable"),
             "-c", PROBE],
            input=fixture_bundle(), check=True, timeout=60,
        )
    finally:
        # Exact fixture only, including cleanup after a timed-out Docker client.
        subprocess.run(["docker", "rm", "--force", name],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                       timeout=10, check=False)
        remaining = subprocess.check_output(
            ["docker", "container", "ls", "--all", "--filter", "name=^/" + name + "$",
             "--format", "{{.ID}}"], text=True, timeout=10,
        ).strip()
        if remaining:
            raise RuntimeError("Owned session fixture was not removed")
