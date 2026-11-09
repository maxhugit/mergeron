/** Real reading/source/split UI, with only the file boundary and Monaco adapter controlled. */
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { page } from 'vitest/browser';
import { CodeViewer } from './code-viewer';
import { FileViewer } from '../file-viewer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { getDocumentForPath, useDocumentStore } from '@/stores/document-store';
import { useWorkspaceStore } from '@/stores/workspace-store';
import i18n, { i18nReady } from '@/i18n';
import '@/index.css';

const io = vi.hoisted(() => ({
  read: vi.fn(),
  write: vi.fn(),
  create: vi.fn(),
  reveal: vi.fn(),
  restored: vi.fn(),
}));
vi.mock('@/generated/api/sdk.gen', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/generated/api/sdk.gen')>()),
  filesReadFile: io.read,
  filesWriteFile: io.write,
  filesCreateFile: io.create,
  filesGetMetadata: async () => ({ data: { type: 'file' } }),
  settingsListSettings: async () => ({ data: { settings: [] } }),
}));
vi.mock('@monaco-editor/react', async () => {
  const { useEffect } = await import('react');
  const models = new Map<string, ReturnType<typeof makeModel>>();
  function makeModel(
    text: string,
    uri: { path: string; toString: () => string },
  ) {
    let value = text;
    const listeners = new Set<() => void>();
    return {
      uri,
      getValue: () => value,
      getLineCount: () => value.split('\n').length,
      setValue: (next: string) => {
        value = next;
        listeners.forEach((fn) => fn());
      },
      onDidChangeContent: (fn: () => void) => {
        listeners.add(fn);
        return { dispose: () => listeners.delete(fn) };
      },
      dispose: () => models.delete(uri.toString()),
    };
  }
  const monaco = {
    Uri: {
      file: (path: string) => ({
        path,
        toString: () => `file://${encodeURI(path)}`,
      }),
    },
    languages: {
      getLanguages: () => [{ id: 'typescript', extensions: ['.ts'] }],
    },
    editor: {
      setModelLanguage: vi.fn(),
      createModel: (
        text: string,
        _language: unknown,
        uri: { path: string; toString: () => string },
      ) => {
        const model = makeModel(text, uri);
        models.set(uri.toString(), model);
        return model;
      },
    },
  };
  function Editor({
    path,
    onMount,
    options,
  }: {
    path: string;
    options?: { readOnly?: boolean };
    onMount: (value: unknown) => void;
  }) {
    useEffect(() => {
      const model = models.get(path);
      const subscription = () => ({ dispose: () => undefined });
      onMount({
        getModel: () => model,
        layout: () => undefined,
        restoreViewState: io.restored,
        saveViewState: () => null,
        onDidChangeCursorPosition: subscription,
        onDidScrollChange: subscription,
        onKeyDown: subscription,
        setPosition: () => undefined,
        revealLineInCenter: io.reveal,
      });
    }, [path, onMount]);
    return (
      <textarea
        aria-label="Markdown source"
        readOnly={options?.readOnly}
        style={{
          width: '100%',
          height: '100%',
          padding: 12,
          background: '#202124',
          color: '#eee',
          resize: 'none',
        }}
        defaultValue={models.get(path)?.getValue()}
        onChange={(event) => models.get(path)?.setValue(event.target.value)}
      />
    );
  }
  return { default: Editor, loader: { init: async () => monaco } };
});

const content =
  '# Cadrage du site BBCC\n\nLe site réunit les membres du club et accompagne les nouvelles adhésions.\n\n## Publics et usages\n\n- Visiteurs : découvrir le club\n- Membres : accéder aux informations\n\n## Niveaux d’accès\n\n| Public | Accès |\n| --- | --- |\n| Visiteurs | Informations publiques |\n| Membres | Espace privé |\n\n> Les informations personnelles restent protégées.\n\n## Décisions\n\n' +
  'Un paragraphe de cadrage pour éprouver le défilement.\n\n'.repeat(12);
