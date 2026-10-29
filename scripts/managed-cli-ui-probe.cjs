/** Disposable network-none appliance only. No real account or browser profile. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('/app/node_modules/playwright-core');

(async () => {
  const output = '/workspaces/.managed-cli-ui';
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({
    headless: true,
    chromiumSandbox: true,
  });
  try {
    for (const [name, viewport] of [
      ['desktop', { width: 1440, height: 900 }],
      ['mobile', { width: 412, height: 839 }],
    ]) {
      // Fresh contexts exercise real phone entry, not a desktop preference
      // retained across a synthetic resize before the shell has re-rendered.
      const context = await browser.newContext({ locale: 'fr-FR', viewport });
      await context.addInitScript((token) => {
        sessionStorage.setItem('codex.webui.jwt', token);
        localStorage.setItem('i18nextLng', 'fr');
      }, process.env.WEBUI_API_KEY);
      const page = await context.newPage();
      page.setDefaultTimeout(60_000);
      await page.goto('http://127.0.0.1:8172/settings?section=codexCli');
      const install = page.getByRole('button', {
        name: 'Installer le CLI validé du Manager',
        exact: true,
      });
      await install.waitFor();
      assert(
        await install.isDisabled(),
        'already-selected immutable release is not reinstalled',
      );
      assert(
        (await page.locator('body').innerText()).includes('Intégrité vérifiée'),
      );
      if (name === 'mobile') {
        const heading = await page
          .getByRole('heading', {
            name: 'Codex CLI sur ce serveur',
            exact: true,
          })
          .boundingBox();
        assert(
          heading && heading.width >= viewport.width * 0.7,
          'phone settings must use the available width',
        );
      }
      assert(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
        'settings must not overflow horizontally',
      );
      await page.screenshot({ path: `${output}/${name}.png`, fullPage: true });
      await context.close();
    }
    console.log(
      'PASS: actual CLI settings show verified identity and Manager controls at desktop/mobile sizes',
    );
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
