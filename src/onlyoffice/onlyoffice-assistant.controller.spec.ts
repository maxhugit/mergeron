import { expect, it, vi } from 'vitest';
import { IS_PUBLIC_KEY } from '../auth/public.decorator';
import { OnlyOfficeAssistantController } from './onlyoffice-assistant.controller';

it('exposes only plugin assets publicly, never agent or proposal data', () => {
  for (const method of [
    'config',
    'html',
    'bootstrap',
    'js',
    'css',
    'icon',
  ] as const)
    expect(
      Reflect.getMetadata(
        IS_PUBLIC_KEY,
        OnlyOfficeAssistantController.prototype[method],
      ),
    ).toBe(true);
  for (const method of ['context', 'propose', 'read'] as const)
    expect(
      Reflect.getMetadata(
        IS_PUBLIC_KEY,
        OnlyOfficeAssistantController.prototype[method],
      ),
    ).not.toBe(true);
});
it('serves a credential-free manifest and restricts HTML embedding to Mergeron and configured OnlyOffice', async () => {
  const controller = new OnlyOfficeAssistantController(
    {} as never,
    { getStringSetting: () => 'https://office.example.test' } as never,
  );
  const manifest = controller.config();
  expect(manifest.variations[0].EditorsSupport).toEqual(['word', 'slide']);
  expect(manifest.variations[0].url).toBe('index.html');
  expect(JSON.stringify(manifest)).not.toMatch(/sessionId|Authorization/);
  const reply = { type: vi.fn(), header: vi.fn(), send: vi.fn() };
  reply.type.mockReturnValue(reply);
  reply.header.mockReturnValue(reply);
  await controller.html(reply as never);
  expect(reply.header).toHaveBeenCalledWith(
    'Content-Security-Policy',
    expect.stringContaining(
      "frame-ancestors 'self' https://office.example.test",
    ),
  );
  expect(reply.header).toHaveBeenCalledWith(
    'Content-Security-Policy',
    expect.stringContaining("connect-src 'self'"),
  );
  expect(reply.send.mock.calls[0][0]).toContain(
    'https://office.example.test/sdkjs-plugins/v1/plugins.js',
  );
  expect(controller.config().guid).toBe(manifest.guid);
  const html = reply.send.mock.calls[0][0] as string;
  expect(html.indexOf('bootstrap.js')).toBeLessThan(
    html.indexOf('/sdkjs-plugins/'),
  );
});

it('rejects malformed proposal bodies before reading any session grant', () => {
  const controller = new OnlyOfficeAssistantController(
    {} as never,
    {} as never,
  );
  for (const value of [null, undefined, 'invalid', []])
    expect(() => controller.propose(value)).toThrow('Invalid document request');
});
