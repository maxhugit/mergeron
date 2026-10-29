import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { hash, verify } from '@node-rs/argon2';
import { and, eq, gt, isNull, lt } from 'drizzle-orm';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { DRIZZLE_DB, type AppDatabase } from '../database/database.constants';
import { authSessions, localAuthCredentials, people } from '../database/schema';
import { AuthConfigService } from './auth-config.service';
import { platformCookie } from './platform-cookie';

const COOKIE_NAME = 'codex_webui_session';
const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{2,63}$/;
const PASSWORD_MINIMUM_LENGTH = 12;
const ONLINE_ACTIVITY_WINDOW_MS = 10 * 60_000;
const DUMMY_PASSWORD_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$XE3EuZjaLTzh0UMAokZNEg$9gJVH813LaMQ8lMhW3xc8fPS9e3ZAh81PB5pnQX1/Uo';

export interface LocalSession {
  token: string;
  personId: string;
  expiresAt: number;
}

@Injectable()
export class LocalAuthService {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: AppDatabase,
    private readonly configuration: AuthConfigService,
  ) {}

  methods() {
    const config = this.configuration.getPublic();
    return {
      localEnabled: config.local.enabled,
      oidcEnabled: config.oidc.enabled,
      oidcAutoRedirect: config.oidc.enabled && config.oidc.autoRedirect,
      apiKeyEnabled: true,
    };
  }

  listAccounts() {
    const now = Date.now();
    this.deleteExpiredSessions(now);
    const credentials = this.db.select().from(localAuthCredentials).all();
    const byPerson = new Map(credentials.map((item) => [item.personId, item]));
    const sessionsByPerson = new Map<
      string,
      { activeSessionCount: number; connectedSince: number; lastSeenAt: number }
    >();
    for (const session of this.db
      .select()
      .from(authSessions)
      .where(
        and(
          isNull(authSessions.revokedAt),
          gt(authSessions.expiresAt, now),
          gt(authSessions.lastSeenAt, now - ONLINE_ACTIVITY_WINDOW_MS),
        ),
      )
      .all()) {
      const presence = sessionsByPerson.get(session.personId);
      sessionsByPerson.set(session.personId, {
        activeSessionCount: (presence?.activeSessionCount ?? 0) + 1,
        connectedSince: Math.min(
          presence?.connectedSince ?? session.createdAt,
          session.createdAt,
        ),
        lastSeenAt: Math.max(
          presence?.lastSeenAt ?? session.lastSeenAt,
          session.lastSeenAt,
        ),
      });
    }
    return this.db
      .select()
      .from(people)
      .all()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((person) => {
        const credential = byPerson.get(person.id);
        const presence = sessionsByPerson.get(person.id);
        return {
          personId: person.id,
          name: person.name,
          email: person.email,
          active: person.active,
          role: person.role,
          username: credential?.username ?? null,
          passwordConfigured: Boolean(credential),
          oidcLinked: Boolean(person.identitySubject),
          lockedUntil: credential?.lockedUntil ?? null,
          lastLoginAt: credential?.lastLoginAt ?? null,
          connected: Boolean(presence),
          connectedSince: presence?.connectedSince ?? null,
          lastSeenAt: presence?.lastSeenAt ?? null,
          activeSessionCount: presence?.activeSessionCount ?? 0,
        };
      });
  }

  async setAccount(
    personId: string,
    input: { username?: unknown; password?: unknown },
  ) {
    const person = this.db
      .select()
      .from(people)
      .where(eq(people.id, personId))
      .get();
    if (!person) throw new BadRequestException('Unknown person');
    if (person.identitySubject)
      throw new BadRequestException(
        'A local password cannot be configured for an SSO-linked account',
      );
    const existing = this.db
      .select()
      .from(localAuthCredentials)
      .where(eq(localAuthCredentials.personId, personId))
      .get();
    const username = this.normalizeUsername(
      input.username ?? existing?.username,
    );
    const usernameOwner = this.db
      .select({ personId: localAuthCredentials.personId })
      .from(localAuthCredentials)
      .where(eq(localAuthCredentials.username, username))
      .get();
    if (usernameOwner && usernameOwner.personId !== personId)
      throw new BadRequestException('Username is already in use');
    const password = input.password;
    if (!existing && typeof password !== 'string')
      throw new BadRequestException('A password is required');
    if (password !== undefined && typeof password !== 'string')
      throw new BadRequestException('Invalid password');
    if (
      typeof password === 'string' &&
      password.length < PASSWORD_MINIMUM_LENGTH
    )
      throw new BadRequestException(
        `Password must contain at least ${PASSWORD_MINIMUM_LENGTH} characters`,
      );
    const now = Date.now();
    const passwordHash =
      typeof password === 'string'
        ? await hash(password, {
            algorithm: 2,
            memoryCost: 19_456,
            timeCost: 2,
            parallelism: 1,
            outputLen: 32,
          })
        : existing!.passwordHash;
    this.db
      .insert(localAuthCredentials)
      .values({
        id: existing?.id ?? randomUUID(),
        personId,
        username,
        passwordHash,
        failedAttempts: 0,
        lockedUntil: null,
        lastLoginAt: existing?.lastLoginAt ?? null,
        passwordChangedAt:
          typeof password === 'string' ? now : existing!.passwordChangedAt,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: localAuthCredentials.personId,
        set: {
          username,
          passwordHash,
          failedAttempts: 0,
          lockedUntil: null,
          passwordChangedAt:
            typeof password === 'string' ? now : existing!.passwordChangedAt,
          updatedAt: now,
        },
      })
      .run();
    this.revokePersonSessions(personId);
    return this.listAccounts().find((item) => item.personId === personId)!;
  }

  removeAccount(personId: string): void {
    const count = this.db.select().from(localAuthCredentials).all().length;
    if (this.configuration.get().local.enabled && count <= 1)
      throw new BadRequestException(
        'Disable local authentication before removing its last account',
      );
    this.db
      .delete(localAuthCredentials)
      .where(eq(localAuthCredentials.personId, personId))
      .run();
  }

  ensureLocalCanBeEnabled(): void {
    const usable = this.db
      .select({ id: localAuthCredentials.id })
      .from(localAuthCredentials)
      .innerJoin(people, eq(people.id, localAuthCredentials.personId))
      .where(eq(people.active, true))
      .get();
    if (!usable)
      throw new BadRequestException(
        'Configure at least one active local account before enabling local authentication',
      );
  }

  async login(
    usernameInput: unknown,
    passwordInput: unknown,
    userAgent?: string,
  ): Promise<LocalSession> {
    if (!this.configuration.get().local.enabled)
      throw new ForbiddenException('Local authentication is disabled');
    if (typeof passwordInput !== 'string' || !passwordInput)
      throw new UnauthorizedException('Invalid username or password');
    let username: string;
    try {
      username = this.normalizeUsername(usernameInput);
    } catch {
      throw new UnauthorizedException('Invalid username or password');
    }
    const credential = this.db
      .select()
      .from(localAuthCredentials)
      .where(eq(localAuthCredentials.username, username))
      .get();
    const now = Date.now();
    const valid = await verify(
      credential?.passwordHash ?? DUMMY_PASSWORD_HASH,
      passwordInput,
    );
    if (!credential || (credential.lockedUntil ?? 0) > now)
      throw new UnauthorizedException('Invalid username or password');
    const person = this.db
      .select()
      .from(people)
      .where(eq(people.id, credential.personId))
      .get();
    if (!valid || !person?.active) {
      this.recordFailure(credential.id, credential.failedAttempts, now);
      throw new UnauthorizedException('Invalid username or password');
    }
    this.db
      .update(localAuthCredentials)
      .set({
        failedAttempts: 0,
        lockedUntil: null,
        lastLoginAt: now,
        updatedAt: now,
      })
      .where(eq(localAuthCredentials.id, credential.id))
      .run();
    return this.createSession(person.id, userAgent);
  }

  authenticateCookie(cookieHeader: unknown): string | null {
    const config = this.configuration.get();
    if (!config.local.enabled && !config.oidc.enabled) return null;
    const token = this.readCookie(cookieHeader, platformCookie(COOKIE_NAME));
    if (!token) return null;
    const now = Date.now();
    const session = this.db
      .select()
      .from(authSessions)
      .where(
        and(
          eq(authSessions.tokenHash, this.digest(token)),
          isNull(authSessions.revokedAt),
          gt(authSessions.expiresAt, now),
        ),
      )
      .get();
    if (!session) return null;
    if (now - session.lastSeenAt > 5 * 60_000)
      this.db
        .update(authSessions)
        .set({ lastSeenAt: now })
        .where(eq(authSessions.tokenHash, session.tokenHash))
        .run();
    return session.personId;
  }

  createSession(personId: string, userAgent?: string): LocalSession {
    const now = Date.now();
    this.deleteExpiredSessions(now);
    const token = randomBytes(32).toString('base64url');
    const expiresAt =
      now + this.configuration.get().local.sessionTtlHours * 60 * 60 * 1000;
    this.db
      .insert(authSessions)
      .values({
        tokenHash: this.digest(token),
        personId,
        createdAt: now,
        lastSeenAt: now,
        expiresAt,
        revokedAt: null,
        userAgent: userAgent?.slice(0, 512) ?? null,
      })
      .run();
    return { token, personId, expiresAt };
  }

  logout(cookieHeader: unknown): void {
    const token = this.readCookie(cookieHeader, platformCookie(COOKIE_NAME));
    if (!token) return;
    this.db
      .update(authSessions)
      .set({ revokedAt: Date.now() })
      .where(eq(authSessions.tokenHash, this.digest(token)))
      .run();
  }

  revokeAllSessions(): void {
    this.db
      .update(authSessions)
      .set({ revokedAt: Date.now() })
      .where(isNull(authSessions.revokedAt))
      .run();
  }

  cookie(session: LocalSession, secure: boolean): string {
    const maxAge = Math.max(
      0,
      Math.floor((session.expiresAt - Date.now()) / 1000),
    );
    return `${platformCookie(COOKIE_NAME)}=${session.token}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure || process.env.MERGERON_PREVIEWS_ENABLED === 'true' ? '; Secure' : ''}`;
  }

  clearCookie(secure: boolean): string {
    return `${platformCookie(COOKIE_NAME)}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure || process.env.MERGERON_PREVIEWS_ENABLED === 'true' ? '; Secure' : ''}`;
  }

  private recordFailure(id: string, previous: number, now: number): void {
    const config = this.configuration.get().local;
    const failedAttempts = previous + 1;
    this.db
      .update(localAuthCredentials)
      .set({
        failedAttempts,
        lockedUntil:
          failedAttempts >= config.maxFailedAttempts
            ? now + config.lockoutMinutes * 60_000
            : null,
        updatedAt: now,
      })
      .where(eq(localAuthCredentials.id, id))
      .run();
  }

  private normalizeUsername(value: unknown): string {
    if (typeof value !== 'string')
      throw new BadRequestException('Invalid username');
    const username = value.trim().toLowerCase();
    if (!USERNAME_PATTERN.test(username))
      throw new BadRequestException(
        'Username must contain 3 to 64 lowercase letters, digits, dots, dashes or underscores',
      );
    return username;
  }

  revokePersonSessions(personId: string): void {
    this.db
      .update(authSessions)
      .set({ revokedAt: Date.now() })
      .where(
        and(
          eq(authSessions.personId, personId),
          isNull(authSessions.revokedAt),
        ),
      )
      .run();
  }

  private deleteExpiredSessions(now: number): void {
    this.db.delete(authSessions).where(lt(authSessions.expiresAt, now)).run();
  }

  private digest(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private readCookie(header: unknown, name: string): string | null {
    const value: unknown = Array.isArray(header)
      ? (header as unknown[])[0]
      : header;
    if (typeof value !== 'string') return null;
    for (const part of value.split(';')) {
      const separator = part.indexOf('=');
      if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
      const token = part.slice(separator + 1).trim();
      return token.length <= 512 ? token : null;
    }
    return null;
  }
}
