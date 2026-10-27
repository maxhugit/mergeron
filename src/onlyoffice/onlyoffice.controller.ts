/**
 * OnlyOffice Docs integration: editor config generation with JWT signing,
 * and save callback endpoint for writing edits back to workspace files.
 */
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Logger,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { BusinessException } from '../common/business.exception';
import { ErrorCode } from '../common/error-codes';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import { sign, verify } from 'jsonwebtoken';
import { ApiErrorResponseDto } from '../common/dto/api-responses.dto';
import { FilesService } from '../files/files.service';
import { AuthService } from '../auth/auth.service';
import type { IdentityRequest } from '../auth/platform-access.guard';
import { IdentityService } from '../auth/identity.service';
import { DeliverablesService } from '../deliverables/deliverables.service';
import { Public } from '../auth/public.decorator';
import { GENERAL_SETTING_KEYS } from '../settings/settings.definitions';
import { SettingsService } from '../settings/settings.service';
import {
  OnlyOfficeCallbackDto,
  OnlyOfficeConfigResponseDto,
} from './dto/onlyoffice.dto';

type OnlyOfficeDocumentType = 'word' | 'cell' | 'slide';

interface OnlyOfficeEditorConfig {
  document: {
    fileType: string;
    key: string;
    permissions: Record<string, boolean>;
    title: string;
    url: string;
  };
  documentType: OnlyOfficeDocumentType;
  editorConfig: {
    callbackUrl: string;
    lang: string;
    mode: 'edit' | 'view';
    customization: Record<string, boolean>;
    embedded?: { autostart: 'document'; toolbarDocked: 'top' };
    user: {
      id: string;
      name: string;
    };
  };
  height: string;
  token?: string;
  type: 'desktop' | 'embedded';
  width: string;
}

/** Timeout for downloading saved document from OnlyOffice server (60s). */
const SAVE_TIMEOUT_MS = 60_000;

@ApiTags('onlyoffice')
@Controller('onlyoffice')
export class OnlyOfficeController {
  private readonly logger = new Logger(OnlyOfficeController.name);

  constructor(
    private readonly filesService: FilesService,
    private readonly settingsService: SettingsService,
    private readonly authService: AuthService,
    private readonly identities: IdentityService,
    private readonly deliverables: DeliverablesService,
  ) {}

  // ── Config endpoint ─────────────────────────────────────────────────

