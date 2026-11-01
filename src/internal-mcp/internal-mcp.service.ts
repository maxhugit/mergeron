import {
  Injectable,
  OnModuleDestroy,
  ServiceUnavailableException,
  Optional,
} from '@nestjs/common';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
  type Server,
} from 'node:http';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { CodexProcessManager } from '../codex/codex-process-manager.service';
import type { ServerNotification } from '../codex/codex-schema';
import { accessContext, currentAccess } from '../auth/access-context';
import { ProjectAgentToolsService } from '../project-knowledge/project-agent-tools.service';
import { CatalogAdmissionService } from '../codex/catalog/catalog-admission.service';
import { LocalBrowserService } from '../browser/local-browser.service';
import {
  INTERNAL_MCP_INSTRUCTIONS,
  INTERNAL_MCP_NAME,
  INTERNAL_MCP_TOOLS,
  INTERNAL_MCP_VERSION,
  internalMcpCatalog,
} from './internal-mcp-catalog';
import {
  internalMcpAnnotations,
  internalMcpTransportApprovals,
  normalizeInternalMcpRequest,
  resolveInternalMcpTool,
} from './internal-mcp-tools';

interface Capability {
  id: string;
  projectId: string;
  threadId?: string;
  token: string;
  lease?: Lease;
}
interface Lease {
  access: NonNullable<ReturnType<typeof currentAccess>>;
  writes: boolean;
  expiresAt: number;
  calls: number;
  revoked: boolean;
  turnId?: string;
  completed?: boolean;
  processing: Promise<unknown>;
}

/** Native MCP endpoint: independent loopback listener, no browser/API-key bypass. */
@Injectable()
export class InternalMcpService implements OnModuleDestroy {
  private server?: Server;
  private starting?: Promise<string>;
  private origin?: string;
  private readonly capabilities = new Map<string, Capability>();
  private readonly threads = new Map<string, Capability>();
  private readonly transports = new Set<McpServer>();

  constructor(
    private readonly tools: ProjectAgentToolsService,
    manager: CodexProcessManager,
    private readonly admission: CatalogAdmissionService,
    @Optional() private readonly localBrowser?: LocalBrowserService,
  ) {
    manager.addLifecycleListener(() => {
      for (const cap of this.capabilities.values()) this.revoke(cap.threadId);
    });
    manager.addListener('notification', (note: ServerNotification) => {
      if (note.method === 'turn/started') {
        const lease = this.threads.get(note.params.threadId)?.lease;
        if (lease) {
          lease.turnId = note.params.turn.id;
          lease.completed = false;
        }
      }
      if (note.method === 'turn/completed') {
        const lease = this.threads.get(note.params.threadId)?.lease;
        if (lease?.turnId === note.params.turn.id) {
          lease.completed = true;
          if (note.params.turn.status !== 'completed')
            this.revoke(note.params.threadId);
        }
      }
      if (
        note.method === 'thread/closed' ||
        note.method === 'thread/archived' ||
        note.method === 'thread/deleted'
      ) {
        this.revoke(note.params.threadId);
        if (note.method === 'thread/deleted') {
          const cap = this.threads.get(note.params.threadId);
          if (cap) this.capabilities.delete(this.digest(cap.token));
          this.threads.delete(note.params.threadId);
        }
      }
    });
  }

  catalog() {
    return internalMcpCatalog();
  }
  private digest(token: string) {
    return createHash('sha256').update(token).digest('hex');
  }

  async connection(projectId: string, threadId?: string) {
    const origin = await this.listen();
    let cap = threadId ? this.threads.get(threadId) : undefined;
    if (cap && cap.projectId !== projectId) {
      this.revoke(threadId);
      this.capabilities.delete(this.digest(cap.token));
      this.threads.delete(threadId!);
      cap = undefined;
    }
    if (!cap) {
      if (this.capabilities.size >= 2048)
        throw new ServiceUnavailableException(
          'Internal MCP connection capacity reached',
        );
      cap = {
        id: randomUUID(),
        token: randomBytes(32).toString('base64url'),
        projectId,
        threadId,
      };
      this.capabilities.set(this.digest(cap.token), cap);
      if (threadId) this.threads.set(threadId, cap);
    }
    return {
      id: cap.id,
      config: {
        url: `${origin}/mcp`,
        http_headers: { Authorization: `Bearer ${cap.token}` },
        enabled: true,
        startup_timeout_sec: 10,
        tool_timeout_sec: 180,
        // Preserve only the registry's existing publication/monitor exceptions,
        // for canonical names and cached aliases. Domain authorization and MCP
        // write/open-world annotations remain independent of transport approval.
        tools: internalMcpTransportApprovals(),
      },
    };
  }

