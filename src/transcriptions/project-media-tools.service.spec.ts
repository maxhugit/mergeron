import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { ProjectMediaToolsService } from './project-media-tools.service';
import { mediaTestDatabase } from './media-database.testing';
import { accessContext } from '../auth/access-context';
import type {
  IdentityService,
  PlatformIdentity,
} from '../auth/identity.service';
import type { TranscriptionsService } from './transcriptions.service';
import type { DeliverablesService } from '../deliverables/deliverables.service';
const extra = `CREATE TABLE project_agent_threads(thread_id text PRIMARY KEY,project_id text,workspace_path text,archived_at integer,archived_by_person_id text,archived_by_name text,archived_by_type text,created_at integer,updated_at integer);
CREATE TABLE project_agent_tool_requests(project_id text,thread_id text,request_id text,digest text,person_id text,result text,created_at integer,PRIMARY KEY(project_id,thread_id,request_id));
INSERT INTO project_agent_threads(thread_id,project_id) VALUES('thread','project');`;
const id = '12345678-1234-4234-8234-123456789012';
const source = {
  resourceId: 'board',
  deliverableId: 'deliverable',
  documentId: 'video',
  versionId: 'v1',
};
const identity: PlatformIdentity = {
  kind: 'person',
  personId: 'person',
  active: true,
  name: 'Person',
  role: 'administrator',
};
describe('bound media MCP tools', () => {
  let fixture: ReturnType<typeof mediaTestDatabase>,
    service: ProjectMediaToolsService,
    root: string;
  let media: {
    status: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
    audioDownload: ReturnType<typeof vi.fn>;
  };
  let deliverables: {
    get: ReturnType<typeof vi.fn>;
    documents: ReturnType<typeof vi.fn>;
    documentVersionFile: ReturnType<typeof vi.fn>;
    uploadDocuments: ReturnType<typeof vi.fn>;
  };
  const row = () => ({
    id,
    projectId: 'project',
    threadId: 'thread',
    state: 'ready',
    operation: 'extract',
    audio: {
      filename: 'video-' + id + '.mp3',
      size: 3,
      sha256: 'a'.repeat(64),
    },
    result: null,
    error: null,
  });
  const identities = {
    requireActive: vi.fn(),
    requireThread: vi.fn(),
    requireProject: vi.fn(),
    requireAdministrator: vi.fn(),
  };
  const context = (fn: () => Promise<unknown>) =>
    accessContext.run(
      { identity, identities: identities as unknown as IdentityService },
      fn,
    );
  const call = (
    input: Record<string, unknown>,
    write = true,
    check = () => {},
  ) => context(() => service.tool('project', 'thread', input, check, write));
  beforeEach(async () => {
    fixture = mediaTestDatabase(extra);
    root = await mkdtemp(join(tmpdir(), 'media-mcp-'));
    const file = join(root, 'video.mp4');
    await writeFile(file, 'video');
    media = {
      status: vi.fn().mockResolvedValue({ enabled: true }),
      create: vi.fn().mockResolvedValue(row()),
      get: vi.fn().mockImplementation(row),
      remove: vi.fn().mockResolvedValue({ removed: true }),
      audioDownload: vi.fn().mockImplementation(() =>
        Promise.resolve({
          filename: 'video-' + id + '.mp3',
          size: 3,
          stream: Readable.from(['mp3']),
        }),
      ),
    };
    deliverables = {
      get: vi.fn().mockReturnValue({ id: 'deliverable' }),
      documents: vi.fn().mockReturnValue([]),
      documentVersionFile: vi.fn().mockResolvedValue({
        path: file,
        document: { name: 'video.mp4' },
        version: { size: 5, sha256: 'a'.repeat(64) },
      }),
      uploadDocuments: vi.fn().mockResolvedValue({
        files: [{ path: '/workspace/livrables/audio.mp3', size: 3 }],
      }),
    };
    service = new ProjectMediaToolsService(
      fixture.db,
      media as unknown as TranscriptionsService,
      deliverables as unknown as DeliverablesService,
    );
  });
  afterEach(async () => {
    fixture.sqlite.close();
    await rm(root, { recursive: true, force: true });
    vi.clearAllMocks();
  });
  it('refuses calls without a live authenticated context', async () => {
    await expect(
      service.tool(
        'project',
        'thread',
        { tool: 'project_media_read', operation: 'status' },
        () => {},
        false,
      ),
    ).rejects.toThrow('MEDIA_AUTHENTICATED_TURN_REQUIRED');
  });
  it('refuses caller-supplied paths and read-only mutations', async () => {
    await expect(
      call({
        tool: 'project_media_manage',
        operation: 'start',
        requestId: 'r',
        mode: 'extract',
        source,
        userRequest: 'Extract',
        path: '/etc/passwd',
      }),
    ).rejects.toThrow('MEDIA_INVALID_REQUEST');
    await expect(
      call(
        {
          tool: 'project_media_manage',
          operation: 'start',
          requestId: 'r',
          mode: 'extract',
          source,
          userRequest: 'Extract',
        },
        false,
      ),
    ).rejects.toThrow('READ_ONLY');
    expect(media.create).not.toHaveBeenCalled();
  });
  it('binds a source to the project and uses its immutable version digest', async () => {
    const input = {
      tool: 'project_media_manage',
      operation: 'start',
      requestId: 'extract-1',
      mode: 'extract',
      source,
      userRequest: 'Extract audio',
    };
    await call(input);
    await call(input);
    expect(deliverables.documentVersionFile).toHaveBeenCalledWith(
      'project',
      'board',
      'deliverable',
      'video',
      'v1',
    );
    const options = media.create.mock.calls[0][4] as { requestKey: string };
    expect(options).toMatchObject({
      projectId: 'project',
      threadId: 'thread',
      operation: 'extract',
      expectedSha256: 'a'.repeat(64),
    });
    expect(options.requestKey).toBe(
      (media.create.mock.calls[1][4] as { requestKey: string }).requestKey,
    );
  });
  it('does not expose another conversation’s job', async () => {
    media.get.mockReturnValue({ ...row(), threadId: 'other' });
    await expect(
      call({ tool: 'project_media_read', operation: 'job', jobId: id }),
    ).rejects.toThrow('MEDIA_JOB_NOT_FOUND');
  });
  it('detects a changed project binding before touching files', async () => {
    fixture.sqlite.exec("UPDATE project_agent_threads SET project_id='other'");
    await expect(
      call({
        tool: 'project_media_manage',
        operation: 'start',
        requestId: 'r',
        mode: 'extract',
        source,
        userRequest: 'Extract',
      }),
    ).rejects.toThrow('MEDIA_PROJECT_CHANGED');
    expect(deliverables.documentVersionFile).not.toHaveBeenCalled();
  });
  it('publishes via the versioned workflow once and supplies a live commit guard', async () => {
    const input = {
      tool: 'project_media_manage',
      operation: 'publish',
      requestId: 'publish-1',
      jobId: id,
      target: { resourceId: 'board', deliverableId: 'target' },
      userRequest: 'Save audio here',
    };
    const check = vi.fn();
    const first = await call(input, true, check);
    const second = await call(input, true, check);
    expect(first).toEqual(second);
    expect(deliverables.uploadDocuments).toHaveBeenCalledTimes(1);
    const guard = (
      deliverables.uploadDocuments.mock.calls[0][4] as {
        beforeCommit: () => void;
      }
    ).beforeCommit;
    guard();
    expect(check).toHaveBeenCalled();
  });
  it('never retries an uncertain publication under its stable request id', async () => {
    const input = {
      tool: 'project_media_manage',
      operation: 'publish',
      requestId: 'publish-1',
      jobId: id,
      target: { resourceId: 'board', deliverableId: 'target' },
      userRequest: 'Save audio',
    };
    deliverables.uploadDocuments.mockRejectedValue(Error('interrupted'));
    await expect(call(input)).rejects.toThrow('interrupted');
    await expect(call(input)).rejects.toThrow('MEDIA_PUBLICATION_UNCONFIRMED');
    expect(deliverables.uploadDocuments).toHaveBeenCalledTimes(1);
  });
});
