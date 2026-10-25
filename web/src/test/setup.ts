/**
 * Global test setup: DOM matchers, and unmounting rendered trees between tests
 * so DOM state never leaks.
 */
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';
import enAuthentication from '@/locales/en/authentication.json';
import enCommon from '@/locales/en/common.json';
import enProjectArchives from '@/locales/en/projectArchives.json';
import enDeliverables from '@/locales/en/deliverables.json';
import i18n, { i18nReady } from '@/i18n';

const flatten = (
  value: unknown,
  prefix = '',
  output: Record<string, string> = {},
) => {
  if (typeof value === 'string') {
    output[prefix] = value;
    return output;
  }
  for (const [key, child] of Object.entries(value as object)) {
    flatten(child, prefix ? `${prefix}.${key}` : key, output);
  }
  return output;
};

const english = {
  ...flatten(enCommon),
  ...flatten(enAuthentication),
  ...flatten(enProjectArchives),
  ...flatten(enDeliverables),
};

declare global {
  // Test doubles use the real English catalog instead of assuming keys are copy.
  var __testTranslate: (
    key: string,
    values?: Record<string, unknown>,
  ) => string;
}

globalThis.__testTranslate = (key, values = {}) => {
  const pluralKey =
    typeof values.count === 'number'
      ? `${key}_${values.count === 1 ? 'one' : 'other'}`
      : key;
  return Object.entries(values).reduce(
    (text, [name, value]) =>
      text.replace(new RegExp(`{{\\s*${name}[^}]*}}`, 'g'), String(value)),
    english[pluralKey] ?? english[key] ?? key,
  );
};

await i18nReady;
await i18n.changeLanguage('en');

// Drag-and-drop measures rows through ResizeObserver. jsdom does not provide
// it, but sidebar unit tests only need the observer lifecycle, not geometry.
class TestResizeObserver implements ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

globalThis.ResizeObserver = TestResizeObserver;

afterEach(cleanup);