  bind(connectionId: string, threadId: string, projectId: string) {
    const cap = [...this.capabilities.values()].find(
      (value) => value.id === connectionId,
    );
    if (
      !cap ||
      cap.projectId !== projectId ||
      (cap.threadId && cap.threadId !== threadId)
    )
      throw new Error('Invalid internal MCP binding');
    cap.threadId = threadId;
    const previous = this.threads.get(threadId);
    if (previous && previous !== cap) {
      if (previous.lease) previous.lease.revoked = true;
      this.capabilities.delete(this.digest(previous.token));
    }
    this.threads.set(threadId, cap);
  }

  prepare(threadId: string, projectId: string, writes: boolean) {
    const cap = this.threads.get(threadId);
    const access = currentAccess();
    if (!cap || cap.projectId !== projectId || !access) return null;
    try {
      this.tools.assertProject(threadId, projectId);
    } catch {
      return null;
    }
    access.identities.requireActive(access.identity);
    access.identities.requireThread(access.identity, threadId);
    access.identities.requireProject(access.identity, projectId);
    this.revoke(threadId);
    const lease: Lease = {
      access,
      writes,
      expiresAt: Date.now() + 3600000,
      calls: 0,
      revoked: false,
      processing: Promise.resolve(),
    };
    cap.lease = lease;
    return {
      bind: (turnId: string) => {
        lease.turnId = turnId;
      },
      abort: () => {
        lease.revoked = true;
      },
    };
  }

  revoke(threadId?: string) {
    const lease = threadId ? this.threads.get(threadId)?.lease : undefined;
    if (lease) lease.revoked = true;
  }

  private async execute(
    cap: Capability,
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ) {
    const lease = cap.lease;
    const tool = resolveInternalMcpTool(name);
    if (!tool) throw new Error('UNKNOWN_TOOL');
    const check = () => {
      if (
        !cap.threadId ||
        !lease ||
        !lease.turnId ||
        lease.completed ||
        lease.revoked ||
        cap.lease !== lease ||
        Date.now() > lease.expiresAt ||
        signal.aborted
      )
        throw new Error('NO_ACTIVE_TURN');
      const identity = lease.access.identities.current(lease.access.identity);
      lease.access.identities.requireActive(identity);
      lease.access.identities.requireThread(identity, cap.threadId);
      lease.access.identities.requireProject(identity, cap.projectId);
      if (tool.policy.forbidImpersonation && identity.impersonation)
        throw new Error('ACCESS_DENIED');
      if (tool.policy.administratorOnly) {
        lease.access.identities.requireAdministrator(identity);
      }
      this.tools.assertProject(cap.threadId, cap.projectId);
      // Scoped conversation metadata is independent of filesystem access.
      // Monitor creation cannot exceed the active turn's observed rights;
      // unattended checks can report/continue but never clone their schedule.
      if (tool.policy.requiresWorkspaceWrite && !lease.writes)
        throw new Error('READ_ONLY');
    };
    check();
    if (++lease!.calls > 100) throw new Error('RATE_LIMIT');
    const operation = lease!.processing
      .catch(() => {})
      .then(async () => {
        check();
        const identity = lease!.access.identities.current(
          lease!.access.identity,
        );
        const release = this.admission.enter('Internal MCP tool');
        try {
          return await accessContext.run({ ...lease!.access, identity }, () => {
            if (tool.handler !== 'project') {
              if (!this.localBrowser || identity.impersonation)
                throw new Error('ACCESS_DENIED');
              lease!.access.identities.requireAdministrator(identity);
              const owner =
                identity.personId ?? identity.subject ?? identity.kind;
              if (tool.handler === 'localBrowserRead') {
                if (args.operation === 'status')
                  return this.localBrowser.status(owner, cap.threadId!);
                if (args.operation === 'result')
                  return this.localBrowser.result(
                    owner,
                    cap.threadId!,
                    String(args.sessionId),
                    String(args.commandId),
                  );
                return this.localBrowser.request(
                  owner,
                  cap.threadId!,
                  String(args.sessionId),
                  'observe',
                  {},
                  check,
                );
              }
              const { sessionId, action, ...parameters } = args;
              return this.localBrowser.request(
                owner,
                cap.threadId!,
                String(sessionId),
                action,
                parameters,
                check,
              );
            }
            return this.tools.execute(
              cap.threadId!,
              // Stable execution key preserves existing requestId fingerprints.
              { ...args, tool: tool.operation },
              check,
              lease!.turnId,
              lease!.writes,
            );
          });
        } finally {
          release();
        }
      });
    lease!.processing = operation;
    return operation;
  }

