/** Optional, untrusted presentation preferences; never permissions, tool input or server state. */
export type PresentationValue =
  | null
  | boolean
  | number
  | string
  | PresentationValue[]
  | { [key: string]: PresentationValue };
export type PresentationState = { [key: string]: PresentationValue };
export const MAX_PRESENTATION_BYTES = 4096;
const STORAGE = 'mergeron.mockup.presentation.v1';
const MAX_ENTRIES = 20;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export function presentationState(
  value: unknown,
): PresentationState | undefined {
  let nodes = 0;
  const valid = (item: unknown, depth: number): boolean => {
    if (++nodes > 256 || depth > 6) return false;
    if (item === null || typeof item === 'boolean') return true;
    if (typeof item === 'number') return Number.isFinite(item);
    if (typeof item === 'string') return item.length <= 256;
    if (Array.isArray(item))
      return item.length <= 40 && item.every((v) => valid(v, depth + 1));
    if (typeof item !== 'object') return false;
    const entries = Object.entries(item);
    return (
      entries.length <= 40 &&
      entries.every(
        ([key, v]) =>
          key.length <= 64 &&
          !['__proto__', 'constructor', 'prototype'].includes(key) &&
          valid(v, depth + 1),
      )
    );
  };
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !valid(value, 0)
  )
    return;
  try {
    if (
      new TextEncoder().encode(JSON.stringify(value)).byteLength <=
      MAX_PRESENTATION_BYTES
    )
      return value as PresentationState;
  } catch {
    return;
  }
}
interface Entry {
  key: string;
  state: PresentationState | null;
  at: number;
}
function entries(now: number): Entry[] {
  try {
    const raw = localStorage.getItem(STORAGE);
    if (!raw || raw.length > 100000) return [];
    const data: unknown = JSON.parse(raw);
    if (!Array.isArray(data) || data.length > MAX_ENTRIES) return [];
    return data.filter((entry): entry is Entry => {
      if (!entry || typeof entry !== 'object') return false;
      const e = entry as Partial<Entry>;
      return (
        typeof e.key === 'string' &&
        e.key.length <= 500 &&
        typeof e.at === 'number' &&
        Number.isFinite(e.at) &&
        e.at <= now &&
        now - e.at <= RETENTION_MS &&
        (e.state === null || Boolean(presentationState(e.state)))
      );
    });
  } catch {
    return [];
  }
}
export function presentationKey(
  owner: string,
  projectId: string,
  threadId: string,
  id: string,
  revision: string,
) {
  return JSON.stringify([owner, projectId, threadId, id, revision]);
}
export function readPresentation(key: string, now = Date.now()) {
  const entry = entries(now).find((e) => e.key === key);
  return { enabled: Boolean(entry), state: entry?.state ?? null };
}
/** A human checkbox opts in. Expiration/eviction affects these preferences, never sources. */
export function writePresentation(
  key: string,
  value: PresentationState | null,
  enabled: boolean,
  now = Date.now(),
): boolean {
  if (key.length > 500 || (value !== null && !presentationState(value)))
    return false;
  try {
    const current = entries(now).filter((e) => e.key !== key);
    if (enabled) current.push({ key, state: value, at: now });
    current.sort((a, b) => b.at - a.at);
    localStorage.setItem(
      STORAGE,
      JSON.stringify(current.slice(0, MAX_ENTRIES)),
    );
    return true;
  } catch {
    return false;
  }
}

/** Known permanent deletions clear local preferences too; never called for ordinary view eviction. */
export function forgetPresentations(scope: {
  projectId?: string;
  threadIds?: readonly string[];
}) {
  const threads = new Set(scope.threadIds ?? []);
  try {
    const kept = entries(Date.now()).filter((entry) => {
      try {
        const key: unknown = JSON.parse(entry.key);
        return (
          Array.isArray(key) &&
          key.length === 5 &&
          !(scope.projectId && key[1] === scope.projectId) &&
          !threads.has(String(key[2]))
        );
      } catch {
        return false;
      }
    });
    localStorage.setItem(STORAGE, JSON.stringify(kept));
  } catch {
    /* Local storage can be unavailable. Canonical source deletion is server-side. */
  }
}
