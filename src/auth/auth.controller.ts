import { isSsoProxySource } from './sso-proxy-source';
/** REST controller for API-key, local-session and OIDC authentication flows. */
import {
  Body,
  BadRequestException,
  ForbiddenException,
  Controller,
  HttpCode,
  HttpStatus,
  Header,
  Get,
  Query,
  Delete,
  Param,
  Put,
  Patch,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { BusinessException } from '../common/business.exception';
import { ErrorCode } from '../common/error-codes';
import {
  ApiBody,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ApiErrorResponseDto } from '../common/dto/api-responses.dto';
import { AuthService } from './auth.service';
import { LoginRequestDto, LoginResponseDto } from './dto/auth.dto';
import { Public } from './public.decorator';
import { IdentityService } from './identity.service';
import type { IdentityRequest } from './platform-access.guard';
import { AuthConfigService } from './auth-config.service';
import { LocalAuthService } from './local-auth.service';
import {
  OidcAuthService,
  SilentOidcFailure,
  silentReturnPath,
} from './oidc-auth.service';
import {
  renewalRequest as validateRenewalRequest,
  sendRenewalPage,
} from './session-renewal-page';

function renewalRequest(value: unknown): string {
  try {
    return validateRenewalRequest(value);
  } catch {
    throw new BadRequestException('Invalid renewal request');
  }
}

function getRequestId(request: FastifyRequest): string | undefined {
  const id = (request as unknown as { id?: unknown }).id;
  return typeof id === 'string' ? id : undefined;
}

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly identities: IdentityService,
    private readonly authConfig: AuthConfigService,
    private readonly localAuth: LocalAuthService,
    private readonly oidcAuth: OidcAuthService,
  ) {}

  @Get('me/document-explorer/:threadId')
  documentExplorer(
    @Param('threadId') id: string,
    @Req() request: IdentityRequest,
  ) {
    return this.identities.documentExplorerView(request.platformIdentity, id);
  }
  @Patch('me/document-explorer/:threadId')
  setDocumentExplorer(
    @Param('threadId') id: string,
    @Req() request: IdentityRequest,
    @Body() body: { mode?: unknown; personId?: unknown },
  ) {
    if (body.personId !== request.platformIdentity?.personId)
      throw new ForbiddenException('Identity changed');
    if (body.mode === undefined) body.mode = null;
    return this.identities.documentExplorerView(
      request.platformIdentity,
      id,
      body.mode,
    );
  }

  /** Public capability discovery used by the login page. */
  @Public()
  @Get('methods')
  methods() {
    return this.localAuth.methods();
  }

  /** Administrator-facing configuration; secrets are write-only. */
  @Get('configuration')
  configuration() {
    return { ...this.authConfig.getPublic(), path: this.authConfig.path };
  }

  @Patch('configuration')
  async updateConfiguration(@Body() body: unknown) {
    const current = this.authConfig.get();
    const requested = body as { local?: { enabled?: unknown } } | null;
    if (!current.local.enabled && requested?.local?.enabled === true)
      this.localAuth.ensureLocalCanBeEnabled();
    const next = this.authConfig.prepareUpdate(body);
    const oidcChanged =
      JSON.stringify(current.oidc) !== JSON.stringify(next.oidc);
    if (next.oidc.enabled && oidcChanged)
      await this.oidcAuth.validateConfiguration(next.oidc);
    const updated = this.authConfig.save(next);
    if (
      (current.local.enabled && !updated.local.enabled) ||
      (current.oidc.enabled && (!updated.oidc.enabled || oidcChanged))
    )
      this.localAuth.revokeAllSessions();
    return { ...updated, path: this.authConfig.path };
  }

  @Get('local-accounts')
  localAccounts() {
    return { accounts: this.localAuth.listAccounts() };
  }

  @Put('local-accounts/:personId')
  async setLocalAccount(
    @Param('personId') personId: string,
    @Body() body: { username?: unknown; password?: unknown },
  ) {
    return { account: await this.localAuth.setAccount(personId, body ?? {}) };
  }

  @Delete('local-accounts/:personId')
  @HttpCode(HttpStatus.NO_CONTENT)
  removeLocalAccount(@Param('personId') personId: string): void {
    this.localAuth.removeAccount(personId);
  }

  /** Administrator action that invalidates every browser session for one person. */
  @Post('sessions/:personId/revoke')
  @HttpCode(HttpStatus.OK)
  revokePersonSessions(@Param('personId') personId: string) {
    this.localAuth.revokePersonSessions(personId);
    return { revoked: true };
  }

  @Get('me')
  @Header('Cache-Control', 'no-store')
  me(@Req() request: IdentityRequest) {
    const identity =
      request.platformIdentity ?? this.identities.resolve(request.headers);
    return {
      ...identity,
      fastNavigationProjectId: this.identities.navigationProject(identity),
      textSizes: this.identities.textSizes(identity),
    };
  }

  @Post('impersonation')
  startImpersonation(
    @Req() request: FastifyRequest & IdentityRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Body() body: { personId?: unknown },
  ) {
    this.requireSameOrigin(request);
    const real = this.identities.resolveOriginal(
      request.headers,
      request.authenticatedPersonId,
    );
    const token = this.identities.startImpersonation(
      real,
      request.headers,
      body?.personId,
    );
    reply.header('Cache-Control', 'no-store');
    reply.header(
      'set-cookie',
      this.identities.impersonationCookie(token, this.secureCookie(request)),
    );
    return { started: true };
  }

  @Get('impersonation-audit')
  @Header('Cache-Control', 'no-store')
  impersonationAudit(@Req() request: IdentityRequest) {
    return {
      events: this.identities.listImpersonationAudit(
        request.platformIdentity ?? this.identities.resolve(request.headers),
      ),
    };
  }

  @Delete('impersonation')
  stopImpersonation(
    @Req() request: FastifyRequest & IdentityRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    this.requireSameOrigin(request);
    const real = this.identities.resolveOriginal(
      request.headers,
      request.authenticatedPersonId,
    );
    this.identities.stopImpersonation(real, request.headers);
    reply.header('Cache-Control', 'no-store');
    reply.header(
      'set-cookie',
      this.identities.impersonationCookie('', this.secureCookie(request)),
    );
    return { stopped: true };
  }

  @Patch('preferences')
  preferences(
    @Req() request: IdentityRequest,
    @Body()
    body: {
      theme?: unknown;
      language?: unknown;
      fastNavigationProjectId?: unknown;
      textSize?: unknown;
    },
  ) {
    const identity =
      request.platformIdentity ?? this.identities.resolve(request.headers);
    return this.identities.updatePreferences(identity, body ?? {});
  }

  /** Deliberately exposes only a non-sensitive client setting, never the settings catalog. */
  @Get('client-config')
  clientConfig() {
    return this.identities.clientConfig();
  }

  /** Exchanges the deployment API key for a short-lived JWT. */
  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Login with the WebUI API key' })
  @ApiBody({ type: LoginRequestDto })
  @ApiOkResponse({ type: LoginResponseDto })
  @ApiUnauthorizedResponse({ type: ApiErrorResponseDto })
  async login(
    @Body() body: LoginRequestDto,
    @Req() request: FastifyRequest,
  ): Promise<LoginResponseDto> {
    const requestId = getRequestId(request);
    if (!this.authService.validateApiKey(body.apiKey)) {
      this.authService.logAuthEvent('warn', {
        authType: 'apiKeyLogin',
        reason: 'invalidApiKey',
        requestId,
      });
      throw BusinessException.unauthorized(
        ErrorCode.auth.invalidApiKey,
        'Invalid API key',
      );
    }

    this.authService.logAuthEvent('log', {
      authType: 'apiKeyLogin',
      reason: 'loginSuccess',
      requestId,
    });
    return this.authService.signJwt();
  }

  /** Creates an opaque, revocable server-side session for a local account. */
  @Public()
  @Post('local-login')
  @HttpCode(HttpStatus.OK)
  async localLogin(
    @Body() body: { username?: unknown; password?: unknown },
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    this.requireSameOrigin(request);
    const session = await this.localAuth.login(
      body?.username,
      body?.password,
      request.headers['user-agent'],
    );
    reply.header(
      'set-cookie',
      this.localAuth.cookie(session, this.secureCookie(request)),
    );
    return { expiresAt: session.expiresAt };
  }

  /** Native OIDC or a fronting SSO proxy can complete the same bounded flow. */
  @Public()
  @Get('session/renew')
  async silentRenewal(
    @Query('request') value: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const id = renewalRequest(value);
    reply.header('Cache-Control', 'no-store');
    const source = request.headers['x-webui-auth-source'];
    const bearer = request.headers.authorization?.replace(/^Bearer /i, '');
    if (isSsoProxySource(source) && this.authService.validateApiKey(bearer)) {
      // Legacy ingress calls this source "authentik"; the contract works with
      // any proxy that verifies SSO and overwrites these trusted headers.
      sendRenewalPage(reply, id, 'complete');
      return;
    }
    // Only our own frame may initiate native silent login. An IdP return uses
    // the separately state/nonce/PKCE-checked callback, never this entry point.
    if (request.headers['sec-fetch-site'] !== 'same-origin')
      throw new ForbiddenException('Same-origin renewal required');
    if (!this.authConfig.get().oidc.enabled) {
      sendRenewalPage(reply, id, 'interactive');
      return;
    }
    const start = await this.oidcAuth.start(
      `${silentReturnPath}?request=${id}`,
      this.secureCookie(request),
      true,
    );
    reply.header('set-cookie', start.cookie);
    reply
      .code(HttpStatus.FOUND)
      .header('location', start.authorizationUrl)
      .send();
  }

  @Public()
  @Get('session/renew/complete')
  silentRenewalComplete(
    @Query('request') value: unknown,
    @Query('outcome') outcome: unknown,
    @Res() reply: FastifyReply,
  ): void {
    sendRenewalPage(
      reply,
      renewalRequest(value),
      outcome === 'interactive'
        ? 'interactive'
        : outcome === 'unavailable'
          ? 'unavailable'
          : 'complete',
    );
  }

  @Public()
  @Get('oidc/start')
  async oidcStart(
    @Query('returnTo') returnTo: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const start = await this.oidcAuth.start(
      returnTo,
      this.secureCookie(request),
    );
    reply.header('set-cookie', start.cookie);
    reply
      .code(HttpStatus.FOUND)
      .header('location', start.authorizationUrl)
      .send();
  }

  @Public()
  @Get('oidc/callback')
  async oidcCallback(
    @Query() query: Record<string, unknown>,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const secure = this.secureCookie(request);
    try {
      const result = await this.oidcAuth.callback(
        query,
        request.headers.cookie,
        request.headers['user-agent'],
      );
      reply.header('set-cookie', [
        this.localAuth.cookie(result.session, secure),
        this.oidcAuth.clearFlowCookie(secure, query.state),
      ]);
      reply.code(HttpStatus.FOUND).header('location', result.returnTo).send();
    } catch (error) {
      reply.header(
        'set-cookie',
        this.oidcAuth.clearFlowCookie(secure, query.state),
      );
      if (error instanceof SilentOidcFailure) {
        reply
          .code(HttpStatus.FOUND)
          .header(
            'location',
            `${error.returnTo}&outcome=${error.interactive ? 'interactive' : 'unavailable'}`,
          )
          .send();
        return;
      }
      throw error;
    }
  }

  /** Revoke the local session, then clear the authentication cookie. */
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Logout the current WebUI session' })
  @ApiNoContentResponse()
  logout(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): void {
    this.localAuth.logout(request.headers.cookie);
    reply.header(
      'set-cookie',
      this.localAuth.clearCookie(this.secureCookie(request)),
    );
  }

  private secureCookie(request: FastifyRequest): boolean {
    const forwarded = request.headers['x-forwarded-proto'];
    const protocol = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    return (
      protocol?.split(',')[0].trim() === 'https' ||
      process.env.NODE_ENV === 'production'
    );
  }

  private requireSameOrigin(request: FastifyRequest): void {
    const originValue = request.headers.origin;
    const hostValue =
      request.headers['x-forwarded-host'] ?? request.headers.host;
    const origin: unknown = Array.isArray(originValue)
      ? (originValue as unknown[])[0]
      : originValue;
    const host: unknown = Array.isArray(hostValue)
      ? (hostValue as unknown[])[0]
      : hostValue;
    if (typeof origin !== 'string' || typeof host !== 'string')
      throw BusinessException.unauthorized(
        ErrorCode.auth.invalidToken,
        'Missing origin for local login',
      );
    try {
      if (new URL(origin).host !== host.split(',')[0].trim())
        throw new Error('Cross-origin request');
    } catch {
      throw BusinessException.unauthorized(
        ErrorCode.auth.invalidToken,
        'Cross-origin local login rejected',
      );
    }
  }
}
