import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';

const TTL = 15 * 60_000;
const COMMAND_TTL = 60_000;
const ACTIONS = ['observe', 'click', 'fill', 'scroll', 'navigate'] as const;
type Action = (typeof ACTIONS)[number];
type Command = {
  id: string;
  action: Action;
  args: Record<string, unknown>;
  state: 'approval' | 'ready' | 'dispatched' | 'complete' | 'rejected';
  created: number;
  executionId?: string;
  result?: unknown;
  guard: () => void;
  epoch?: string;
  preview?: { url?: string; target?: { tag: string; text: string } };
};
type Session = {
  id: string;
  owner: string;
  threadId: string;
  touched: number;
  created: number;
  state: 'pairing' | 'shared' | 'paused';
  epoch?: string;
  url?: string;
  title?: string;
  commands: Map<string, Command>;
};

/** Only authenticated Mergeron pages relay commands. No extension token or public API bypass. */
@Injectable()
export class LocalBrowserService {
  private readonly sessions = new Map<string, Session>();

  private sweep() {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (now - session.touched > TTL) this.sessions.delete(id);
      else
        for (const command of session.commands.values()) {
          if (
            !['complete', 'rejected'].includes(command.state) &&
            now - command.created > COMMAND_TTL
          ) {
            command.state = 'rejected';
            command.result = { error: 'EXPIRED_OR_UNCERTAIN_DO_NOT_RETRY' };
          }
        }
    }
  }
  private session(owner: string, threadId: string, id: string) {
    this.sweep();
    const session = this.sessions.get(id);
    if (!session || session.owner !== owner || session.threadId !== threadId)
      throw new NotFoundException('Local browser session unavailable');
    return session;
  }
  open(owner: string, threadId: string) {
    this.sweep();
    if (
      this.sessions.size >= 256 ||
      [...this.sessions.values()].filter((s) => s.owner === owner).length >= 10
    )
      throw new ConflictException('Local browser limit reached');
    const session: Session = {
      id: randomUUID(),
      owner,
      threadId,
      touched: Date.now(),
      created: Date.now(),
      state: 'pairing',
      commands: new Map(),
    };
    this.sessions.set(session.id, session);
    return { id: session.id };
  }
  close(owner: string, threadId: string, id: string) {
    this.session(owner, threadId, id);
    this.sessions.delete(id);
    return { ok: true };
  }
  private publicSession(session: Session) {
    return {
      id: session.id,
      state: session.state,
      url: session.url,
      title: session.title,
    };
  }
  status(owner: string, threadId: string) {
    this.sweep();
    return {
      sessions: [...this.sessions.values()]
        .filter((s) => s.owner === owner && s.threadId === threadId)
        .map((s) => this.publicSession(s)),
    };
  }
  request(
    owner: string,
    threadId: string,
    id: string,
    action: unknown,
    args: Record<string, unknown>,
    guard: () => void,
  ) {
    guard();
    const session = this.session(owner, threadId, id);
    if (session.state !== 'shared')
      throw new ConflictException('Share and resume an extension tab first');
    if (!ACTIONS.includes(action as Action))
      throw new BadRequestException('Unsupported local browser action');
    if (JSON.stringify(args).length > 4096)
      throw new BadRequestException('Arguments too large');
    if (
      Object.keys(args).some(
        (key) =>
          !['snapshotId', 'elementId', 'url', 'value', 'x', 'y'].includes(key),
      )
    )
      throw new BadRequestException('Unsupported arguments');
    for (const key of ['snapshotId', 'elementId'])
      if (
        args[key] !== undefined &&
        (typeof args[key] !== 'string' || String(args[key]).length > 100)
      )
        throw new BadRequestException('Invalid page handle');
    if (
      action === 'fill' &&
      (typeof args.value !== 'string' || args.value.length > 2000)
    )
      throw new BadRequestException('Invalid field value');
    for (const key of ['x', 'y'])
      if (
        args[key] !== undefined &&
        (!Number.isSafeInteger(args[key]) || Math.abs(Number(args[key])) > 1000)
      )
        throw new BadRequestException('Invalid scroll distance');
    if (action !== 'observe' && typeof args.snapshotId !== 'string')
      throw new BadRequestException('Observe the current page first');
    if (
      ['click', 'fill'].includes(String(action)) &&
      typeof args.elementId !== 'string'
    )
      throw new BadRequestException('An observed element is required');
    let preview: Command['preview'];
    if (action !== 'observe') {
      const latest = [...session.commands.values()]
        .reverse()
        .find(
          (command) =>
            command.action === 'observe' &&
            command.state === 'complete' &&
            command.epoch === session.epoch,
        );
      const observation = latest?.result as Record<string, unknown> | undefined;
      if (!observation || observation.snapshotId !== args.snapshotId)
        throw new ConflictException(
          'Observe the current page before requesting an action',
        );
      preview = { url: session.url };
      if (action === 'click' || action === 'fill') {
        const target = (
          Array.isArray(observation.elements) ? observation.elements : []
        ).find(
          (element: unknown) =>
            element &&
            typeof element === 'object' &&
            (element as Record<string, unknown>).id === args.elementId,
        ) as Record<string, unknown> | undefined;
        if (
          !target ||
          typeof target.tag !== 'string' ||
          typeof target.text !== 'string'
        )
          throw new BadRequestException('Unknown observed element');
        preview.target = {
          tag: target.tag.slice(0, 30),
          text: target.text.slice(0, 160),
        };
      }
    }
    if (action === 'navigate') {
      if (typeof args.url !== 'string' || args.url.length > 2000)
        throw new BadRequestException('Invalid navigation URL');
      let url: URL;
      try {
        url = new URL(args.url);
      } catch {
        throw new BadRequestException('Invalid navigation URL');
      }
      if (
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        url.origin !== new URL(session.url!).origin
      )
        throw new BadRequestException(
          'Navigation must stay on the shared HTTPS origin',
        );
    }
    if (
      [...session.commands.values()].filter(
        (c) => !['complete', 'rejected'].includes(c.state),
      ).length >= 5 ||
      session.commands.size >= 100
    )
      throw new ConflictException('Too many local browser requests');
    const command: Command = {
      id: randomUUID(),
      action: action as Action,
      args,
      state: action === 'observe' ? 'ready' : 'approval',
      created: Date.now(),
      guard,
      epoch: session.epoch,
      preview,
    };
    session.commands.set(command.id, command);
    return { status: command.state, sessionId: id, commandId: command.id };
  }
  decide(
    owner: string,
    threadId: string,
    id: string,
    commandId: string,
    approve: unknown,
  ) {
    const session = this.session(owner, threadId, id);
    const command = session.commands.get(commandId);
    if (
      !command ||
      command.state !== 'approval' ||
      session.state !== 'shared' ||
      typeof approve !== 'boolean'
    )
      throw new ConflictException('Local browser request expired');
    command.guard();
    command.state = approve ? 'ready' : 'rejected';
    return { ok: true };
  }
  poll(
    owner: string,
    threadId: string,
    id: string,
    input: Record<string, unknown>,
  ) {
    if (!input || typeof input !== 'object' || Array.isArray(input))
      throw new BadRequestException('Invalid extension state');
    const session = this.session(owner, threadId, id);
    session.touched = Date.now();
    const state = input.state;
    if (!['pairing', 'shared', 'paused'].includes(String(state)))
      throw new BadRequestException('Invalid extension state');
    const epoch =
      typeof input.epoch === 'string' && input.epoch.length <= 100
        ? input.epoch
        : undefined;
    if (state === 'shared' && (!epoch || typeof input.url !== 'string'))
      throw new BadRequestException('Invalid shared tab');
    if (input.url !== undefined) {
      if (typeof input.url !== 'string' || input.url.length > 4000)
        throw new BadRequestException('Invalid shared URL');
      let url: URL;
      try {
        url = new URL(input.url);
      } catch {
        throw new BadRequestException('Invalid shared URL');
      }
      if (url.protocol !== 'https:' || url.username || url.password)
        throw new BadRequestException('Invalid shared URL');
      session.url = url.origin + url.pathname;
    }
    if (session.epoch !== epoch || state !== 'shared') {
      for (const command of session.commands.values())
        if (!['complete', 'rejected'].includes(command.state)) {
          command.state = 'rejected';
          command.result = { error: 'SHARING_CHANGED_DO_NOT_RETRY' };
        }
    }
    session.epoch = epoch;
    session.state = state as Session['state'];
    session.title =
      typeof input.title === 'string' ? input.title.slice(0, 200) : undefined;
    const results = Array.isArray(input.results) ? input.results : [];
    if (results.length > 5) throw new BadRequestException('Too many results');
    for (const result of results) {
      if (!result || typeof result !== 'object')
        throw new BadRequestException('Invalid result');
      const entry = result as Record<string, unknown>;
      const command = session.commands.get(String(entry.id));
      if (
        !command ||
        command.state !== 'dispatched' ||
        command.executionId !== entry.executionId
      )
        continue;
      try {
        command.guard();
      } catch {
        command.state = 'rejected';
        continue;
      }
      if (JSON.stringify(entry.result ?? null).length > 48_000)
        throw new BadRequestException('Result too large');
      command.result = entry.result ?? null;
      command.state = 'complete';
    }
    const dispatch: Array<Record<string, unknown>> = [];
    for (const command of session.commands.values()) {
      if (
        [...session.commands.values()].some(
          (pending) => pending.state === 'dispatched',
        )
      )
        break;
      if (command.state !== 'ready' || session.state !== 'shared') continue;
      try {
        command.guard();
      } catch {
        command.state = 'rejected';
        continue;
      }
      command.state = 'dispatched';
      command.executionId = randomUUID();
      dispatch.push({
        id: command.id,
        action: command.action,
        args: command.args,
        executionId: command.executionId,
        expiresAt: command.created + COMMAND_TTL,
      });
      break; // Never overlap actions in one tab, or retry an uncertain write.
    }
    return {
      ...this.publicSession(session),
      dispatch,
      approvals: [...session.commands.values()]
        .filter((c) => c.state === 'approval')
        .map((c) => ({
          id: c.id,
          action: c.action,
          args: c.args,
          preview: c.preview,
        })),
    };
  }
  result(owner: string, threadId: string, id: string, commandId: string) {
    const command = this.session(owner, threadId, id).commands.get(commandId);
    if (!command)
      throw new NotFoundException('Local browser command unavailable');
    command.guard();
    return {
      status: command.state,
      commandId,
      data: command.result,
      untrustedPageContent: true,
    };
  }
}
