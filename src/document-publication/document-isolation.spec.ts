import { describe, expect, it } from 'vitest';
import {
  documentAgentEnvironment,
  documentIsolationArgs,
  documentWritableRoots,
} from './document-isolation';
import { publicationRequest } from './document-publication.service';

describe('protected document execution boundary', () => {
  const plan = {
    home: '/home/codex/.codex',
    databasePath: '/home/codex/.codex/codex-webui.sqlite',
    writableRoots: ['/workspaces/p', '/workspaces'],
    publishedRoots: ['/workspaces/p/livrables', '/workspaces/p/.mergeron'],
  };
  it('canonicalizes redundant writable roots without removing any protected overlay', () => {
    const before = documentIsolationArgs(plan, 'codex', []);
    expect(
      documentIsolationArgs(
        {
          ...plan,
          writableRoots: [
            '/workspaces/p/new-clone',
            ...plan.writableRoots,
            '/workspaces/p',
          ],
        },
        'codex',
        [],
      ),
    ).toEqual(before);
    expect(
      documentWritableRoots([
        '/workspaces/a',
        '/workspaces/ab',
        '/workspaces/a/clone',
      ]),
    ).toEqual(['/workspaces/a', '/workspaces/ab']);
    for (const root of ['/etc', '/workspaces/../appdata', '/']) {
      expect(() => documentWritableRoots(['/workspaces', root])).toThrow();
    }
    for (const protectedRoot of plan.publishedRoots)
      expect(before).toContain(protectedRoot);
  });
  it('overlays retained files after writable workspaces and hides server credentials', () => {
    const args = documentIsolationArgs(plan, '/usr/bin/codex', ['app-server']);
    expect(args.indexOf('/workspaces/p/livrables')).toBeGreaterThan(
      args.indexOf('/workspaces'),
    );
    expect(args).toContain('--unshare-pid');
    expect(args.slice(-3)).toEqual(['--', '/usr/bin/codex', 'app-server']);
    expect(args).toContain('/appdata');
    for (const suffix of ['', '-wal', '-shm', '-journal'])
      expect(args).toContain(plan.databasePath + suffix);
  });
  it('rejects workspace aliases that would expose the private stack state', () => {
    for (const root of [
      '/',
      '/appdata',
      '/appdata/mergeron-dev/state',
      '/home/codex',
    ])
      expect(() =>
        documentIsolationArgs({ ...plan, writableRoots: [root] }, 'codex', []),
      ).toThrow();
  });

  it('masks system workspaces after every writable mount instead of merely making them read-only', () => {
    const root = '/workspaces/.mergeron-system';
    const args = documentIsolationArgs(
      {
        ...plan,
        writableRoots: [...plan.writableRoots, root + '/p'],
        privateRoots: [root],
      },
      'codex',
      [],
    );
    const mask = args.indexOf(root);
    expect(args[mask - 1]).toBe('--tmpfs');
    expect(args.slice(mask + 1, mask + 3)).toEqual(['--remount-ro', root]);
    expect(args).not.toContain(root + '/p'); // already covered by /workspaces
    expect(mask).toBeGreaterThan(args.indexOf('/workspaces'));
    expect(() =>
      documentIsolationArgs({ ...plan, privateRoots: ['/etc'] }, 'codex', []),
    ).toThrow('Invalid system');
  });
  it('does not forward the backend key, identity settings or manager configuration', () => {
    expect(
      documentAgentEnvironment({
        PATH: '/bin',
        HOME: '/home/codex',
        CODEX_HOME: '/home/codex/.codex',
        WEBUI_API_KEY: 'private',
        MERGERON_MANAGER_SOCKET: '/run/private',
        OIDC_CLIENT_SECRET: 'private',
        OPENAI_API_KEY_FILE: '/run/secrets/openai',
        HTTPS_PROXY: 'http://proxy',
      }),
    ).toEqual({
      PATH: '/bin',
      HOME: '/home/codex',
      CODEX_HOME: '/home/codex/.codex',
      HTTPS_PROXY: 'http://proxy',
    });
  });
});

describe('save a new version request', () => {
  const request = {
    requestId: 'request-1',
    resourceId: 'r',
    deliverableId: 'd',
    file: 'report.docx',
    comment: 'Updated report',
  };
  it('allows a draft request with no caller-selected project or identity', () => {
    expect(publicationRequest(request)).toEqual(request);
    for (const field of ['projectId', 'authorName', 'personId', 'command'])
      expect(() =>
        publicationRequest({ ...request, [field]: 'injected' }),
      ).toThrow();
  });
  it('requires an optimistic version when updating a document', () => {
    expect(() =>
      publicationRequest({ ...request, documentId: 'doc' }),
    ).toThrow();
    expect(
      publicationRequest({ ...request, documentId: 'doc', expectedVersion: 2 })
        .expectedVersion,
    ).toBe(2);
  });
  it('rejects absolute paths, traversal, nul bytes and unbounded comments', () => {
    for (const file of [
      '/etc/passwd',
      '../secret',
      'sub/../../secret',
      'a\\..\\secret',
      'a\0b',
    ])
      expect(() => publicationRequest({ ...request, file })).toThrow();
    expect(() =>
      publicationRequest({ ...request, comment: 'a'.repeat(4001) }),
    ).toThrow();
  });
});