  /**
   * Builds an OnlyOffice editor config for a workspace document.
   * Edit mode (default) requires `general.onlyofficeJwtSecret` to be configured
   * so the save callback can be securely verified.
   */
  @Get('config')
  @ApiBearerAuth()
  @ApiUnauthorizedResponse({ type: ApiErrorResponseDto })
  @ApiBadRequestResponse({ type: ApiErrorResponseDto })
  @ApiOperation({ summary: 'Build OnlyOffice editor config for a file' })
  @ApiQuery({ name: 'path', required: true })
  @ApiQuery({ name: 'mode', required: false, enum: ['edit', 'view'] })
  @ApiOkResponse({ type: OnlyOfficeConfigResponseDto })
  async getConfig(
    @Query('path') filePath: string,
    @Query('mode') mode?: string,
    @Req() request?: FastifyRequest & IdentityRequest,
  ): Promise<OnlyOfficeConfigResponseDto> {
    const onlyofficeUrl = this.requireOnlyOfficeUrl();
    const normalizedUrl = this.normalizeHttpBaseUrl(
      onlyofficeUrl,
      'general.onlyofficeUrl',
    );
    const secret = this.settingsService.getStringSetting(
      GENERAL_SETTING_KEYS.onlyofficeJwtSecret,
    );
    const requestedMode = mode === 'view' ? 'view' : 'edit';

    // Edit mode requires JWT secret for secure save callback verification
    if (requestedMode === 'edit' && !secret) {
      throw BusinessException.badRequest(
        ErrorCode.onlyoffice.jwtRequired,
        'OnlyOffice edit mode requires general.onlyofficeJwtSecret to be configured',
      );
    }

    const metadata = await this.filesService.getMetadata(filePath);
    if (metadata.type !== 'file') {
      throw BusinessException.badRequest(
        ErrorCode.onlyoffice.fileRequired,
        'OnlyOffice requires a file path',
      );
    }

    const fileType = this.getSupportedFileType(metadata.name);
    const deliverableAccess = this.deliverables.onlyOfficeAccess(metadata.path);
    const editorMode =
      requestedMode === 'view' || deliverableAccess?.editable === false
        ? 'view'
        : 'edit';
    const documentType = this.getDocumentType(fileType);
    const documentKey = this.buildDocumentKey(
      metadata.path,
      metadata.mtime,
      metadata.size,
    );
    const baseUrl = this.resolveBaseUrl(request);
    const accessSessionId = this.authService.createDocumentSession(
      metadata.path,
      editorMode === 'edit',
    );
    const documentUrl = this.buildDocumentUrl(
      baseUrl,
      metadata.path,
      accessSessionId,
    );
    const callbackUrl = this.buildCallbackUrl(
      baseUrl,
      metadata.path,
      documentKey,
      secret,
      accessSessionId,
    );
    const identity = request?.platformIdentity;
    const userName = [identity?.firstName, identity?.lastName]
      .map((part) => part?.trim())
      .filter(Boolean)
      .join(' ');

    const config: OnlyOfficeEditorConfig = {
      type: editorMode === 'view' ? 'embedded' : 'desktop',
      width: '100%',
      height: '100%',
      documentType,
      document: {
        fileType,
        key: documentKey,
        title: metadata.name,
        url: documentUrl,
        permissions: {
          comment: editorMode === 'edit',
          copy: true,
          download: requestedMode !== 'view',
          edit: editorMode === 'edit',
          print: requestedMode !== 'view',
          review: false,
          fillForms: editorMode === 'edit',
        },
      },
      editorConfig: {
        callbackUrl,
        lang: this.normalizeEditorLanguage(identity?.language),
        mode: editorMode,
        ...(editorMode === 'view'
          ? {
              embedded: {
                autostart: 'document' as const,
                toolbarDocked: 'top' as const,
              },
            }
          : {}),
        user: {
          id: identity?.personId ?? 'service',
          name: userName || identity?.name?.trim() || 'Utilisateur',
        },
        customization: {
          compactToolbar: true,
          forcesave: editorMode === 'edit',
          hideRightMenu: editorMode === 'view',
          ...(editorMode === 'view'
            ? { comments: false, chat: false, plugins: false, help: false }
            : {}),
        },
      },
    };

    if (secret) {
      config.token = sign(config, secret, { algorithm: 'HS256' });
    }

    return {
      scriptUrl: this.joinUrl(
        normalizedUrl,
        '/web-apps/apps/api/documents/api.js',
      ),
      config: config as unknown as Record<string, unknown>,
    };
  }

  /** OnlyOffice accepts ISO language tags; profiles currently store a base language. */
  private normalizeEditorLanguage(language: string | undefined): string {
    const normalized = language?.trim().toLowerCase();
    return normalized && /^[a-z]{2,3}$/.test(normalized) ? normalized : 'en';
  }

  @Get('history')
  async getHistory(@Query('path') filePath: string) {
    await this.filesService.getMetadata(filePath);
    const history = this.deliverables.onlyOfficeHistory(filePath);
    if (!history) return { currentVersion: 0, history: [] };
    return {
      currentVersion: history.document.currentVersionNumber,
      history: history.versions.map((version) => ({
        version: version.number,
        key: this.versionKey(version),
        created: new Date(version.createdAt).toISOString(),
        user: {
          id: version.authorPersonId ?? 'service',
          name: version.authorName,
        },
        ...(version.onlyofficeChanges
          ? { changes: version.onlyofficeChanges }
          : {}),
        ...(version.onlyofficeServerVersion
          ? { serverVersion: version.onlyofficeServerVersion }
          : {}),
      })),
    };
  }

