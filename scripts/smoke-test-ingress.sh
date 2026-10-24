#!/bin/sh
# Validate both shipped templates in the real Nginx image, without any host port,
# host mount, production network, credential or persistent state.
set -eu
for template in deployment/config/nginx.conf.template deployment/config/nginx.native.conf.template; do
  docker run --rm -i --network none \
    -e MERGERON_BACKEND_TOKEN=syntax-test-only \
    --entrypoint sh nginx:stable -c \
    'envsubst '\''${MERGERON_BACKEND_TOKEN}'\'' > /tmp/nginx.conf; nginx -t -c /tmp/nginx.conf' \
    < "$template"
done
