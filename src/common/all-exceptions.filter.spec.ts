import type { ArgumentsHost } from '@nestjs/common';
import { AllExceptionsFilter } from './all-exceptions.filter';
import { CodexRpcError, CodexRequestTimeoutError } from '../codex/codex-errors';

it('retains RPC context but omits an upstream Cloudflare HTML document and challenge tokens', () => {
  const send = vi.fn();
  const status = vi.fn().mockReturnValue({ send });
  const host = {
    getType: () => 'http',
    switchToHttp: () => ({ getResponse: () => ({ status }) }),
  } as unknown as ArgumentsHost;
  new AllExceptionsFilter().catch(
    new CodexRpcError(
      {
        code: -32603,
        message:
          '403 Forbidden: <html>__cf_chl=PRIVATE<script>challenge-platform</script></html>',
      },
      { method: 'app/list' },
    ),
    host,
  );
  expect(status).toHaveBeenCalledWith(502);
  expect(send).toHaveBeenCalledWith(
    expect.objectContaining({
      errorCode: 'codex.rpc_error',
      params: { rpcCode: -32603, method: 'app/list' },
    }),
  );
  const body = JSON.stringify(send.mock.calls[0][0]);
  expect(body).not.toContain('<html>');
  expect(body).not.toContain('PRIVATE');
  expect(body.length).toBeLessThan(400);
});

it('reports a native app/list timeout as 504 with safe method context instead of internal error', () => {
  const send = vi.fn();
  const status = vi.fn().mockReturnValue({ send });
  const host = {
    getType: () => 'http',
    switchToHttp: () => ({ getResponse: () => ({ status }) }),
  } as unknown as ArgumentsHost;
  new AllExceptionsFilter().catch(
    new CodexRequestTimeoutError('app/list', 41),
    host,
  );
  expect(status).toHaveBeenCalledWith(504);
  expect(send).toHaveBeenCalledWith(
    expect.objectContaining({
      errorCode: 'codex.request_timeout',
      params: { method: 'app/list' },
    }),
  );
});