  @Get('history-data')
  async getHistoryData(
    @Query('path') filePath: string,
    @Query('version') rawVersion: string,
    @Req() request?: FastifyRequest,
  ) {
    await this.filesService.getMetadata(filePath);
    const history = this.deliverables.onlyOfficeHistory(filePath);
    const number = Number(rawVersion);
    const version = history?.versions.find((item) => item.number === number);
    if (!history || !version)
      return { error: 'Document version is not available.', version: number };
    const previous = history.versions.find(
      (item) => item.number === number - 1,
    );
    const baseUrl = this.resolveBaseUrl(request);
    const data: Record<string, unknown> = {
      fileType: version.fileName.split('.').pop()?.toLowerCase(),
      key: this.versionKey(version),
      url: this.historyFileUrl(
        baseUrl,
        version.snapshotPath,
        history.document.sourcePath,
      ),
      version: version.number,
      ...(version.onlyofficeChangesPath
        ? {
            changesUrl: this.historyFileUrl(
              baseUrl,
              version.onlyofficeChangesPath,
              history.document.sourcePath,
            ),
          }
        : {}),
      ...(previous
        ? {
            previous: {
              fileType: previous.fileName.split('.').pop()?.toLowerCase(),
              key: this.versionKey(previous),
              url: this.historyFileUrl(
                baseUrl,
                previous.snapshotPath,
                history.document.sourcePath,
              ),
            },
          }
        : {}),
    };
    const secret = this.settingsService.getStringSetting(
      GENERAL_SETTING_KEYS.onlyofficeJwtSecret,
    );
    if (secret) data.token = sign(data, secret, { algorithm: 'HS256' });
    return data;
  }

  @Get('history-file')
  @Public()
  async getHistoryFile(
    @Query('state') state: string,
    @Res() reply: FastifyReply,
  ) {
    const secret = this.settingsService.getStringSetting(
      GENERAL_SETTING_KEYS.onlyofficeJwtSecret,
    );
    if (!secret)
      return reply.status(503).send({ error: 'History unavailable' });
    try {
      const payload = verify(state, secret, { algorithms: ['HS256'] });
      if (
        typeof payload === 'string' ||
        payload.purpose !== 'onlyoffice-history' ||
        typeof payload.path !== 'string'
      )
        throw new Error('Invalid history state');
      const resolved = await fs.realpath(payload.path);
      if (resolved !== payload.path) throw new Error('Invalid history path');
      return reply
        .header('Access-Control-Allow-Origin', '*')
        .type('application/octet-stream')
        .send(createReadStream(resolved));
    } catch {
      return reply.status(403).send({ error: 'Invalid history link' });
    }
  }

  private versionKey(version: {
    onlyofficeKey: string | null;
    sha256: string;
    number: number;
  }) {
    return (
      version.onlyofficeKey ??
      `${version.sha256.slice(0, 48)}-${version.number}`
    );
  }

  private historyFileUrl(
    baseUrl: string,
    filePath: string,
    sourcePath: string,
  ) {
    // Use the same Authentik-exempt, path-bound transfer endpoint as the
    // current document. A separate public history endpoint is redirected by
    // the deployment authentication proxy, and OnlyOffice deliberately refuses
    // to forward the signed URL through that 302 response.
    const sessionId = this.authService.createDocumentSession(
      filePath,
      false,
      sourcePath,
    );
    return this.buildDocumentUrl(baseUrl, filePath, sessionId);
  }

  // ── Save callback endpoint ──────────────────────────────────────────

