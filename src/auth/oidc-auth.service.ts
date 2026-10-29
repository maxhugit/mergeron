import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { eq, lt } from 'drizzle-orm';
import { createHash, timingSafeEqual } from 'node:crypto';
import { DRIZZLE_DB, type AppDatabase } from '../database/database.constants';
import { oidcAuthFlows } from '../database/schema';
import {
  AuthConfigService,
  type AuthConfiguration,
} from './auth-config.service';
import { IdentityService } from './identity.service';
import { LocalAuthService, type LocalSession } from './local-auth.service';

type OidcClient = typeof import('openid-client');
type OidcConfiguration = import('openid-client').Configuration;

import { platformCookie, platformCookiePath } from './platform-cookie';
const FLOW_COOKIE = 'codex_webui_oidc_state';
const FLOW_LIFETIME_MS = 10 * 60_000;

export interface OidcStart {
  authorizationUrl: string;
  cookie: string;
}

export interface OidcCallback {
  session: LocalSession;
  returnTo: string;
}

@Injectable()
export class OidcAuthService {
  private cached?: {
    key: string;
    expiresAt: number;
    configuration: OidcConfiguration;
  };

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: AppDatabase,
    private readonly authConfig: AuthConfigService,
    private readonly identities: IdentityService,
    private readonly sessions: LocalAuthService,
  ) {}

  async validateConfiguration(oidc: AuthConfiguration['oidc']): Promise<void> {
    const configuration = await this.discover(oidc, true);
    const metadata = configuration.serverMetadata();
    if (
      !metadata.authorization_endpoint ||
      !metadata.token_endpoint ||
      !metadata.jwks_uri
    )
      throw new BadRequestException(
        'OIDC provider metadata is missing required endpoints',
      );
  }

  async start(returnTo: unknown, secure: boolean): Promise<OidcStart> {
    const oidc = this.enabledConfiguration();
    const client = await this.client();
    const configuration = await this.discover(oidc);
    const state = client.randomState();
    const codeVerifier = client.randomPKCECodeVerifier();
    const nonce = client.randomNonce();
    const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);
    const now = Date.now();
    this.db.delete(oidcAuthFlows).where(lt(oidcAuthFlows.expiresAt, now)).run();
    this.db
      .insert(oidcAuthFlows)
      .values({
        stateHash: this.digest(state),
        codeVerifier,
        nonce,
        returnTo: this.safeReturnTo(returnTo),
        createdAt: now,
        expiresAt: now + FLOW_LIFETIME_MS,
      })
      .run();
    const authorizationUrl = client.buildAuthorizationUrl(configuration, {
      redirect_uri: oidc.redirectUri,
      scope: oidc.scopes,
      response_type: 'code',
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      state,
      nonce,
    });
    return {
      authorizationUrl: authorizationUrl.href,
      cookie: this.flowCookie(
        state,
        secure,
        Math.floor(FLOW_LIFETIME_MS / 1000),
      ),
    };
  }

  async callback(
    query: Record<string, unknown>,
    cookieHeader: unknown,
    userAgent?: string,
  ): Promise<OidcCallback> {
    const oidc = this.enabledConfiguration();
    const state = this.queryString(query.state);
    const cookieState = this.readCookie(
      cookieHeader,
      platformCookie(FLOW_COOKIE),
    );
    if (!state || !cookieState || !this.equal(state, cookieState))
      throw new BadRequestException('Invalid or missing OIDC state');
    const stateHash = this.digest(state);
    const flow = this.db
      .select()
      .from(oidcAuthFlows)
      .where(eq(oidcAuthFlows.stateHash, stateHash))
      .get();
    this.db
      .delete(oidcAuthFlows)
      .where(eq(oidcAuthFlows.stateHash, stateHash))
      .run();
    if (!flow || flow.expiresAt <= Date.now())
      throw new BadRequestException('OIDC authentication request has expired');
    const configuration = await this.discover(oidc);
    const client = await this.client();
    const callbackUrl = new URL(oidc.redirectUri);
    callbackUrl.search = '';
    for (const [name, value] of Object.entries(query)) {
      const first: unknown = Array.isArray(value)
        ? (value as unknown[])[0]
        : value;
      if (typeof first === 'string') callbackUrl.searchParams.set(name, first);
    }
    let tokens: Awaited<ReturnType<OidcClient['authorizationCodeGrant']>>;
    try {
      tokens = await client.authorizationCodeGrant(configuration, callbackUrl, {
        pkceCodeVerifier: flow.codeVerifier,
        expectedState: state,
        expectedNonce: flow.nonce,
        idTokenExpected: true,
      });
    } catch {
      throw new ForbiddenException('OIDC authentication failed');
    }
    const claims = tokens.claims();
    const subject = claims?.sub;
    if (typeof subject !== 'string' || !subject || subject.length > 512)
      throw new ForbiddenException('OIDC identity has no valid subject');
    const email = typeof claims?.email === 'string' ? claims.email : '';
    const identity = this.identities.resolveOidc(
      subject,
      email,
      claims?.email_verified === true,
    );
    if (!identity.active || !identity.personId)
      throw new ForbiddenException(
        'OIDC identity is not linked to an active person',
      );
    return {
      session: this.sessions.createSession(identity.personId, userAgent),
      returnTo: flow.returnTo,
    };
  }

  clearFlowCookie(secure: boolean): string {
    return this.flowCookie('', secure, 0);
  }

  private enabledConfiguration(): AuthConfiguration['oidc'] {
    const oidc = this.authConfig.get().oidc;
    if (!oidc.enabled) throw new ForbiddenException('OIDC is disabled');
    return oidc;
  }

  private async discover(
    oidc: AuthConfiguration['oidc'],
    force = false,
  ): Promise<OidcConfiguration> {
    const key = this.digest(
      `${oidc.issuerUrl}\0${oidc.clientId}\0${oidc.clientSecret}`,
    );
    if (
      !force &&
      this.cached?.key === key &&
      this.cached.expiresAt > Date.now()
    )
      return this.cached.configuration;
    try {
      const client = await this.client();
      const configuration = await client.discovery(
        new URL(oidc.issuerUrl),
        oidc.clientId,
        {
          client_secret: oidc.clientSecret,
          redirect_uris: [oidc.redirectUri],
          response_types: ['code'],
        },
      );
      client.enableNonRepudiationChecks(configuration);
      this.cached = {
        key,
        expiresAt: Date.now() + 10 * 60_000,
        configuration,
      };
      return configuration;
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      throw new ServiceUnavailableException('Unable to contact OIDC provider');
    }
  }

  private async client(): Promise<OidcClient> {
    return import('openid-client');
  }

  private flowCookie(value: string, secure: boolean, maxAge: number): string {
    return `${platformCookie(FLOW_COOKIE)}=${value}; Path=${platformCookiePath('/api/auth/oidc')}; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure || process.env.MERGERON_PREVIEWS_ENABLED === 'true' ? '; Secure' : ''}`;
  }

  private safeReturnTo(value: unknown): string {
    if (
      typeof value !== 'string' ||
      !value.startsWith('/') ||
      value.startsWith('//') ||
      value.includes('\\') ||
      value.length > 2048
    )
      return '/';
    return value;
  }

  private queryString(value: unknown): string | null {
    const first: unknown = Array.isArray(value)
      ? (value as unknown[])[0]
      : value;
    return typeof first === 'string' && first.length <= 2048 ? first : null;
  }

  private digest(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }

  private equal(left: string, right: string): boolean {
    const a = Buffer.from(left);
    const b = Buffer.from(right);
    return a.length === b.length && timingSafeEqual(a, b);
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
      return token.length <= 2048 ? token : null;
    }
    return null;
  }
}
