import { expect, it } from 'vitest';
import { isPreviewHost, isPreviewOrigin } from './preview-origin';
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
it('separates preview-origin fetch/form requests from navigation back to Mergeron', () => {
  expect(
    isPreviewOrigin('https://id.preview.example.org', 'preview.example.org'),
  ).toBe(true);
  expect(
    isPreviewOrigin('https://mergeron.example.org', 'preview.example.org'),
  ).toBe(false);
  expect(isPreviewOrigin(undefined, 'preview.example.org')).toBe(false);
  expect(isPreviewOrigin('null', 'preview.example.org')).toBe(false);
  expect(
    isPreviewOrigin(
      'https://id.preview.example.org.attacker.net',
      'preview.example.org',
    ),
  ).toBe(false);
});
