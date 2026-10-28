import { CodexRpcError } from '../codex/codex-errors';
import type { CodexService } from '../codex/codex.service';
import { isUnmaterializedThread } from './thread-materialization';

it('requires the exact method, code and Core first-user-message refusal', async () => {
  const message =
    'thread t is not materialized yet; thread/turns/list is unavailable before first user message';
  const request = vi.fn();
  const codex = { request } as unknown as CodexService;
  request.mockRejectedValue(
    new CodexRpcError(
      { code: -32600, message },
      { method: 'thread/turns/list' },
    ),
  );
  await expect(isUnmaterializedThread(codex, 't')).resolves.toBe(true);
  for (const error of [
    new Error(message),
    new CodexRpcError(
      { code: -32601, message },
      { method: 'thread/turns/list' },
    ),
    new CodexRpcError({ code: -32600, message }, { method: 'thread/read' }),
  ]) {
    request.mockRejectedValue(error);
    await expect(isUnmaterializedThread(codex, 't')).rejects.toBe(error);
  }
  request.mockResolvedValue({
    data: [],
    nextCursor: null,
    backwardsCursor: null,
  });
  await expect(isUnmaterializedThread(codex, 't')).resolves.toBe(false);
});