  /**
   * OnlyOffice save callback — receives document status updates from the Document Server.
   * When status=2 (ready to save) or status=6 (force save), downloads the modified file
   * and atomically writes it back to the workspace.
   *
   * Security model (all required for save to proceed):
   * 1. JWT secret must be configured (edit mode enforces this)
   * 2. Callback state token (signed path+key in callbackUrl query) verified
   * 3. OnlyOffice callback JWT (body.token or Authorization header) verified
   * 4. Download URL origin must match configured OnlyOffice server
   * 5. File path validated against workspace roots (resolveSafePath)
   * 6. Atomic write via temp file + rename (no partial corruption)
   * 7. Download size limit + timeout
   */
  @Post('callback')
  @HttpCode(200)
  @Public()
  @ApiOperation({ summary: 'OnlyOffice document save callback' })
  @ApiQuery({
    name: 'path',
    type: String,
    required: true,
    description: 'Workspace file path',
  })
  @ApiQuery({
    name: 'state',
    type: String,
    required: false,
    description: 'Signed callback state token',
  })
  @ApiBody({ type: OnlyOfficeCallbackDto })
  @ApiOkResponse({
    description: 'Acknowledged',
    schema: { properties: { error: { type: 'number' } } },
  })
  async handleCallback(
    @Query('path') filePath: string,
    @Query('state') stateToken: string | undefined,
    @Body() body: OnlyOfficeCallbackDto,
    @Req() request: FastifyRequest,
  ): Promise<{ error: number }> {
    if (!filePath) {
      this.logger.warn('OnlyOffice callback missing file path');
      return { error: 1 };
    }
    let callbackTrusted = false;
    try {
      // 1. Require JWT secret
      const secret = this.settingsService.getStringSetting(
        GENERAL_SETTING_KEYS.onlyofficeJwtSecret,
      );
      if (!secret) {
        this.logger.warn(
          { path: filePath },
          'Rejected OnlyOffice callback: JWT secret not configured',
        );
        return { error: 1 };
      }

      // 2. Verify callback state token (signed path + key)
      const state = this.verifyCallbackState(stateToken, secret);
      const documentSession = this.authService.getDocumentSession(
        state.accessSessionId,
        filePath,
        true,
      );
      if (!documentSession) return { error: 1 };
      if (state.path !== filePath) {
        this.logger.warn(
          { path: filePath, statePath: state.path },
          'OnlyOffice callback path mismatch',
        );
        return { error: 1 };
      }
      if (body.key && state.key !== body.key) {
        this.logger.warn(
          { path: filePath, key: body.key, stateKey: state.key },
          'OnlyOffice callback key mismatch',
        );
        return { error: 1 };
      }

      // 3. Verify OnlyOffice callback JWT (body.token or Authorization header)
      this.verifyOnlyOfficeToken(body, request, secret);
      callbackTrusted = true;

      if (body.status === 1) {
        this.deliverables.updateOnlyOfficeSession(filePath, 'editing');
        return { error: 0 };
      }
      if (body.status === 4) {
        this.deliverables.updateOnlyOfficeSession(filePath, 'saved');
        return { error: 0 };
      }
      if (body.status === 7) {
        this.deliverables.updateOnlyOfficeSession(filePath, 'error');
        return { error: 0 };
      }
      if (body.status !== 2 && body.status !== 6) return { error: 0 };

      this.deliverables.updateOnlyOfficeSession(filePath, 'saving');
      if (!body.url)
        throw new Error('OnlyOffice save callback missing download URL');

      // 4. Validate download URL origin matches configured OnlyOffice server
      const downloadUrl = this.validateDownloadUrl(body.url);

      // 5. Validate file path against workspace roots
      const resolved = await this.filesService.resolveSafePath(filePath);

      // 6. Download with timeout + size limit, write atomically
      const maxBytes = this.settingsService.getNumberSetting(
        GENERAL_SETTING_KEYS.onlyofficeSaveMaxBytes,
      );
      const response = await this.fetchWithTimeout(downloadUrl);
      if (!response.ok || !response.body) {
        throw new Error(
          `Failed to download from OnlyOffice (${response.status})`,
        );
      }

      await this.writeAtomically(response, resolved, maxBytes);
      if (body.status === 2 || body.status === 6) {
        const saved = await fs.stat(resolved);
        const person = documentSession.personId
          ? this.identities.resolvePerson(documentSession.personId)
          : null;
        const created = await this.deliverables.captureOnlyOfficeVersion(
          resolved,
          {
            personId: person?.personId ?? null,
            name: person?.name ?? 'OnlyOffice',
          },
          {
            key: this.buildDocumentKey(resolved, saved.mtimeMs, saved.size),
            changes: body.history?.changes,
            serverVersion: body.history?.serverVersion,
          },
        );
        if (created && body.changesurl) {
          try {
            const changesUrl = this.validateDownloadUrl(body.changesurl);
            const changesResponse = await this.fetchWithTimeout(changesUrl);
            if (!changesResponse.ok || !changesResponse.body)
              throw new Error(
                `OnlyOffice changes download failed (${changesResponse.status})`,
              );
            const changesPath = join(
              dirname(created.version.snapshotPath),
              'changes.zip',
            );
            await this.writeAtomically(changesResponse, changesPath, maxBytes);
            this.deliverables.attachOnlyOfficeChanges(
              created.version.id,
              changesPath,
            );
          } catch (error) {
            this.logger.warn(
              {
                path: filePath,
                error: error instanceof Error ? error.message : String(error),
              },
              'OnlyOffice changes archive could not be preserved',
            );
          }
        }
      }
      this.logger.log(
        { path: filePath, status: body.status },
        'OnlyOffice document saved',
      );
      this.deliverables.updateOnlyOfficeSession(
        filePath,
        body.status === 6 ? 'editing' : 'saved',
      );
      return { error: 0 };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(
        { path: filePath, error: msg },
        'OnlyOffice callback failed',
      );
      if (callbackTrusted)
        this.deliverables.updateOnlyOfficeSession(filePath, 'error');
      return { error: 1 };
    }
  }

