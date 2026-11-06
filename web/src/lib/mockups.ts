import { projectsApi } from './projects-api';
export interface MockupReference {
  type: 'mergeron.mockup';
  projectId: string;
  threadId: string;
  id: string;
  revision: string;
  number: number;
  title: string;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function mockupReference(value: unknown): MockupReference | undefined {
  if (!value || typeof value !== 'object') return;
  const ref = value as Record<string, unknown>;
  if (
    ref.type !== 'mergeron.mockup' ||
    !['id', 'revision', 'projectId'].every(
      (k) => typeof ref[k] === 'string' && uuid.test(ref[k] as string),
    ) ||
    typeof ref.threadId !== 'string' ||
    !/^[A-Za-z0-9_-]{1,100}$/.test(ref.threadId) ||
    typeof ref.title !== 'string' ||
    ref.title.length > 160 ||
    !Number.isSafeInteger(ref.number) ||
    Number(ref.number) < 1
  )
    return;
  return ref as unknown as MockupReference;
}
/** Only the internal server's presentation tool produces a card; never parse message HTML. */
export function presentedMockup(
  server: unknown,
  tool: unknown,
  result: unknown,
): MockupReference | undefined {
  if (
    server !== 'mergeron_internal' ||
    tool !== 'project_mockup_report' ||
    !result ||
    typeof result !== 'object'
  )
    return;
  const value = result as {
    isError?: boolean;
    structuredContent?: { reference?: unknown };
    content?: Array<{ type?: string; text?: string }>;
  };
  if (value.isError) return;
  if (value.structuredContent)
    return mockupReference(value.structuredContent.reference);
  const text = value.content?.find((p) => p.type === 'text')?.text;
  if (!text || text.length > 2048) return;
  try {
    return mockupReference(
      (JSON.parse(text) as { reference?: unknown }).reference,
    );
  } catch {
    return;
  }
}
export interface MockupDocument {
  reference: MockupReference;
  html: string;
  currentRevision: string;
  history: Array<{
    id: string;
    number: number;
    title: string;
    authorName: string;
    createdAt: number;
  }>;
}
export function readMockup(ref: MockupReference, signal?: AbortSignal) {
  return projectsApi<MockupDocument>(
    `/${encodeURIComponent(ref.projectId)}/conversations/${encodeURIComponent(ref.threadId)}/mockups/${encodeURIComponent(ref.id)}?revision=${encodeURIComponent(ref.revision)}`,
    { signal },
  );
}
