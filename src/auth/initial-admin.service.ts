/** Explicit, Manager-armed first installation. Never infer eligibility from missing administrators. */
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { eq } from 'drizzle-orm';
import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { DRIZZLE_DB, type AppDatabase } from '../database/database.constants';
import {
  localAuthCredentials,
  people,
  projects,
  settings,
} from '../database/schema';
import { LocalAuthService } from './local-auth.service';

export const INITIAL_ADMIN_KEY = 'auth.initialAdminSetupSecret';
export const INITIAL_ADMIN_COOKIE = '__Host-mergeron_setup';
const LIFETIME = 15 * 60_000;
interface Marker {
  version: 1;
  installationId: string;
  state: 'armed' | 'closed';
}
interface SetupState {
  installationId: string;
  completed: boolean;
  tokenHash: string | null;
  expiresAt: number;
  grantHash: string | null;
  grantExpiresAt: number;
  failures: number;
  lockedUntil: number;
}
const digest = (value: string) =>
  createHash('sha256').update(value).digest('hex');
function equal(left: string, right: string) {
  return timingSafeEqual(
    Buffer.from(digest(left), 'hex'),
    Buffer.from(digest(right), 'hex'),
  );
}
const csrf = (grant: string) =>
  createHmac('sha256', grant)
    .update('mergeron-initial-admin-csrf-v1')
    .digest('base64url');
function secret(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
}