  // ── Callback security helpers ───────────────────────────────────────

  /** Verifies the signed state token embedded in the callbackUrl query param. */
  private verifyCallbackState(
    stateToken: string | undefined,
    secret: string,
  ): { path: string; key: string; accessSessionId: unknown } {
    if (!stateToken) {
      throw BusinessException.badRequest(
        ErrorCode.onlyoffice.missingCallbackState,
        'Missing OnlyOffice callback state token',
      );
    }
    const payload = verify(stateToken, secret, { algorithms: ['HS256'] });
    if (!payload || typeof payload !== 'object') {
      throw BusinessException.badRequest(
        ErrorCode.onlyoffice.invalidCallbackState,
        'Invalid OnlyOffice callback state token',
      );
    }
    const record = payload as Record<string, unknown>;
    if (typeof record.path !== 'string' || typeof record.key !== 'string') {
      throw BusinessException.badRequest(
        ErrorCode.onlyoffice.invalidCallbackStatePayload,
        'Invalid OnlyOffice callback state token payload',
      );
    }
    return {
      path: record.path,
      key: record.key,
      accessSessionId: record.accessSessionId,
    };
  }

  /** Verifies the OnlyOffice outgoing callback JWT (body.token or Authorization header). */
  private verifyOnlyOfficeToken(
    body: OnlyOfficeCallbackDto,
    request: FastifyRequest,
    secret: string,
  ): void {
    const token =
      body.token ?? this.extractBearerToken(request.headers.authorization);
    if (!token) {
      throw BusinessException.badRequest(
        ErrorCode.onlyoffice.missingCallbackJwt,
        'Missing OnlyOffice callback JWT',
      );
    }
    const payload = verify(token, secret, { algorithms: ['HS256'] });
    if (!payload || typeof payload !== 'object') {
      throw BusinessException.badRequest(
        ErrorCode.onlyoffice.invalidCallbackJwt,
        'Invalid OnlyOffice callback JWT',
      );
    }
  }

  /** Validates the download URL against the configured OnlyOffice origin to prevent SSRF. */
  private validateDownloadUrl(rawUrl: string): URL {
    let downloadUrl: URL;
    try {
      downloadUrl = new URL(rawUrl);
    } catch {
      throw BusinessException.badRequest(
        ErrorCode.onlyoffice.invalidDownloadUrl,
        'Invalid OnlyOffice download URL',
      );
    }
    if (downloadUrl.protocol !== 'http:' && downloadUrl.protocol !== 'https:') {
      throw BusinessException.badRequest(
        ErrorCode.onlyoffice.downloadUrlNotHttps,
        'OnlyOffice download URL must use HTTP(S)',
      );
    }
    // Origin must match the configured OnlyOffice server
    const onlyofficeUrl = this.requireOnlyOfficeUrl();
    const allowedOrigin = new URL(
      this.normalizeHttpBaseUrl(onlyofficeUrl, 'general.onlyofficeUrl'),
    ).origin;
    if (downloadUrl.origin !== allowedOrigin) {
      throw BusinessException.badRequest(
        ErrorCode.onlyoffice.downloadUrlOriginMismatch,
        'OnlyOffice download URL origin does not match configured server',
      );
    }
    return downloadUrl;
  }

