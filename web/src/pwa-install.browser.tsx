import { expect, test } from 'vitest';
import { commands } from 'vitest/browser';

declare module 'vitest/browser' {
  interface BrowserCommands {
    authenticatedManifest: () => Promise<{
      skipped: boolean;
      data?: string;
      errors?: string[];
      installErrors?: string[];
    }>;
  }
}
test('Chromium can fetch and install the authenticated development manifest', async () => {
  const result = await commands.authenticatedManifest();
  if (result.skipped) return;
  expect(result.errors).toEqual([]);
  expect(JSON.parse(result.data!)).toMatchObject({
    name: 'Mergeron Dev',
    display: 'standalone',
  });
  expect(result.installErrors).toEqual([]);
});