@Injectable()
export class InitialAdminService {
  private readonly logger = new Logger(InitialAdminService.name);
  readonly markerPath: string;
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: AppDatabase,
    private readonly config: ConfigService,
    private readonly localAuth: LocalAuthService,
  ) {
    this.markerPath = join(
      config.get<string>('CODEX_HOME') ?? join(homedir(), '.codex'),
      'webui-initial-admin.json',
    );
  }

  private marker(): Marker | null {
    let fd: number;
    try {
      fd = openSync(this.markerPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    try {
      const info = fstatSync(fd);
      if (!info.isFile() || info.size > 4096 || (info.mode & 0o077) !== 0)
        throw new Error('Invalid first-administrator authorization');
      const value = JSON.parse(readFileSync(fd, 'utf8')) as Marker;
      if (
        value.version !== 1 ||
        !/^[0-9a-f-]{36}$/.test(value.installationId) ||
        !['armed', 'closed'].includes(value.state)
      )
        throw new Error('Invalid first-administrator authorization');
      return value;
    } finally {
      closeSync(fd);
    }
  }
  private state(): SetupState | null {
    const row = this.db
      .select()
      .from(settings)
      .where(eq(settings.key, INITIAL_ADMIN_KEY))
      .get();
    if (!row) return null;
    const value = JSON.parse(row.value!) as SetupState;
    if (
      typeof value?.installationId !== 'string' ||
      typeof value.completed !== 'boolean' ||
      ![
        value.expiresAt,
        value.grantExpiresAt,
        value.failures,
        value.lockedUntil,
      ].every((n) => Number.isSafeInteger(n) && n >= 0) ||
      ![value.tokenHash, value.grantHash].every(
        (s) =>
          s === null || (typeof s === 'string' && /^[a-f0-9]{64}$/.test(s)),
      )
    )
      throw new Error('Invalid first-administrator state');
    return value;
  }
  private save(value: SetupState) {
    this.db
      .insert(settings)
      .values({
        key: INITIAL_ADMIN_KEY,
        value: JSON.stringify(value),
        type: 'string',
        category: 'authentication-private',
        description: 'Private first-administrator activation state',
        defaultValue: '{}',
        constraints: '{}',
        updatedAt: Date.now(),
      })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value: JSON.stringify(value), updatedAt: Date.now() },
      })
      .run();
  }
  private empty() {
    return (
      !this.db.select({ id: people.id }).from(people).limit(1).get() &&
      !this.db.select({ id: projects.id }).from(projects).limit(1).get() &&
      !this.db
        .select({ id: localAuthCredentials.id })
        .from(localAuthCredentials)
        .limit(1)
        .get()
    );
  }
  private eligible() {
    const marker = this.marker();
    if (
      !marker ||
      marker.state !== 'armed' ||
      !this.localAuth.methods().localEnabled
    )
      return false;
    const state = this.state();
    return (
      this.empty() &&
      (!state ||
        (!state.completed && state.installationId === marker.installationId))
    );
  }
  private grant(cookie: unknown) {
    if (typeof cookie !== 'string' || cookie.length > 16384) return null;
    const matches = cookie
      .split(';')
      .map((part) => part.trim())
      .filter((part) => part.startsWith(INITIAL_ADMIN_COOKIE + '='));
    if (matches.length !== 1) return null;
    const value = matches[0].slice(INITIAL_ADMIN_COOKIE.length + 1);
    return secret(value) ? value : null;
  }
  private authorized(cookie: unknown) {
    const grant = this.grant(cookie),
      state = this.state();
    return grant &&
      state?.grantHash &&
      state.grantExpiresAt > Date.now() &&
      equal(digest(grant), state.grantHash)
      ? grant
      : null;
  }
  status(cookie?: unknown) {
    if (!this.eligible()) return { required: false, authorized: false };
    const grant = this.authorized(cookie);
    const prefix =
      this.config.get<string>('MERGERON_STACK_PREFIX') ?? 'mergeron';
    return {
      required: true,
      authorized: !!grant,
      ...(this.config.get<string>('MERGERON_PREVIEW_SETUP') === 'true'
        ? { activationCommand: 'node scripts/preview/activate.mjs' }
        : {}),
      ...(grant ? { csrfToken: csrf(grant) } : {}),
      containerName: /^[a-z0-9][a-z0-9-]{0,62}$/.test(prefix)
        ? `${prefix}-ui`
        : 'mergeron-ui',
    };
  }
  requireOrigin(origin: unknown) {
    const configured = this.config.get<string>('MERGERON_PUBLIC_URL');
    if (typeof configured !== 'string' || typeof origin !== 'string')
      throw new ForbiddenException(
        'Setup requires its configured HTTPS origin',
      );
    let expected: URL;
    try {
      expected = new URL(configured);
    } catch {
      throw new ForbiddenException(
        'Setup requires its configured HTTPS origin',
      );
    }
    if (
      expected.protocol !== 'https:' ||
      expected.username ||
      expected.password ||
      origin !== expected.origin
    )
      throw new ForbiddenException(
        'Setup requires its configured HTTPS origin',
      );
  }

  /** Called only by the operator's container-console command, never a public route. */
  issueCode(retryInterrupted = false) {
    let rearm: Marker | null = null;
    const code = this.db.transaction(
      () => {
        const marker = this.marker(),
          before = this.state();
        if (
          !marker ||
          !this.localAuth.methods().localEnabled ||
          !this.empty() ||
          before?.completed ||
          (before && before.installationId !== marker.installationId) ||
          (marker.state !== 'armed' && (!retryInterrupted || !before))
        )
          throw new ConflictException(
            'First-administrator setup is unavailable',
          );
        // Recovery is an explicit host operation; a public request never re-arms setup.
        if (marker.state === 'closed') rearm = { ...marker, state: 'armed' };
        const code = randomBytes(32).toString('base64url');
        this.save({
          installationId: marker.installationId,
          completed: false,
          tokenHash: digest(code),
          expiresAt: Date.now() + LIFETIME,
          grantHash: null,
          grantExpiresAt: 0,
          failures: 0,
          lockedUntil: 0,
        });
        return code;
      },
      { behavior: 'immediate' },
    );
    // Failed persistence must never reopen a sealed installation.
    if (rearm) this.writeMarker(rearm);
    return code;
  }
  verify(code: unknown) {
    const result = this.db.transaction(
      () => {
        if (!this.eligible()) return null;
        const state = this.state(),
          now = Date.now();
        if (!state || state.lockedUntil > now) return null;
        if (
          !secret(code) ||
          !state.tokenHash ||
          state.expiresAt <= now ||
          !equal(digest(code), state.tokenHash)
        ) {
          const failures = state.failures + 1;
          this.save({
            ...state,
            failures: failures % 10,
            lockedUntil: failures >= 10 ? now + 60_000 : 0,
          });
          return null;
        }
        const grant = randomBytes(32).toString('base64url');
        this.save({
          ...state,
          tokenHash: null,
          grantHash: digest(grant),
          grantExpiresAt: Math.min(state.expiresAt, now + LIFETIME),
          failures: 0,
          lockedUntil: 0,
        });
        return {
          grant,
          csrfToken: csrf(grant),
          expiresAt: Math.min(state.expiresAt, now + LIFETIME),
        };
      },
      { behavior: 'immediate' },
    );
    if (!result)
      throw new UnauthorizedException('Invalid or expired setup code');
    return result;
  }
  async complete(cookie: unknown, input: unknown) {
    if (!this.eligible())
      throw new ConflictException('First-administrator setup is unavailable');
    const grant = this.authorized(cookie);
    if (!grant)
      throw new UnauthorizedException('Invalid or expired setup session');
    const body = input as Record<string, unknown>;
    if (
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      Object.keys(body).some(
        (key) =>
          ![
            'firstName',
            'lastName',
            'email',
            'username',
            'password',
            'passwordConfirmation',
            'csrfToken',
          ].includes(key),
      )
    )
      throw new BadRequestException('Invalid setup form');
    if (
      typeof body.csrfToken !== 'string' ||
      !equal(csrf(grant), body.csrfToken)
    )
      throw new ForbiddenException('Invalid setup CSRF token');
    const text = (value: unknown, limit: number) => {
      if (
        typeof value !== 'string' ||
        !value.trim() ||
        value.length > limit ||
        [...value].some(
          (character) =>
            character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
        )
      )
        throw new BadRequestException('Invalid administrator details');
      return value.trim();
    };
    const firstName = text(body.firstName, 100),
      lastName = text(body.lastName, 100),
      email = text(body.email, 254).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      throw new BadRequestException('Invalid email');
    if (body.password !== body.passwordConfirmation)
      throw new BadRequestException('Passwords do not match');
    const credential = await this.localAuth.prepareNewAccount({
      username: body.username,
      password: body.password,
    });
    const personId = this.db.transaction(
      () => {
        // Hashing is outside the transaction. Revalidate ownership, expiry and eligibility after it.
        if (!this.eligible() || this.authorized(cookie) !== grant)
          throw new ConflictException('Setup changed or expired; start again');
        const marker = this.marker()!,
          state = this.state()!,
          now = Date.now(),
          id = randomUUID();
        // Seal outside the DB before committing: restoring/deleting an older DB cannot reopen setup.
        // A crash here fails closed; only the operator's --retry-interrupted command can recover.
        this.writeMarker({ ...marker, state: 'closed' });
        this.db
          .insert(people)
          .values({
            id,
            reference: 'ADM-001',
            name: `${firstName} ${lastName}`,
            firstName,
            lastName,
            email,
            role: 'administrator',
            active: true,
            createdAt: now,
            updatedAt: now,
          })
          .run();
        this.db
          .insert(localAuthCredentials)
          .values({
            id: randomUUID(),
            personId: id,
            ...credential,
            failedAttempts: 0,
            passwordChangedAt: now,
            createdAt: now,
            updatedAt: now,
          })
          .run();
        this.save({
          ...state,
          completed: true,
          tokenHash: null,
          grantHash: null,
          expiresAt: 0,
          grantExpiresAt: 0,
        });
        return id;
      },
      { behavior: 'immediate' },
    );
    this.logger.log({ event: 'initialAdministratorCreated', personId });
    return { completed: true };
  }
  private writeMarker(marker: Marker) {
    const path = `${this.markerPath}.${randomUUID()}.tmp`;
    const fd = openSync(
      path,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      writeFileSync(fd, JSON.stringify(marker));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      renameSync(path, this.markerPath);
    } catch (error) {
      unlinkSync(path);
      throw error;
    }
    const directory = openSync(dirname(this.markerPath), constants.O_RDONLY);
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  }
  cookie(grant = '', expiresAt = 0) {
    return `${INITIAL_ADMIN_COOKIE}=${grant}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${Math.max(0, Math.floor((expiresAt - Date.now()) / 1000))}`;
  }
}
