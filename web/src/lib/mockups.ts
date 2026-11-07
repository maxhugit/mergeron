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
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
/** Fail closed on login HTML, malformed JSON or a mismatched source response. */
export function parseMockupDocument(
  value: unknown,
  expected: MockupReference,
): MockupDocument {
  const fail = () => {
    throw new Error('Invalid mockup response');
  };
  if (!record(value)) return fail();
  const ref = mockupReference(value.reference);
  if (
    !ref ||
    ['projectId', 'threadId', 'id', 'revision'].some(
      (key) =>
        ref[key as keyof MockupReference] !==
        expected[key as keyof MockupReference],
    ) ||
    typeof value.html !== 'string' ||
    value.html.length > 24 * 1024 ||
    typeof value.currentRevision !== 'string' ||
    !uuid.test(value.currentRevision) ||
    !Array.isArray(value.history) ||
    value.history.length < 1 ||
    value.history.length > 100
  )
    return fail();
  const history = value.history.map((row: unknown) => {
    if (
      !record(row) ||
      typeof row.id !== 'string' ||
      !uuid.test(row.id) ||
      typeof row.number !== 'number' ||
      !Number.isSafeInteger(row.number) ||
      row.number < 1 ||
      row.number > 100 ||
      typeof row.title !== 'string' ||
      row.title.length > 160 ||
      typeof row.authorName !== 'string' ||
      row.authorName.length > 1024 ||
      typeof row.createdAt !== 'number' ||
      !Number.isFinite(row.createdAt)
    )
      return fail();
    return {
      id: row.id,
      number: row.number,
      title: row.title,
      authorName: row.authorName,
      createdAt: row.createdAt,
    };
  });
  if (
    !history.some(
      (row) =>
        row.id === ref.revision &&
        row.number === ref.number &&
        row.title === ref.title,
    ) ||
    !history.some((row) => row.id === value.currentRevision) ||
    new Set(history.map((row) => row.id)).size !== history.length
  )
    return fail();
  return {
    reference: ref,
    html: value.html,
    currentRevision: value.currentRevision,
    history,
  };
}
export async function readMockup(ref: MockupReference, signal?: AbortSignal) {
  const result = await projectsApi<unknown>(
    `/${encodeURIComponent(ref.projectId)}/conversations/${encodeURIComponent(ref.threadId)}/mockups/${encodeURIComponent(ref.id)}?revision=${encodeURIComponent(ref.revision)}`,
    { signal },
  );
  return parseMockupDocument(result, ref);
}