  // ── Atomic save helpers ─────────────────────────────────────────────

  /** Downloads from OnlyOffice with a timeout. */
  private async fetchWithTimeout(url: URL): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), SAVE_TIMEOUT_MS);
    try {
      return await fetch(url, { signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Writes response body to a temp file then atomically renames to target, with size limit. */
  private async writeAtomically(
    response: Response,
    targetPath: string,
    maxBytes: number,
  ): Promise<void> {
    const contentLength = response.headers.get('content-length');
    if (contentLength && Number(contentLength) > maxBytes) {
      throw BusinessException.payloadTooLarge(
        ErrorCode.onlyoffice.saveTooLarge,
        'OnlyOffice save payload exceeds size limit',
      );
    }
    if (!response.body) {
      throw BusinessException.badRequest(
        ErrorCode.onlyoffice.saveNoBody,
        'OnlyOffice save response has no body',
      );
    }

    const tmpPath = join(
      dirname(targetPath),
      `.onlyoffice-${randomUUID()}.tmp`,
    );
    const nodeStream = Readable.fromWeb(
      response.body as import('node:stream/web').ReadableStream,
    );

    try {
      await pipeline(
        nodeStream,
        this.createByteLimitTransform(maxBytes),
        createWriteStream(tmpPath, { flags: 'wx' }),
      );
      await fs.rename(tmpPath, targetPath);
    } catch (error) {
      await fs.unlink(tmpPath).catch(() => undefined);
      throw error;
    }
  }

  /** Creates a Transform stream that enforces the given save size limit. */
  private createByteLimitTransform(maxBytes: number): Transform {
    let totalBytes = 0;
    return new Transform({
      transform(
        chunk: Buffer,
        _encoding: BufferEncoding,
        callback: (error?: Error | null, data?: Buffer) => void,
      ) {
        totalBytes += chunk.length;
        if (totalBytes > maxBytes) {
          callback(
            BusinessException.payloadTooLarge(
              ErrorCode.onlyoffice.saveTooLarge,
              'OnlyOffice save payload exceeds size limit',
            ),
          );
          return;
        }
        callback(null, chunk);
      },
    });
  }

  // ── Config helpers ──────────────────────────────────────────────────

  /** Returns the configured OnlyOffice URL or throws. */
  private requireOnlyOfficeUrl(): string {
    const url = this.settingsService.getStringSetting(
      GENERAL_SETTING_KEYS.onlyofficeUrl,
    );
    if (!url) {
      throw BusinessException.badRequest(
        ErrorCode.onlyoffice.notConfigured,
        'OnlyOffice is not configured',
      );
    }
    return url;
  }

  /** Validates supported Office extensions and returns the lowercase file type. */
  private getSupportedFileType(filename: string): string {
    const ext = filename.split('.').pop()?.toLowerCase() ?? '';
    if (ext === 'docx' || ext === 'xlsx' || ext === 'pptx') return ext;
    throw BusinessException.badRequest(
      ErrorCode.onlyoffice.unsupportedFormat,
      'OnlyOffice supports DOCX, XLSX, and PPTX files',
    );
  }

  /** Maps a supported extension to OnlyOffice's documentType field. */
  private getDocumentType(fileType: string): OnlyOfficeDocumentType {
    if (fileType === 'docx') return 'word';
    if (fileType === 'xlsx') return 'cell';
    return 'slide';
  }

  /** Builds a stable cache key within OnlyOffice's 128-character limit. */
  private buildDocumentKey(
    filePath: string,
    mtime: number,
    size: number,
  ): string {
    return createHash('sha256')
      .update(`${filePath}:${mtime}:${size}`)
      .digest('hex')
      .slice(0, 48);
  }

  /** Resolves the public base URL from setting or request headers. */
  private resolveBaseUrl(request?: FastifyRequest): string {
    const publicBaseUrl = this.settingsService.getStringSetting(
      GENERAL_SETTING_KEYS.publicBaseUrl,
    );
    if (publicBaseUrl) {
      return this.normalizeHttpBaseUrl(publicBaseUrl, 'general.publicBaseUrl');
    }
    if (!request) {
      throw BusinessException.badRequest(
        ErrorCode.onlyoffice.publicHostRequired,
        'Cannot determine public host. Configure general.publicBaseUrl in Settings.',
      );
    }
    const proto =
      this.firstHeaderValue(request.headers['x-forwarded-proto']) ?? 'http';
    const host =
      this.firstHeaderValue(request.headers['x-forwarded-host']) ??
      this.firstHeaderValue(request.headers.host);
    if (!host) {
      throw BusinessException.badRequest(
        ErrorCode.onlyoffice.publicHostRequired,
        'Cannot determine public host for OnlyOffice. Configure general.publicBaseUrl in Settings.',
      );
    }
    return this.normalizeHttpBaseUrl(
      `${proto}://${host}`,
      'request host headers',
    );
  }

  /** Builds an absolute file-serving URL reachable by the OnlyOffice Document Server. */
  private buildDocumentUrl(
    baseUrl: string,
    filePath: string,
    sessionId: string,
  ): string {
    const params = new URLSearchParams({ path: filePath });
    // Never disclose the deployment credential in the editor config/browser.
    params.set(
      'access_token',
      this.authService.signFileAccess(filePath, sessionId),
    );
    return this.joinUrl(baseUrl, `/api/files/serve?${params.toString()}`);
  }

  /** Builds the callback URL with a signed state token encoding path + document key. */
  private buildCallbackUrl(
    baseUrl: string,
    filePath: string,
    documentKey: string,
    secret: string | null,
    accessSessionId: string,
  ): string {
    const params = new URLSearchParams({ path: filePath });
    if (secret) {
      params.set(
        'state',
        sign({ path: filePath, key: documentKey, accessSessionId }, secret, {
          algorithm: 'HS256',
          expiresIn: '24h',
        }),
      );
    }
    return this.joinUrl(
      baseUrl,
      `/api/onlyoffice/callback?${params.toString()}`,
    );
  }

  // ── URL/header helpers ──────────────────────────────────────────────

  /** Extracts the first comma-delimited proxy header value. */
  private firstHeaderValue(
    value: string | string[] | undefined,
  ): string | null {
    const raw = this.singleHeader(value);
    return raw?.split(',')[0]?.trim() || null;
  }

  /** Extracts a scalar header value from Fastify's string-or-array header shape. */
  private singleHeader(value: string | string[] | undefined): string | null {
    if (Array.isArray(value)) return value[0] ?? null;
    return value ?? null;
  }

  /** Normalizes configured/inferred URLs and rejects non-http(s) schemes. */
  private normalizeHttpBaseUrl(rawUrl: string, label: string): string {
    try {
      const url = new URL(rawUrl);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error('unsupported protocol');
      }
      url.search = '';
      url.hash = '';
      return url.toString().replace(/\/+$/, '');
    } catch {
      throw BusinessException.badRequest(
        ErrorCode.onlyoffice.invalidUrl,
        `${label} must be a valid http(s) URL`,
        { label },
      );
    }
  }

  /** Extracts a bearer token from Authorization header. */
  private extractBearerToken(authorization: string | undefined): string | null {
    const match = /^Bearer\s+(.+)$/i.exec(authorization ?? '');
    return match?.[1] ?? null;
  }

  /** Joins a base URL and path without double slashes. */
  private joinUrl(baseUrl: string, path: string): string {
    return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
  }
}
