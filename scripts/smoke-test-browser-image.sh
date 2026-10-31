#!/usr/bin/env bash
set -Eeuo pipefail
image_ref="${1:?Usage: smoke-test-browser-image.sh <browser-image>}"
# Check product identity on the built image, not on a previously created container.
docker image inspect "$image_ref" --format '{{json .Config.Labels}}' | node --input-type=module -e '
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  const labels = JSON.parse(input);
  if (!/^\d+\.\d+\.\d+$/.test(labels["io.mergeron.version"] ?? "")) throw new Error("Browser product version missing");
  if (!/^[a-f0-9]{40}$/.test(labels["org.opencontainers.image.revision"] ?? "")) throw new Error("Browser revision missing");
  if (!["edge", "stable"].includes(labels["io.mergeron.channel"])) throw new Error("Browser build channel missing");
  if (!Number.isFinite(Date.parse(labels["org.opencontainers.image.created"]))) throw new Error("Browser build date missing");
'
docker run --rm --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --security-opt "seccomp=$(pwd)/deployment/config/seccomp-bwrap.json" \
  --tmpfs /tmp:rw,nosuid,nodev,size=512m,mode=1777 --shm-size 256m \
  --pids-limit 256 --memory 1g --entrypoint node "$image_ref" --input-type=module -e '
  import { chromium } from "playwright-core";
  import { existsSync } from "node:fs";
  if (!existsSync(chromium.executablePath())) throw new Error("Chromium missing");
  for (const root of ["/usr/lib/node_modules/", "/usr/local/lib/node_modules/"]) {
    for (const name of ["npm", "yarn"]) {
      if (existsSync(root + name)) throw new Error("Build package manager retained");
    }
  }
  // Same non-root Chromium sandbox/seccomp as deployment; no network or credentials.
  const browser = await chromium.launch({ headless: true, chromiumSandbox: true });
  const page = await browser.newPage();
  await page.setContent("<h1>Browser runtime smoke test</h1>");
  if (await page.locator("h1").innerText() !== "Browser runtime smoke test") throw new Error("Chromium failed");
  await browser.close();
'