  private nativeServer(cap: Capability) {
    const server = new McpServer(
      { name: INTERNAL_MCP_NAME, version: INTERNAL_MCP_VERSION },
      { instructions: INTERNAL_MCP_INSTRUCTIONS },
    );
    for (const tool of INTERNAL_MCP_TOOLS) {
      server.registerTool(
        tool.name,
        {
          title: tool.title,
          description: tool.description,
          inputSchema: tool.input,
          outputSchema: tool.output,
          annotations: internalMcpAnnotations(tool),
        },
        async (
          args: Record<string, unknown>,
          extra: { signal: AbortSignal },
        ): Promise<CallToolResult> => {
          try {
            const result = await this.execute(
              cap,
              tool.name,
              args,
              extra.signal,
            );
            return {
              content: [{ type: 'text', text: JSON.stringify(result) }],
              structuredContent: result,
            };
          } catch (error) {
            const code =
              error instanceof Error &&
              [
                'NO_ACTIVE_TURN',
                'READ_ONLY',
                'RATE_LIMIT',
                'PROJECT_CONNECTION_UNAVAILABLE',
                'PROJECT_CONNECTION_UNSUPPORTED',
                'PROJECT_CONNECTION_REQUEST_CONFLICT',
                'GIT_OUTPUT_LIMIT_EXCEEDED',
                'GIT_COMMAND_TIMEOUT',
                'GIT_STALE',
                'GIT_WORKTREE_DIRTY',
                'GIT_BRANCH_EXISTS',
                'GIT_BRANCH_NAME_INVALID',
                'GIT_IDENTITY_REQUIRED',
                'GIT_NOTHING_STAGED',
                'GIT_IN_PROGRESS',
                'GIT_FILE_UNSAFE',
                'GIT_BUSY',
                'GIT_AGENT_STATE_UNKNOWN',
                'GIT_READ_ONLY',
                'GIT_COPY_OWNED',
                'GIT_AGENT_COPY_EXISTS',
                'WORKSPACE_GIT_CLONE_FAILED',
                'GIT_AUTH_REQUIRED',
                'GIT_HTTPS_REQUIRED',
                'GIT_GITHUB_TOKEN_REQUIRED',
                'GIT_PR_PUSH_REQUIRED',
                'GIT_PR_SAME_BRANCH',
                'GIT_PR_CREATE_FAILED',
                'GIT_OUTCOME_UNKNOWN',
                'GIT_WRITE_ACCESS_DENIED',
                'GIT_REMOTE_REJECTED',
                'GIT_NETWORK_UNAVAILABLE',
                'GIT_TLS_ERROR',
              ].includes(error.message)
                ? error.message
                : 'ACCESS_DENIED_OR_CREATION_UNCONFIRMED';
            return {
              isError: true,
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    code,
                    message:
                      'Check project access, configured connection, manager, arguments and observed state. For any mutation retry keep the SAME requestId and payload. An unknown outcome may already have succeeded: inspect local and remote state and never automatically retry with a new ID. Never claim unconfirmed success.',
                  }),
                },
              ],
            };
          }
        },
      );
    }
    return server;
  }

  private listen(): Promise<string> {
    if (this.origin) return Promise.resolve(this.origin);
    if (this.starting) return this.starting;
    this.starting = new Promise<string>((resolve, reject) => {
      const server = createServer((req, res) => {
        void this.handle(req, res).catch(() => {
          if (!res.headersSent) res.writeHead(500);
          res.end();
        });
      });
      this.server = server;
      server.requestTimeout = 10000;
      server.headersTimeout = 5000;
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (!address || typeof address === 'string') {
          reject(new Error('Internal MCP bind failed'));
          return;
        }
        this.origin = `http://127.0.0.1:${address.port}`;
        resolve(this.origin);
      });
    });
    return this.starting;
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    // Native clients have no Origin. Reject every browser origin and forwarded
    // host; never expose this capability endpoint through the public API.
    if (
      req.headers.origin !== undefined ||
      req.headers.host !== new URL(this.origin!).host ||
      req.socket.remoteAddress !== '127.0.0.1'
    ) {
      res.writeHead(403).end();
      return;
    }
    if (req.url !== '/mcp') {
      res.writeHead(404).end();
      return;
    }
    const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(
      req.headers.authorization ?? '',
    )?.[1];
    const cap = token ? this.capabilities.get(this.digest(token)) : undefined;
    if (!cap) {
      res.writeHead(401).end();
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { Allow: 'POST' }).end();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const part of req) {
      const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part as string);
      size += chunk.length;
      if (size > 32768) {
        res.writeHead(413).end();
        return;
      }
      chunks.push(chunk);
    }
    let body: unknown;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      res.writeHead(400).end();
      return;
    }
    const server = this.nativeServer(cap);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    this.transports.add(server);
    res.once('close', () => {
      this.transports.delete(server);
      void server.close();
    });
    await server.connect(transport);
    // Old calls remain accepted, but tools/list exposes only canonical names.
    await transport.handleRequest(req, res, normalizeInternalMcpRequest(body));
  }

  async onModuleDestroy() {
    for (const cap of this.capabilities.values())
      if (cap.lease) cap.lease.revoked = true;
    await Promise.all([...this.transports].map((server) => server.close()));
    this.server?.closeAllConnections();
    if (this.server?.listening)
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.capabilities.clear();
    this.threads.clear();
  }
}
