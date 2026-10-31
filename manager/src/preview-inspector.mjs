/** Scoped diagnostics: never accept an arbitrary Docker id, command, user or path. */
import { randomUUID } from 'node:crypto';

const fail = (code) => {
  throw new Error(code);
};
const application = (component) =>
  /^preview-/.test(component) &&
  !/^preview-(?:relay|egress|volume|sync-|init-)/.test(component);
const dimension = (value) =>
  Number.isInteger(value) && value >= 2 && value <= 500;
export class PreviewInspector {
  constructor(manager) {
    this.manager = manager;
    this.sessions = new Map();
    this.opening = new Set();
    this.samples = new Map();
  }
  async target(input, executing = false) {
    const m = this.manager;
    await m.ready;
    if (executing && m.busy) fail('PREVIEW_BUSY');
    const r = m.records.get(input.runId);
    if (
      !r ||
      (executing
        ? r.state !== 'running'
        : !['running', 'failed'].includes(r.state)) ||
      (executing && r.expiresAt !== null && r.expiresAt <= Date.now())
    )
      fail('PREVIEW_NOT_RUNNING');
    const object = r.objects.find((o) => o.component === input.component);
    if (!object || /^preview-(?:sync-|init-)/.test(object.component))
      fail('PREVIEW_CONTAINER_NOT_FOUND');
    if (executing && !application(object.component))
      fail('PREVIEW_TERMINAL_UNAVAILABLE');
    const c = await m.owned(object.id, r, object.component);
    if (
      executing &&
      (!c.State?.Running || !/^[1-9]\d*:[1-9]\d*$/.test(c.Config?.User ?? ''))
    )
      fail('PREVIEW_TERMINAL_UNAVAILABLE');
    return { r, object, c };
  }
  async containers(input) {
    const m = this.manager;
    await m.ready;
    const r = m.records.get(input.runId);
    if (!r) fail('PREVIEW_NOT_FOUND');
    const containers = await Promise.all(
      r.objects
        .filter((o) => !/^preview-(?:sync-|init-)/.test(o.component))
        .slice(0, 16)
        .map(async (o) => {
          const c = await m.owned(o.id, r, o.component);
          let cpuPercent = null,
            memoryBytes = null;
          if (c.State?.Running) {
            try {
              const s = await m.docker.request(
                `/containers/${encodeURIComponent(o.id)}/stats?stream=false&one-shot=true`,
                { timeout: 1500 },
              );
              const sampleKey = `${r.runId}:${o.id}`;
              const previous = s.precpu_stats?.system_cpu_usage
                ? s.precpu_stats
                : this.samples.get(sampleKey);
              this.samples.set(sampleKey, s.cpu_stats);
              const cpu =
                s.cpu_stats?.cpu_usage?.total_usage -
                previous?.cpu_usage?.total_usage;
              const system =
                s.cpu_stats?.system_cpu_usage - previous?.system_cpu_usage;
              const count =
                s.cpu_stats?.online_cpus ??
                s.cpu_stats?.cpu_usage?.percpu_usage?.length;
              if (cpu >= 0 && system > 0 && count > 0)
                cpuPercent = (cpu / system) * count * 100;
              const used = s.memory_stats?.usage;
              if (Number.isFinite(used))
                memoryBytes = Math.max(
                  0,
                  used - (s.memory_stats?.stats?.inactive_file ?? 0),
                );
            } catch {
              /* Missing metrics are unknown, never zero. */
            }
          }
          return {
            component: o.component,
            name: o.component.replace(/^preview-/, ''),
            image: c.Config?.Image ?? '',
            state:
              c.State?.Status ?? (c.State?.Running ? 'running' : 'stopped'),
            startedAt: c.State?.StartedAt ?? null,
            cpuPercent,
            memoryBytes,
            terminalAvailable:
              c.State?.Running === true &&
              application(o.component) &&
              /^[1-9]\d*:[1-9]\d*$/.test(c.Config?.User ?? ''),
          };
        }),
    );
    return { runId: r.runId, containers };
  }
  async logs(input) {
    const { r, c, object } = await this.target(input);
    let text = (await this.manager.docker.containerLogs(object.id)).slice(
      -32768,
    );
    // Always remove the gateway credential in addition to this container's variables.
    const secrets = [
      r.transportToken,
      ...(c.Config?.Env ?? []).map((s) => s.slice(s.indexOf('=') + 1)),
    ].filter((s) => typeof s === 'string' && s.length >= 4);
    for (const secret of secrets.sort((a, b) => b.length - a.length))
      text = text.split(secret).join('[redacted]');
    return { text, untrustedContent: true };
  }
  close(session) {
    clearTimeout(session.timer);
    this.sessions.delete(session.id);
    session.stream.end('\x03\x04');
    const timer = setTimeout(() => session.stream.destroy(), 1000);
    timer.unref();
  }
  closeRun(runId) {
    for (const key of this.samples.keys())
      if (key.startsWith(runId + ':')) this.samples.delete(key);
    for (const session of this.sessions.values())
      if (session.runId === runId) this.close(session);
  }
  async terminal(input) {
    const { r, c, object } = await this.target(input, true);
    if (
      typeof input.owner !== 'string' ||
      !input.owner ||
      input.owner.length > 200
    )
      fail('PREVIEW_ACCESS_DENIED');
    if (input.action === 'open') {
      const lock = `${r.runId}:${input.owner}:${input.component}`;
      if (this.opening.has(lock) || this.sessions.size + this.opening.size >= 8)
        fail('PREVIEW_TERMINAL_LIMIT');
      for (const session of this.sessions.values())
        if (session.lock === lock) this.close(session);
      this.opening.add(lock);
      try {
        if (!dimension(input.cols) || !dimension(input.rows))
          fail('PREVIEW_INVALID_REQUEST');
        const stream = await this.manager.docker.openTerminal(
          object.id,
          c.Config.User,
          input.cols,
          input.rows,
        );
        if (
          this.manager.busy ||
          r.state !== 'running' ||
          (r.expiresAt !== null && r.expiresAt <= Date.now()) ||
          !r.objects.some((o) => o.id === object.id)
        ) {
          stream.destroy();
          fail('PREVIEW_NOT_RUNNING');
        }
        const session = {
          id: randomUUID(),
          lock,
          owner: input.owner,
          runId: r.runId,
          component: input.component,
          stream,
          text: '',
          base: 0,
          sequence: 0,
          lastInput: '',
          ended: false,
          deadline: Math.min(Date.now() + 20 * 60_000, r.expiresAt ?? Infinity),
        };
        stream.setEncoding('utf8');
        stream.on('data', (chunk) => {
          session.text += chunk;
          if (session.text.length > 262144) {
            const cut = session.text.length - 262144;
            session.text = session.text.slice(cut);
            session.base += cut;
          }
        });
        stream.on('error', () => {
          session.ended = true;
        });
        stream.on('end', () => {
          session.ended = true;
        });
        this.sessions.set(session.id, session);
        this.touch(session);
        return { sessionId: session.id };
      } finally {
        this.opening.delete(lock);
      }
    }
    const s = this.sessions.get(input.sessionId);
    if (
      !s ||
      s.owner !== input.owner ||
      s.runId !== r.runId ||
      s.component !== input.component ||
      Date.now() >= s.deadline
    )
      fail('PREVIEW_TERMINAL_EXPIRED');
    if (input.action === 'close') {
      this.close(s);
      return { closed: true };
    }
    if (
      input.action !== 'exchange' ||
      !Number.isInteger(input.offset) ||
      input.offset < 0 ||
      input.offset > s.base + s.text.length ||
      !Number.isInteger(input.sequence) ||
      input.sequence < 0 ||
      typeof input.data !== 'string' ||
      Buffer.byteLength(input.data) > 8192 ||
      !dimension(input.cols) ||
      !dimension(input.rows)
    )
      fail('PREVIEW_INVALID_REQUEST');
    if (input.sequence === s.sequence + 1) {
      if (s.stream.writableLength > 32768) fail('PREVIEW_TERMINAL_LIMIT');
      s.stream.write(input.data);
      s.sequence = input.sequence;
      s.lastInput = input.data;
    } else if (
      input.sequence !== s.sequence ||
      (input.data && input.data !== s.lastInput)
    )
      fail('PREVIEW_TERMINAL_SEQUENCE');
    await s.stream.resize(input.cols, input.rows);
    this.touch(s);
    const start = Math.max(input.offset, s.base);
    const text = s.text.slice(start - s.base, start - s.base + 16384);
    return {
      text,
      offset: start + text.length,
      truncated: input.offset < s.base,
      ended: s.ended,
      sequence: s.sequence,
    };
  }
  touch(session) {
    clearTimeout(session.timer);
    session.timer = setTimeout(
      () => this.close(session),
      Math.min(60_000, session.deadline - Date.now()),
    );
    session.timer.unref();
  }
}
