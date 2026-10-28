#!/usr/bin/env bash
set -Eeuo pipefail

image_ref="${1:?Usage: smoke-test-image.sh <image-ref>}"
container_name="codex-webui-smoke-${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-1}"

cleanup() {
  docker rm --force "${container_name}" >/dev/null 2>&1 || true
}

show_failure() {
  echo "Candidate container did not become healthy." >&2
  docker inspect "${container_name}" >&2 || true
  docker logs "${container_name}" >&2 || true
}

trap cleanup EXIT

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

if ! docker image inspect "${image_ref}" >/dev/null 2>&1; then
  echo "Candidate image is not available locally; pulling ${image_ref}."
  docker pull "${image_ref}"
fi

image_size_bytes="$(docker image inspect --format '{{.Size}}' "${image_ref}")"
echo "Candidate image size: ${image_size_bytes} bytes."

if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  printf '### Production image\n\n- Size: **%s bytes**\n' "${image_size_bytes}" >>"${GITHUB_STEP_SUMMARY}"
fi

# Development headers and Python packaging tools belong to builder stages. This
# assertion prevents them from silently returning to the published image while
# also checking that the copied Office environment remains usable.
docker run --rm --entrypoint /bin/bash "${image_ref}" -euc '
  for package in python3-pip libssl-dev zlib1g-dev libbz2-dev \
    libreadline-dev libsqlite3-dev libffi-dev liblzma-dev tk-dev uuid-dev \
    7zip p7zip-full p7zip libxml2-dev python3-libxml2; do
    if dpkg-query --show "${package}" >/dev/null 2>&1; then
      echo "Unexpected runtime package: ${package}" >&2
      exit 1
    fi
  done
  /opt/office-venv/bin/python -c \
    "from PIL import Image; import docx, openpyxl, pypdf, pptx, reportlab"
'

# Exercise the installed CLI against a local fixture without GitHub credentials.
docker run --rm --interactive --entrypoint python3 "${image_ref}" \
  - < "${script_dir}/smoke-test-gh.py"

# Run the built adapters with the exact Linux binary delivered to users.
bash "${script_dir}/smoke-test-prepopulated-home.sh" "${image_ref}"

bash "${script_dir}/smoke-test-visual-image.sh" "${image_ref}"

docker run --rm --interactive "${image_ref}" node \
  - < "${script_dir}/smoke-test-archives.cjs"

docker run --detach \
  --name "${container_name}" \
  --env NODE_ENV=production \
  --env PORT=8172 \
  --env WEBUI_API_KEY=github-actions-smoke-test \
  --env WEBUI_DB_PATH=/tmp/codex-webui-smoke.sqlite \
  "${image_ref}" >/dev/null

for _ in $(seq 1 60); do
  state="$(docker inspect --format '{{.State.Status}}' "${container_name}")"
  health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "${container_name}")"

  if [[ "${health}" == "healthy" ]]; then
    echo "Candidate container is healthy."
    exit 0
  fi

  if [[ "${state}" == "exited" || "${state}" == "dead" ]]; then
    show_failure
    exit 1
  fi

  sleep 2
done

show_failure
exit 1
