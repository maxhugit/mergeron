#!/bin/sh
# Validate both templates and real redirect headers, without any host port,
# host mount, production network, credential or persistent state.
set -eu
for template in deployment/config/nginx.conf.template deployment/config/nginx.native.conf.template; do
  docker run --rm -i --network none \
    -e MERGERON_BACKEND_TOKEN=syntax-test-only \
    -e MERGERON_PREVIEW_DOMAIN=preview.example.test \
    --entrypoint sh nginx:stable -c \
    'set -eu
     envsubst '\''${MERGERON_BACKEND_TOKEN} ${MERGERON_PREVIEW_DOMAIN}'\'' | sed '\''/^        listen 8080;$/a\
        location = /__redirect_probe { return 302 /__redirect_target; }
'\'' > /tmp/nginx.conf
     nginx -t -c /tmp/nginx.conf
     nginx -c /tmp/nginx.conf
     trap '\''nginx -s quit -c /tmp/nginx.conf >/dev/null 2>&1'\'' EXIT
     for authority in example.test example.test:8443; do
       headers=$(curl --fail --silent --show-error --max-time 5 -D - -o /dev/null \
         -H "Host: $authority" -H "X-Forwarded-Proto: https" \
         http://127.0.0.1:8080/__redirect_probe)
       location=$(printf "%s\n" "$headers" | tr -d "\r" | sed -n "s/^[Ll]ocation: //p")
       test "$location" = /__redirect_target || { echo "Redirect exposed an internal origin" >&2; exit 1; }
     done' \
    < "$template"
done
python3 scripts/test-session-ingress.py
