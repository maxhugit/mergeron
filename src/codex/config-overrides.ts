import type { JsonValue } from './codex-schema/serde_json/JsonValue';

/** Effective config serializes absent optionals as null; TOML overrides must omit them. */
export function transportOverrides(value: {
  [key: string]: JsonValue | undefined;
}): { [key: string]: JsonValue } {
  const result: { [key: string]: JsonValue } = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === null || entry === undefined) continue;
    result[key] = Array.isArray(entry)
      ? entry.map((item) =>
          item && typeof item === 'object' && !Array.isArray(item)
            ? transportOverrides(item)
            : item,
        )
      : typeof entry === 'object'
        ? transportOverrides(entry)
        : entry;
  }
  return result;
}
