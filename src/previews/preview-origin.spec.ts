import { expect, it } from 'vitest';
import { isPreviewHost } from './preview-origin';
it('never serves the authenticated Mergeron SPA under a preview origin, even with old ingress configuration', () => {
  expect(isPreviewHost('abc.preview.example.org', 'preview.example.org')).toBe(
    true,
  );
  expect(
    isPreviewHost('ABC.preview.example.org.:443', 'preview.example.org'),
  ).toBe(true);
  expect(isPreviewHost('preview.example.org', 'preview.example.org')).toBe(
    true,
  );
  expect(isPreviewHost('mergeron.example.org', 'preview.example.org')).toBe(
    false,
  );
  expect(isPreviewHost('evilpreview.example.org', 'preview.example.org')).toBe(
    false,
  );
  expect(
    isPreviewHost(
      'abc.preview.example.org.attacker.net',
      'preview.example.org',
    ),
  ).toBe(false);
});
