/** Actual opaque-origin iframe execution in Chromium and WebKit; synthetic content only. */
import { afterEach, beforeEach, expect, test } from 'vitest';
import {
  cleanup,
  render,
  screen,
  waitFor,
  fireEvent,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { page, commands } from 'vitest/browser';
declare module 'vitest/browser' {
  interface BrowserCommands {
    mockupPreview: (action: 'next' | 'confirm' | 'ready') => Promise<string>;
  }
}
import { MockupFrame } from './mockup-frame';
import { MockupPanel } from './mockup-panel';
import i18n, { i18nReady } from '@/i18n';
import '@/index.css';
let queries: QueryClient | undefined;
beforeEach(async () => {
  await i18nReady;
  await i18n.changeLanguage('en');
});
afterEach(() => {
  cleanup();
  queries?.clear();
});
test('allows simulated interactions while refusing parent, storage, network, popup and top navigation access', async () => {
  const results: Record<string, unknown>[] = [];
  const listener = (e: MessageEvent) => {
    if (e.data?.fixture === 'isolation') results.push(e.data);
  };
  window.addEventListener('message', listener);
  const before = location.href;
  document.cookie =
    'mockup_test_parent=synthetic-private; SameSite=Strict; path=/';
  try {
    render(
      <div style={{ height: 500 }}>
        <MockupFrame
          title="Isolation fixture"
          html={`<button id="change">Next</button><p id="state">Initial</p><script>
    const result={fixture:'isolation'};
    addEventListener('securitypolicyviolation',e=>parent.postMessage({fixture:'isolation',directive:e.effectiveDirective},'*'));
    try{result.cookies=document.cookie.includes('mockup_test_parent')}catch{result.cookies=false}
    try{parent.document.body.dataset.mockupEscaped='yes';result.parent=true}catch{result.parent=false}
    try{localStorage.setItem('escape','yes');result.storage=true}catch{result.storage=false}
    try{result.popup=Boolean(window.open('about:blank'))}catch{result.popup=false}
    try{top.location.href='https://example.invalid/escape';result.navigation=true}catch{result.navigation=false}
    fetch('https://example.invalid/blocked').then(()=>{result.network=true;parent.postMessage(result,'*')},()=>{result.network=false;parent.postMessage(result,'*')});
    document.getElementById('change').onclick=()=>{document.getElementById('state').textContent='Changed';parent.postMessage({fixture:'isolation',clicked:true},'*')};
    </script>`}
        />
      </div>,
    );
    await waitFor(() =>
      expect(results.some((r) => r.network === false)).toBe(true),
    );
    expect(results.find((r) => 'network' in r)).toMatchObject({
      parent: false,
      storage: false,
      network: false,
      navigation: false,
      popup: false,
      cookies: false,
    });
    await waitFor(() =>
      expect(results.some((r) => r.directive === 'connect-src')).toBe(true),
    );
    expect(location.href).toBe(before);
    expect(document.body.dataset.mockupEscaped).toBeUndefined();
    expect(await commands.mockupPreview('next')).toContain('Changed');
    await waitFor(() =>
      expect(results.some((r) => r.clicked === true)).toBe(true),
    );
    expect(screen.getByTitle('Isolation fixture').getAttribute('sandbox')).toBe(
      'allow-scripts',
    );
  } finally {
    window.removeEventListener('message', listener);
    document.cookie = 'mockup_test_parent=; Max-Age=0; path=/';
  }
});
test('contains JavaScript exceptions inside the preview and keeps the surrounding controls usable', async () => {
  render(
    <div>
      <button
        onClick={(e) => (e.currentTarget.textContent = 'Conversation usable')}
      >
        Conversation
      </button>
      <div style={{ height: 300 }}>
        <MockupFrame
          title="Broken fixture"
          html="<script>throw Error('fixture')</script>"
        />
      </div>
    </div>,
  );
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'error occurred in the mockup',
  );
  fireEvent.click(screen.getByRole('button', { name: 'Conversation' }));
  expect(
    screen.getByRole('button', { name: 'Conversation usable' }),
  ).toBeVisible();
});
for (const width of [1180, 390])
  test(`renders a responsive simulated mockup and revision controls at ${width}px`, async () => {
    await page.viewport(width, 900);
    const reference = {
      type: 'mergeron.mockup' as const,
      projectId: '22222222-2222-4222-8222-222222222222',
      threadId: 'thread-1',
      id: '11111111-1111-4111-8111-111111111111',
      revision: '33333333-3333-4333-8333-333333333333',
      number: 1,
      title: 'Project dashboard · Simulation',
    };
    queries = new QueryClient();
    queries.setQueryData(
      [
        'mockup',
        reference.projectId,
        reference.threadId,
        reference.id,
        reference.revision,
      ],
      {
        reference,
        html: `<style>body{font:16px system-ui;margin:0;padding:24px;background:#eef2f7;color:#172033}h1{font-size:24px}.cards{display:flex;flex-wrap:wrap;gap:16px}.card{background:white;border-radius:16px;padding:20px;flex:1;min-width:180px}button{background:#1d4ed8;color:white;border:0;border-radius:8px;padding:12px}</style><h1>Project dashboard</h1><p>Simulated data · No real operation</p><div class="cards"><div class="card"><h2>Tasks</h2><p>12 ready</p><button onclick="this.textContent='Simulation confirmed'">Preview action</button></div><div class="card"><h2>Deliverables</h2><p>3 drafts</p></div></div>`,
        currentRevision: reference.revision,
        history: [
          {
            id: reference.revision,
            number: 1,
            title: reference.title,
            authorName: 'Agent',
            createdAt: 1,
          },
        ],
      },
    );
    render(
      <QueryClientProvider client={queries}>
        <div style={{ height: '100dvh' }}>
          <MockupPanel reference={reference} active />
        </div>
      </QueryClientProvider>,
    );
    if (width === 390)
      fireEvent.click(screen.getByRole('button', { name: 'Mobile' }));
    await commands.mockupPreview('ready');
    expect(await commands.mockupPreview('confirm')).toContain(
      'Simulation confirmed',
    );
    await page.screenshot({
      path: `../../../.vitest-screenshots/mockup-${width}.png`,
    });
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
  });