afterEach(() => {
  cleanup();
  document.documentElement.classList.remove('dark');
});
beforeEach(async () => {
  await i18nReady;
  await i18n.changeLanguage('fr');
  useDocumentStore.setState({ documents: {}, pathIndex: {} });
  useWorkspaceStore.setState({ contexts: {}, fileViews: {} });
  io.read.mockResolvedValue({ data: { content, mtime: 10 } });
  io.write.mockResolvedValue({ data: { mtime: 11 } });
});
test.each([390, 1280])(
  'reads, edits and previews one shared Markdown draft at %ipx',
  async (width) => {
    await page.viewport(width, 850);
    render(
      <div style={{ height: 810 }}>
        <CodeViewer filePath="/cadrage.md" viewId="md-browser" active />
      </div>,
    );
    expect(
      await screen.findByRole('heading', { name: 'Cadrage du site BBCC' }),
    ).toBeVisible();
    await page.screenshot({
      path: `../../../../.vitest-screenshots/markdown-top-${width}.png`,
    });
    await page
      .getByRole('link', { name: 'Niveaux d’accès', exact: true })
      .click();
    expect(
      screen.getByRole('heading', { name: 'Niveaux d’accès' }),
    ).toBeVisible();
    await page.screenshot({
      path: `../../../../.vitest-screenshots/markdown-reading-${width}.png`,
    });
    await page
      .getByRole('button', { name: 'Vue partagée', exact: true })
      .click();
    await page
      .getByRole('textbox', { name: 'Markdown source' })
      .fill('# Texte révisé\n\nUne nouvelle proposition pour le club.');
    expect(
      await screen.findByRole('heading', { name: 'Texte révisé' }),
    ).toBeVisible();
    const source = screen.getByRole('textbox').getBoundingClientRect();
    const preview = screen.getByLabelText('Lecture').getBoundingClientRect();
    if (width < 768)
      expect(preview.top).toBeGreaterThanOrEqual(source.bottom - 1);
    else expect(preview.left).toBeGreaterThanOrEqual(source.right - 1);
    expect(preview.right).toBeLessThanOrEqual(width);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    document.documentElement.classList.add('dark');
    await page.screenshot({
      path: `../../../../.vitest-screenshots/markdown-split-dark-${width}.png`,
    });
    await page.getByRole('button', { name: 'Modifier', exact: true }).click();
    expect(screen.queryByRole('heading', { name: 'Texte révisé' })).toBeNull();
    await page.getByRole('button', { name: 'Lecture', exact: true }).click();
    expect(
      await screen.findByRole('heading', { name: 'Texte révisé' }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Enregistrer (Ctrl+S)' }).click();
    await waitFor(() =>
      expect(getDocumentForPath('/cadrage.md')?.dirty).toBe(false),
    );
    expect(io.write).toHaveBeenCalledWith(
      expect.objectContaining({
        body: {
          path: '/cadrage.md',
          content: '# Texte révisé\n\nUne nouvelle proposition pour le club.',
          expectedMtime: 10,
        },
      }),
    );
  },
);

test('edits an authorized retained Markdown projection and saves through its content fingerprint', async () => {
  await page.viewport(1100, 850);
  const path =
    '/synthetic/project/.mergeron-system/livrables/cadrage/Cadrage-BBCC.md';
  io.read.mockResolvedValue({
    data: {
      content: '# Original',
      mtime: 10,
      sha256: 'a'.repeat(64),
      editableDeliverable: true,
    },
  });
  io.write.mockResolvedValue({ data: { mtime: 11, sha256: 'b'.repeat(64) } });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <div style={{ height: 700 }}>
        <FileViewer filePath={path} viewId="retained" />
      </div>
    </QueryClientProvider>,
  );
  await screen.findByRole('heading', { name: 'Original' });
  const edit = await screen.findByRole('button', {
    name: 'Modifier',
  });
  await waitFor(() => expect(edit).toBeEnabled());
  await page.getByRole('button', { name: 'Modifier', exact: true }).click();
  await page
    .getByRole('textbox', { name: 'Markdown source' })
    .fill('# Révision enregistrée');
  await page.getByRole('button', { name: 'Enregistrer (Ctrl+S)' }).click();
  await waitFor(() =>
    expect(io.write).toHaveBeenLastCalledWith(
      expect.objectContaining({
        body: {
          path,
          content: '# Révision enregistrée',
          expectedMtime: 10,
          expectedSha256: 'a'.repeat(64),
        },
      }),
    ),
  );
  expect(getDocumentForPath(path)).toMatchObject({
    dirty: false,
    savedContent: '# Révision enregistrée',
  });
  expect(screen.queryByRole('button', { name: 'Enregistré' })).toBeNull();
  client.clear();
});
