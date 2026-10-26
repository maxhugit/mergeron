import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Optional,
} from '@nestjs/common';
import { eq, and, isNull, lte, desc } from 'drizzle-orm';
import { realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { LocalAuthService } from './local-auth.service';
import { identityEvents } from './identity-events';
import { currentAccess } from './access-context';
import { DRIZZLE_DB, type AppDatabase } from '../database/database.constants';
import {
  people,
  projects,
  projectWorkspaces,
  projectResources,
  settings,
  projectParticipants,
  projectAgentThreads,
  simpleChatThreads,
  conversationOwners,
  conversationBranchEdges,
  documentAccessSessions,
  impersonationAudit,
} from '../database/schema';

export interface PlatformIdentity {
  kind: 'person' | 'service' | 'unlinked';
  personId: string | null;
  name: string | null;
  role: 'standard' | 'administrator' | null;
  active: boolean;
  subject?: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  theme?: string;
  language?: string;
  impersonation?: {
    sessionId: string;
    administratorId: string;
    administratorName: string;
    personId: string;
    personName: string;
    expiresAt: number;
    expired?: boolean;
  };
}
export type IdentityHeaders = Record<string, string | string[] | undefined>;

@Injectable()
export class IdentityService {
  private readonly impersonations = new Map<
    string,
    NonNullable<PlatformIdentity['impersonation']>
  >();
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: AppDatabase,
    @Optional() private readonly localAuth?: LocalAuthService,
  ) {}

  resolveOriginal(
    headers: IdentityHeaders,
    personId?: string,
  ): PlatformIdentity {
    const local =
      personId ?? this.localAuth?.authenticateCookie(headers.cookie);
    return local
      ? this.resolvePerson(local)
      : this.resolveTrustedHeaders(headers);
  }

  resolve(headers: IdentityHeaders, personId?: string): PlatformIdentity {
    const real = this.resolveOriginal(headers, personId);
    const token = this.impersonationToken(headers);
    if (!token) return real;
    const session = this.impersonations.get(this.digestImpersonation(token));
    const allowed =
      session &&
      real.kind === 'person' &&
      real.active &&
      real.role === 'administrator' &&
      real.personId === session.administratorId;
    if (!allowed)
      return {
        kind: 'unlinked',
        personId: null,
        name: null,
        role: null,
        active: false,
        impersonation: {
          sessionId: '',
          administratorId: real.personId ?? '',
          administratorName: real.name ?? '',
          personId: '',
          personName: '',
          expiresAt: 0,
          expired: true,
        },
      };
    const target = this.resolvePerson(session.personId);
    if (session.expiresAt <= Date.now() || !target.active)
      return {
        ...target,
        active: false,
        role: null,
        impersonation: { ...session, expired: true },
      };
    return { ...target, impersonation: session };
  }

  private impersonationToken(headers: IdentityHeaders): string | null {
    const cookie = headers.cookie;
    if (typeof cookie !== 'string') return null;
    const value = cookie
      .split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith('mergeron_impersonation='));
    return value
      ? value.slice('mergeron_impersonation='.length) || 'invalid'
      : null;
  }

  private digestImpersonation(token: string) {
    return createHash('sha256').update(token).digest('hex');
  }

  startImpersonation(
    real: PlatformIdentity,
    headers: IdentityHeaders,
    personId: unknown,
  ) {
    this.requireAdministrator(real);
    if (
      real.kind !== 'person' ||
      !real.personId ||
      this.impersonationToken(headers)
    )
      throw new ForbiddenException(
        'Revenez à votre compte avant de lancer un nouveau test. Un compte administrateur personnel est requis.',
      );
    if (typeof personId !== 'string' || personId === real.personId)
      throw new BadRequestException('Choisissez une autre personne active.');
    const target = this.resolvePerson(personId);
    this.requireActive(target);
    for (const [key, entry] of this.impersonations)
      if (entry.expiresAt <= Date.now()) this.impersonations.delete(key);
    if (this.impersonations.size >= 500)
      throw new ForbiddenException(
        'Trop de sessions de test. Réessayez plus tard.',
      );
    const session = {
      sessionId: randomUUID(),
      administratorId: real.personId,
      administratorName: real.name ?? '',
      personId,
      personName: target.name ?? '',
      expiresAt: Date.now() + 15 * 60_000,
    };
    this.auditImpersonation(session, 'started');
    // Capabilities minted in the administrator view must not survive the switch.
    this.db
      .delete(documentAccessSessions)
      .where(eq(documentAccessSessions.personId, real.personId))
      .run();
    const token = randomBytes(32).toString('base64url');
    this.impersonations.set(this.digestImpersonation(token), session);
    const timer = setTimeout(
      () => identityEvents.emit('changed', real.personId),
      15 * 60_000,
    );
    timer.unref();
    identityEvents.emit('changed', real.personId);
    return token;
  }

  stopImpersonation(real: PlatformIdentity, headers: IdentityHeaders) {
    const token = this.impersonationToken(headers);
    if (token) {
      const digest = this.digestImpersonation(token);
      const session = this.impersonations.get(digest);
      if (session && session.administratorId === real.personId) {
        this.auditImpersonation(session, 'stopped');
        this.impersonations.delete(digest);
      }
    }
    if (real.personId) identityEvents.emit('changed', real.personId);
  }

  impersonationCookie(token: string, secure: boolean) {
    return `mergeron_impersonation=${token}; Path=/; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}${token ? '' : '; Max-Age=0'}`;
  }

  listImpersonationAudit(identity: PlatformIdentity) {
    this.requireAdministrator(identity);
    return this.db
      .select()
      .from(impersonationAudit)
      .orderBy(desc(impersonationAudit.createdAt))
      .limit(200)
      .all();
  }

  auditImpersonation(
    session: NonNullable<PlatformIdentity['impersonation']>,
    action: string,
    method?: string,
    route?: string,
  ) {
    this.db
      .insert(impersonationAudit)
      .values({
        id: randomUUID(),
        sessionId: session.sessionId,
        administratorId: session.administratorId,
        administratorName: session.administratorName,
        personId: session.personId,
        personName: session.personName,
        action,
        method,
        route: route?.split('?')[0].slice(0, 500),
        createdAt: Date.now(),
      })
      .run();
  }

  /** Call only after bearer authentication. The ingress overwrites every identity header. */
  private resolveTrustedHeaders(headers: IdentityHeaders): PlatformIdentity {
    if (headers['x-webui-auth-source'] !== 'authentik') {
      if (
        (headers['x-webui-auth-source'] !== undefined &&
          headers['x-webui-auth-source'] !== 'service') ||
        (process.env.WEBUI_REQUIRE_IDENTITY === 'true' &&
          headers['x-webui-auth-source'] !== 'service')
      )
        return {
          kind: 'unlinked',
          personId: null,
          name: null,
          role: null,
          active: false,
        };
      return {
        kind: 'service',
        personId: null,
        name: 'Deployment service',
        role: 'administrator',
        active: true,
      };
    }
    const subject = headers['x-webui-auth-subject'];
    const rawEmail = headers['x-webui-auth-email'];
    const email =
      typeof rawEmail === 'string' ? rawEmail.trim().toLowerCase() : '';
    if (typeof subject !== 'string' || !subject.trim() || subject.length > 512)
      return {
        kind: 'unlinked',
        personId: null,
        name: null,
        role: null,
        active: false,
      };
    return this.resolveTrustedSubject(subject, email, true);
  }

  /** Resolve verified OIDC claims without trusting browser-provided headers. */
  resolveOidc(
    subject: string,
    email: string,
    emailVerified: boolean,
  ): PlatformIdentity {
    return this.resolveTrustedSubject(
      subject,
      email.trim().toLowerCase(),
      emailVerified,
    );
  }

  private resolveTrustedSubject(
    subject: string,
    email: string,
    emailVerified: boolean,
  ): PlatformIdentity {
    return this.db.transaction(() => {
      let person = this.db
        .select()
        .from(people)
        .where(eq(people.identitySubject, subject))
        .get();
      if (!person && email && emailVerified) {
        // No account creation or administrator promotion on first login. Only a
        // pre-provisioned active record can bind, once, by the verified email.
        const candidate = this.db
          .select()
          .from(people)
          .where(and(eq(people.email, email), isNull(people.identitySubject)))
          .get();
        // An administrator must be explicitly bound by a deployment operator:
        // an email assertion alone must never be enough to claim admin access.
        if (candidate?.active && candidate.role === 'standard') {
          this.db
            .update(people)
            .set({ identitySubject: subject, updatedAt: Date.now() })
            .where(eq(people.id, candidate.id))
            .run();
          person = { ...candidate, identitySubject: subject };
        }
      }
      if (!person)
        return {
          kind: 'unlinked' as const,
          personId: null,
          name: null,
          role: null,
          active: false,
          subject,
          email,
        };
      return {
        kind: 'person' as const,
        personId: person.id,
        name: person.name,
        role: person.role,
        active: person.active,
        subject,
        email,
        firstName: person.firstName,
        lastName: person.lastName,
        theme: person.theme,
        language: person.language,
      };
    });
  }

  /** Resolves a server-authenticated local session to its person profile. */
  resolvePerson(personId: string): PlatformIdentity {
    const person = this.db
      .select()
      .from(people)
      .where(eq(people.id, personId))
      .get();
    if (!person)
      return {
        kind: 'unlinked',
        personId: null,
        name: null,
        role: null,
        active: false,
      };
    return {
      kind: 'person',
      personId: person.id,
      name: person.name,
      role: person.role,
      active: person.active,
      email: person.email ?? undefined,
      firstName: person.firstName,
      lastName: person.lastName,
      theme: person.theme,
      language: person.language,
    };
  }

  updatePreferences(
    identity: PlatformIdentity,
    input: { theme?: unknown; language?: unknown },
  ) {
    this.requireActive(identity);
    if (!identity.personId)
      throw new ForbiddenException('A person profile is required');
    const themes = new Set([
      'light',
      'dark',
      'sepia',
      'nord',
      'solarized',
      'dracula',
      'high-contrast',
    ]);
    if (
      input.theme !== undefined &&
      (typeof input.theme !== 'string' || !themes.has(input.theme))
    )
      throw new BadRequestException('Unsupported theme');
    if (
      input.language !== undefined &&
      (typeof input.language !== 'string' ||
        !/^[a-z]{2,3}$/.test(input.language))
    )
      throw new BadRequestException('Unsupported language');
    const updates = {
      ...(typeof input.theme === 'string' ? { theme: input.theme } : {}),
      ...(typeof input.language === 'string'
        ? { language: input.language }
        : {}),
      updatedAt: Date.now(),
    };
    this.db
      .update(people)
      .set(updates)
      .where(eq(people.id, identity.personId))
      .run();
    const person = this.db
      .select()
      .from(people)
      .where(eq(people.id, identity.personId))
      .get();
    return { theme: person!.theme, language: person!.language };
  }

  requireActive(identity: PlatformIdentity) {
    identity = this.current(identity);
    if (!identity.active || !identity.role)
      throw new ForbiddenException(
        'Your login is not linked to an active person. Contact an administrator.',
      );
  }
  requireAdministrator(identity: PlatformIdentity) {
    identity = this.current(identity);
    this.requireActive(identity);
    if (identity.role !== 'administrator')
      throw new ForbiddenException('Administrator access required');
  }

  /** Shared policy used by REST, sockets, file capabilities and domain services. */
  current(identity: PlatformIdentity): PlatformIdentity {
    if (identity.impersonation) {
      const session = identity.impersonation;
      const real = this.resolvePerson(session.administratorId);
      if (
        session.expired ||
        ![...this.impersonations.values()].some(
          (item) => item.sessionId === session.sessionId,
        ) ||
        session.expiresAt <= Date.now() ||
        !real.active ||
        real.role !== 'administrator'
      )
        return { ...identity, active: false, role: null };
    }
    if (identity.kind === 'service') return identity;
    const person = identity.personId
      ? this.db
          .select()
          .from(people)
          .where(eq(people.id, identity.personId))
          .get()
      : undefined;
    return person
      ? { ...identity, active: person.active, role: person.role }
      : { ...identity, active: false, role: null };
  }

  canReadProject(identity: PlatformIdentity, projectId: string): boolean {
    identity = this.current(identity);
    if (!identity.active || !identity.role) return false;
    if (identity.role === 'administrator') return true;
    return (
      !!identity.personId &&
      !!this.db
        .select()
        .from(projectParticipants)
        .where(
          and(
            eq(projectParticipants.projectId, projectId),
            eq(projectParticipants.personId, identity.personId),
          ),
        )
        .get()
    );
  }

  requireProject(identity: PlatformIdentity, projectId: string) {
    if (!this.canReadProject(identity, projectId))
      throw new ForbiddenException('Project participant access required');
  }

  threadProject(id: string, kind: 'agent' | 'simple' = 'agent'): string | null {
    return kind === 'simple'
      ? (this.db
          .select()
          .from(simpleChatThreads)
          .where(eq(simpleChatThreads.id, id))
          .get()?.projectId ?? null)
      : (this.db
          .select()
          .from(projectAgentThreads)
          .where(eq(projectAgentThreads.threadId, id))
          .get()?.projectId ?? null);
  }

  canReadThread(
    identity: PlatformIdentity,
    id: string,
    kind: 'agent' | 'simple' = 'agent',
  ): boolean {
    identity = this.current(identity);
    if (!identity.active || !identity.role) return false;
    if (identity.role === 'administrator') return true;
    const seen = new Set<string>();
    let current: string | undefined = id;
    while (current) {
      if (seen.has(current)) return false;
      seen.add(current);
      const projectId = this.threadProject(current, kind);
      const edge: typeof conversationBranchEdges.$inferSelect | undefined =
        kind === 'agent'
          ? this.db
              .select()
              .from(conversationBranchEdges)
              .where(eq(conversationBranchEdges.childThreadId, current))
              .get()
          : undefined;
      const owner = this.db
        .select()
        .from(conversationOwners)
        .where(
          and(
            eq(conversationOwners.kind, kind),
            eq(conversationOwners.conversationId, current),
          ),
        )
        .get();
      if (
        projectId
          ? !this.canReadProject(identity, projectId)
          : owner
            ? owner.personId !== identity.personId
            : !edge
      )
        return false;
      // A fork can contain inherited messages: access to its parent is required too.
      current = edge?.parentThreadId;
    }
    return true;
  }

  requireThread(
    identity: PlatformIdentity,
    id: string,
    kind: 'agent' | 'simple' = 'agent',
  ) {
    if (!this.canReadThread(identity, id, kind))
      throw new ForbiddenException('Conversation access denied');
  }

  readableAgentIds(identity: PlatformIdentity): string[] {
    return [
      ...new Set([
        ...this.db
          .select()
          .from(projectAgentThreads)
          .all()
          .map((t) => t.threadId),
        ...this.db
          .select()
          .from(conversationOwners)
          .all()
          .filter((o) => o.kind === 'agent')
          .map((o) => o.conversationId),
        ...this.db
          .select()
          .from(conversationBranchEdges)
          .all()
          .map((e) => e.childThreadId),
      ]),
    ].filter((id) => this.canReadThread(identity, id));
  }

  recordConversationOwner(
    identity: PlatformIdentity,
    id: string,
    kind: 'agent' | 'simple',
  ) {
    if (identity.personId)
      this.db
        .insert(conversationOwners)
        .values({ kind, conversationId: id, personId: identity.personId })
        .onConflictDoNothing()
        .run();
  }

  workspaceRoots(identity?: PlatformIdentity) {
    return [
      ...new Set([
        ...this.db
          .select()
          .from(projects)
          .all()
          .filter((p) => !identity || this.canReadProject(identity, p.id))
          .map((p) => p.workspacePath),
        ...this.db
          .select()
          .from(projectWorkspaces)
          .all()
          .filter(
            (p) => !identity || this.canReadProject(identity, p.projectId),
          )
          .map((p) => p.path),
      ]),
    ];
  }

  /** Resolve symlinks and the nearest existing parent, including creation paths. */
  requireWorkspacePath(
    value: unknown,
    allowProjectCreation = false,
    identity: PlatformIdentity | undefined = currentAccess()?.identity,
  ) {
    if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0'))
      throw new ForbiddenException('Access is limited to project workspaces');
    const canonical = (path: string): string => {
      let current = resolve(path);
      const tail: string[] = [];
      for (;;) {
        try {
          return resolve(realpathSync(current), ...tail.reverse());
        } catch (error) {
          if (
            !['ENOENT', 'ENOTDIR'].includes(
              (error as NodeJS.ErrnoException).code ?? '',
            )
          )
            throw new ForbiddenException('Workspace path cannot be verified');
          const parent = dirname(current);
          if (parent === current)
            throw new ForbiddenException('Workspace path cannot be verified');
          tail.push(current.slice(parent.length).replace(/^\//, ''));
          current = parent;
        }
      }
    };
    const target = canonical(value);
    const contains = (root: string, candidate: string) => {
      const rel = relative(root, candidate);
      return (
        rel === '' ||
        (rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel))
      );
    };
    // Even a broadly linked project must not expose the deployment credentials
    // or its database through the appdata bind-mount alias.
    const protectedPaths = (
      process.env.WEBUI_PROTECTED_PATHS ??
      '/home/codex,/run/secrets,/app,/proc,/sys,/dev,/etc,/root,/appdata/mergeron'
    )
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);
    if (
      protectedPaths.some(
        (root) =>
          contains(canonical(root), target) ||
          contains(target, canonical(root)),
      )
    )
      throw new ForbiddenException(
        'Server private paths require administrator access',
      );
    const roots = this.workspaceRoots(identity);
    if (allowProjectCreation) roots.push('/workspaces');
    const allowed = roots.some((root) => {
      return contains(canonical(root), target);
    });
    if (!allowed)
      throw new ForbiddenException('Access is limited to project workspaces');
    if (identity) {
      const owner = this.projectForPath(target);
      if (owner) this.requireProject(identity, owner);
      else if (!allowProjectCreation)
        throw new ForbiddenException('Path has no project owner');
    }
  }

  projectForPath(value: string): string | null {
    const canonical = (p: string) => {
      let current = resolve(p);
      const tail: string[] = [];
      for (;;) {
        try {
          return resolve(realpathSync(current), ...tail.reverse());
        } catch {
          const parent = dirname(current);
          if (parent === current)
            throw new ForbiddenException('Cannot verify document path');
          tail.push(current.slice(parent.length).replace(/^\//, ''));
          current = parent;
        }
      }
    };
    const target = canonical(value);
    const matches: Array<{ projectId: string; canonical: string }> = this.db
      .select()
      .from(projectWorkspaces)
      .all()
      .map((w) => ({ projectId: w.projectId, canonical: canonical(w.path) }))
      .filter((w) => {
        const rel = relative(w.canonical, target);
        const reverse = relative(target, w.canonical);
        return (
          rel === '' ||
          (rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel)) ||
          (reverse !== '..' &&
            !reverse.startsWith('../') &&
            !isAbsolute(reverse))
        );
      });
    for (const p of this.db.select().from(projects).all()) {
      const root = canonical(p.workspacePath);
      const rel = relative(root, target);
      const reverse = relative(target, root);
      if (
        rel === '' ||
        (rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel)) ||
        (reverse !== '..' && !reverse.startsWith('../') && !isAbsolute(reverse))
      )
        matches.push({
          projectId: p.id,
          canonical: root,
        });
    }
    const owners = new Set(matches.map((w) => w.projectId));
    if (owners.size > 1)
      throw new ForbiddenException('Workspace ownership is ambiguous');
    return matches[0]?.projectId ?? null;
  }

  createDocumentSession(
    identity: PlatformIdentity,
    path: string,
    writable: boolean,
  ): string {
    identity = this.current(identity);
    this.requireActive(identity);
    if (identity.role !== 'administrator')
      this.requireWorkspacePath(path, false, identity);
    let projectId: string | null = null;
    try {
      projectId = this.projectForPath(path);
    } catch (error) {
      if (identity.role !== 'administrator') throw error;
    }
    const id = randomUUID();
    this.db
      .delete(documentAccessSessions)
      .where(lte(documentAccessSessions.expiresAt, Date.now()))
      .run();
    this.db
      .insert(documentAccessSessions)
      .values({
        id,
        path,
        projectId,
        personId: identity.personId,
        administrator: identity.role === 'administrator',
        writable,
        impersonation: identity.impersonation ?? null,
        expiresAt:
          identity.impersonation?.expiresAt ?? Date.now() + 24 * 60 * 60 * 1000,
      })
      .run();
    return id;
  }

  verifyDocumentSession(id: unknown, path: string, writable = false): boolean {
    if (typeof id !== 'string') return false;
    const session = this.db
      .select()
      .from(documentAccessSessions)
      .where(eq(documentAccessSessions.id, id))
      .get();
    if (
      !session ||
      session.path !== path ||
      session.expiresAt <= Date.now() ||
      (writable && !session.writable)
    )
      return false;
    if (session.impersonation) {
      const context = session.impersonation;
      const active = [...this.impersonations.values()].some(
        (item) =>
          item.sessionId === context.sessionId && item.expiresAt > Date.now(),
      );
      const real = this.resolvePerson(context.administratorId);
      if (!active || !real.active || real.role !== 'administrator')
        return false;
      if (writable)
        this.auditImpersonation(
          context,
          'documentWriteAttempt',
          'DOCUMENT',
          'document-capability',
        );
    }
    // Service sessions are internal and can only be minted behind authenticated ingress.
    if (!session.personId) return session.administrator;
    const person = this.db
      .select()
      .from(people)
      .where(eq(people.id, session.personId))
      .get();
    if (!person?.active) return false;
    if (session.administrator) return person.role === 'administrator';
    try {
      const identity: PlatformIdentity = {
        kind: 'person',
        personId: person.id,
        name: person.name,
        role: person.role,
        active: person.active,
      };
      if (!session.projectId || this.projectForPath(path) !== session.projectId)
        return false;
      this.requireProject(identity, session.projectId);
      this.requireWorkspacePath(path, false, identity);
      return true;
    } catch {
      return false;
    }
  }

  getDocumentSession(id: unknown, path: string, writable = false) {
    if (!this.verifyDocumentSession(id, path, writable)) return null;
    return this.db
      .select()
      .from(documentAccessSessions)
      .where(eq(documentAccessSessions.id, id as string))
      .get();
  }

  clientConfig() {
    const row = this.db
      .select()
      .from(settings)
      .where(eq(settings.key, 'general.maxIdleSubscriptions'))
      .get();
    const parsed = Number(row?.value ?? row?.defaultValue ?? 30);
    return { maxIdleSubscriptions: Number.isFinite(parsed) ? parsed : 30 };
  }

  isAutomationResource(id: string) {
    return (
      this.db
        .select()
        .from(projectResources)
        .where(eq(projectResources.id, id))
        .get()?.type === 'automation_board'
    );
  }

  requireWorkspaceDeletions(projectId: string, ids: unknown) {
    if (!Array.isArray(ids)) return;
    const selected = new Set(ids);
    for (const workspace of this.db
      .select()
      .from(projectWorkspaces)
      .where(eq(projectWorkspaces.projectId, projectId))
      .all()) {
      if (selected.has(workspace.id)) this.requireWorkspacePath(workspace.path);
    }
  }
}
