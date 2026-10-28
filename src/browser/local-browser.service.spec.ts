import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { LocalBrowserService } from './local-browser.service';

describe('local browser consent broker', () => {
  let service: LocalBrowserService;
  let id: string;
  const guard = vi.fn();
  const shared = {
    state: 'shared',
    epoch: 'document-1',
    url: 'https://example.org/path?private=secret#fragment',
    title: 'Example',
  };
  beforeEach(() => {
    service = new LocalBrowserService();
    guard.mockReset();
    id = service.open('alice', 'agent').id;
  });
  afterEach(() => vi.useRealTimers());
  const share = () => service.poll('alice', 'agent', id, shared);
  const request = (action: string, args: Record<string, unknown> = {}) =>
    service.request('alice', 'agent', id, action, args, guard);
  const observed = {
    snapshotId: 's',
    text: 'untrusted',
    elements: [{ id: 'e', tag: 'button', text: 'Save' }],
  };
  const observe = () => {
    request('observe');
    const command = share().dispatch[0];
    service.poll('alice', 'agent', id, {
      ...shared,
      results: [
        { id: command.id, executionId: command.executionId, result: observed },
      ],
    });
  };
  it('isolates owners/agents and requires a shared tab', () => {
    expect(() => request('observe')).toThrow('Share');
    expect(service.status('bob', 'agent').sessions).toEqual([]);
    expect(service.status('alice', 'other').sessions).toEqual([]);
    expect(() => service.poll('bob', 'agent', id, shared)).toThrow(
      'unavailable',
    );
    expect(() => service.close('alice', 'other', id)).toThrow('unavailable');
    share();
    expect(service.status('alice', 'agent').sessions[0].url).toBe(
      'https://example.org/path',
    );
  });
  it('dispatches reads once, requires approval for every mutation and never overlaps commands', () => {
    share();
    const read = request('observe');
    const first = share().dispatch[0];
    expect(first.id).toBe(read.commandId);
    service.poll('alice', 'agent', id, {
      ...shared,
      results: [
        { id: first.id, executionId: first.executionId, result: observed },
      ],
    });
    const second = request('click', { snapshotId: 's', elementId: 'e' });
    expect(share().approvals[0].preview).toMatchObject({
      target: { tag: 'button', text: 'Save' },
    });
    request('observe');
    const concurrent = share().dispatch[0];
    service.decide('alice', 'agent', id, second.commandId, true);
    expect(share().dispatch).toHaveLength(0);
    const next = service.poll('alice', 'agent', id, {
      ...shared,
      results: [
        {
          id: concurrent.id,
          executionId: concurrent.executionId,
          result: observed,
        },
      ],
    });
    expect(next.dispatch[0].id).toBe(second.commandId);
    expect(share().dispatch).toHaveLength(0);
    expect(service.result('alice', 'agent', id, read.commandId)).toMatchObject({
      status: 'complete',
      untrustedPageContent: true,
    });
  });
  it('rejects stale sharing, revoked turns, mismatched results and expired uncertain actions', () => {
    share();
    observe();
    const command = request('observe');
    const sent = share().dispatch[0];
    service.poll('alice', 'agent', id, {
      ...shared,
      results: [{ id: sent.id, executionId: 'wrong', result: {} }],
    });
    expect(service.result('alice', 'agent', id, command.commandId).status).toBe(
      'dispatched',
    );
    service.poll('alice', 'agent', id, { ...shared, epoch: 'document-2' });
    expect(
      service.result('alice', 'agent', id, command.commandId),
    ).toMatchObject({ status: 'rejected' });
    const another = request('observe');
    guard.mockImplementation(() => {
      throw Error('NO_ACTIVE_TURN');
    });
    expect(share().dispatch).toHaveLength(0);
    expect(() =>
      service.result('alice', 'agent', id, another.commandId),
    ).toThrow('NO_ACTIVE_TURN');
    guard.mockReset();
    share();
    const expired = request('observe');
    share();
    vi.useFakeTimers();
    vi.advanceTimersByTime(61_000);
    expect(
      service.result('alice', 'agent', id, expired.commandId),
    ).toMatchObject({
      status: 'rejected',
      data: { error: 'EXPIRED_OR_UNCERTAIN_DO_NOT_RETRY' },
    });
  });
  it('rejects malformed inputs, cross-origin navigation and uncontrolled scripts', () => {
    expect(() =>
      service.poll('alice', 'agent', id, { ...shared, url: 'bad' }),
    ).toThrow('Invalid shared URL');
    share();
    expect(() => request('click', { snapshotId: 's', elementId: 'e' })).toThrow(
      'Observe',
    );
    observe();
    expect(() =>
      request('click', { snapshotId: 's', elementId: 'unknown' }),
    ).toThrow('Unknown');
    expect(() => request('evaluate', { script: 'alert(1)' })).toThrow(
      'Unsupported',
    );
    expect(() =>
      request('fill', {
        snapshotId: 's',
        elementId: 'e',
        value: 'x'.repeat(2001),
      }),
    ).toThrow('Invalid field');
    expect(() =>
      request('click', { snapshotId: 's', elementId: 'e', selector: 'body' }),
    ).toThrow('Unsupported arguments');
    expect(() => request('scroll', { snapshotId: 's', y: 1001 })).toThrow(
      'Invalid scroll',
    );
    expect(() =>
      request('navigate', { snapshotId: 's', url: 'https://other.org' }),
    ).toThrow('shared HTTPS');
    expect(() =>
      request('navigate', { snapshotId: 's', url: 'javascript:alert(1)' }),
    ).toThrow('shared HTTPS');
  });
  it('revokes all queued work on pause or close', () => {
    share();
    observe();
    const pending = request('click', { snapshotId: 's', elementId: 'e' });
    service.poll('alice', 'agent', id, { state: 'paused' });
    expect(() =>
      service.decide('alice', 'agent', id, pending.commandId, true),
    ).toThrow('expired');
    service.close('alice', 'agent', id);
    expect(() =>
      service.result('alice', 'agent', id, pending.commandId),
    ).toThrow('unavailable');
  });
});
