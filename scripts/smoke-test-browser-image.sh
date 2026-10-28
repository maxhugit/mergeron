#!/usr/bin/env bash
set -Eeuo pipefail
image_ref="${1:?Usage: smoke-test-browser-image.sh <browser-image>}"
docker run --rm --network none --entrypoint node "$image_ref" --input-type=module -e '
  import { chromium } from "playwright-core";
  import { existsSync } from "node:fs";
  if (!existsSync(chromium.executablePath())) throw new Error("Chromium missing");
  for (const root of ["/usr/lib/node_modules/", "/usr/local/lib/node_modules/"]) {
    for (const name of ["npm", "yarn"]) {
      if (existsSync(root + name)) throw new Error("Build package manager retained");
    }
  }
  // Isolated CI smoke, with no network/credentials. Production still enforces
  // chromiumSandbox: true; this does not relax server.mjs or browser policy.
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.setContent("<h1>Browser runtime smoke test</h1>");
  if (await page.locator("h1").innerText() !== "Browser runtime smoke test") throw new Error("Chromium failed");
  await browser.close();
'
