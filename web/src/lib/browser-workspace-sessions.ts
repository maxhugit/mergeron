import { browserApi } from './browser-api';
import { withBasePath } from '@/base-path';
import {
  useWorkspaceStore,
  type WorkspaceContext,
  type WorkspaceTab,
} from '@/stores/workspace-store';

/** Only view identifiers and layout are saved, never URLs, pixels, inputs or credentials. */
export function browserWorkspaceSnapshot(
  contexts: Record<string, WorkspaceContext>,
) {
  return Object.fromEntries(
    Object.entries(contexts)
      .filter(
        ([key, context]) =>
          key.startsWith('thread:') &&
          context.tabs.some(
            (tab) => tab.kind === 'browser' && tab.mode !== 'local',
          ),
      )
      .slice(-64)
      .map(([key, context]) => {
        const tabs = context.tabs
          .filter((tab) => tab.kind === 'browser')
          .filter((tab) => tab.mode !== 'local')
          .map((tab) => ({
            id: tab.id,
            kind: 'browser' as const,
            number: tab.number,
            opened: tab.opened === true,
          }));
        return [
          key,
          {
            tabs,
            activeId: tabs.some((tab) => tab.id === context.activeId)
              ? context.activeId
              : 'conversation',
            browserDocked: context.browserDocked === true,
            lastBrowserId: context.lastBrowserId,
          },
        ];
      }),
  );
}

export function readBrowserWorkspaces(
  raw: string | null,
): Record<string, WorkspaceContext> {
  if (!raw || raw.length > 64_000) return {};
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const result: Record<string, WorkspaceContext> = {};
    for (const [key, candidate] of Object.entries(value).slice(-64)) {
      if (
        !key.startsWith('thread:') ||
        key.length > 160 ||
        !candidate ||
        typeof candidate !== 'object'
      )
        continue;
      const row = candidate as Record<string, unknown>;
      if (!Array.isArray(row.tabs)) continue;
      const tabs: WorkspaceTab[] = [];
      for (const item of row.tabs.slice(0, 5) as unknown[]) {
        if (!item || typeof item !== 'object') continue;
        const tab = item as Record<string, unknown>;
        if (
          tab.kind !== 'browser' ||
          tab.mode === 'local' ||
          typeof tab.id !== 'string' ||
          !/^browser-[1-5]$/.test(tab.id) ||
          tabs.some((entry) => entry.id === tab.id)
        )
          continue;
        tabs.push({
          id: tab.id,
          kind: 'browser',
          opened: tab.opened === true,
          number:
            typeof tab.number === 'number' &&
            Number.isSafeInteger(tab.number) &&
            tab.number > 0
              ? tab.number
              : 1,
        });
      }
      if (!tabs.length) continue;
      result[key] = {
        tabs,
        activeId: tabs.some((tab) => tab.id === row.activeId)
          ? String(row.activeId)
          : 'conversation',
        browserDocked: row.browserDocked === true,
        lastBrowserId: tabs.some((tab) => tab.id === row.lastBrowserId)
          ? String(row.lastBrowserId)
          : tabs.at(-1)!.id,
      };
    }
    return result;
  } catch {
    return {};
  }
}

/** Lives in the authenticated shell, not in a conversation that navigation unmounts. */
export function installBrowserWorkspaceSessions(
  owner: string,
  storage?: Storage,
) {
  const key = `mergeron.browser-views.v1:${withBasePath('/')}:${owner}`;
  let saved: Record<string, WorkspaceContext> = {};
  try {
    storage ??= sessionStorage;
    saved = readBrowserWorkspaces(storage.getItem(key));
  } catch {
    /* In-memory navigation still works. */
  }
  useWorkspaceStore.getState().restoreBrowsers(saved);
  let previous = '';
  const save = () => {
    const serialized = JSON.stringify(
      browserWorkspaceSnapshot(useWorkspaceStore.getState().contexts),
    );
    if (serialized === previous) return;
    previous = serialized;
    try {
      storage?.setItem(key, serialized);
    } catch {
      /* Storage can be disabled. */
    }
  };
  save();
  const unsubscribe = useWorkspaceStore.subscribe(save);
  const abort = new AbortController();
  let pending = false;
  const heartbeat = async () => {
    if (pending || abort.signal.aborted) return;
    pending = true;
    try {
      await Promise.all(
        Object.entries(useWorkspaceStore.getState().contexts)
          .filter(([context]) => context.startsWith('thread:'))
          .flatMap(([context, workspace]) =>
            workspace.tabs
              .filter(
                (tab) =>
                  tab.kind === 'browser' && tab.mode !== 'local' && tab.opened,
              )
              .map((tab) =>
                browserApi(
                  `/${encodeURIComponent(context.slice(7))}/keepalive`,
                  { instanceId: tab.id },
                  abort.signal,
                ).catch(() => {}),
              ),
          ),
      );
    } finally {
      pending = false;
    }
  };
  const timer = setInterval(() => void heartbeat(), 60_000);
  void heartbeat();
  return () => {
    abort.abort();
    clearInterval(timer);
    unsubscribe();
  };
}
