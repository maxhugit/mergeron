#!/usr/bin/env bash
set -Eeuo pipefail
image_ref="${1:?Usage: smoke-test-browser-image.sh <browser-image>}"
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
