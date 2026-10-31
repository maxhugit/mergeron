import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from './public.decorator';
import {
  IdentityService,
  type IdentityHeaders,
  type PlatformIdentity,
} from './identity.service';
import { AuthService } from './auth.service';

export interface IdentityRequest {
  headers: IdentityHeaders;
  platformIdentity?: PlatformIdentity;
  authenticatedPersonId?: string;
  method: string;
  url: string;
  query?: Record<string, unknown>;
  body?: Record<string, unknown>;
  params?: Record<string, unknown>;
}

@Injectable()
export class PlatformAccessGuard implements CanActivate {
  constructor(
    private readonly identities: IdentityService,
    private readonly reflector: Reflector,
    private readonly auth: AuthService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    if (
      this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
        context.getHandler(),
        context.getClass(),
      ])
    )
      return true;
    if (context.getType() === 'ws') {
      const socket = context.switchToWs().getClient<{
        handshake: { headers: IdentityHeaders };
        data?: { authenticatedPersonId?: unknown };
      }>();
      const authenticatedPersonId = socket.data?.authenticatedPersonId;
      const identity = this.identities.resolve(
        socket.handshake.headers,
        typeof authenticatedPersonId === 'string'
          ? authenticatedPersonId
          : undefined,
      );
      if (identity.impersonation)
        this.identities.auditImpersonation(
          identity.impersonation,
          'socketAttempt',
          'WS',
          context.switchToWs().getPattern(),
        );
      this.identities.requireActive(identity);
      if (identity.role === 'administrator') return true;
      const data =
        context.switchToWs().getData<Record<string, unknown>>() ?? {};
      const event = context.switchToWs().getPattern();
      // A cwd is not a sandbox: conversation shells can change directory too.
      // Reserve server execution until per-user OS isolation exists.
      if (event?.startsWith('terminal.') || event === 'codex.serverResponse')
        this.identities.requireAdministrator(identity);
      if (event === 'thread.subscribe') {
        if (typeof data.threadId !== 'string') return false;
        this.identities.requireThread(identity, data.threadId);
      }
      if (event === 'fs.watch.acquire')
        this.identities.requireWorkspacePath(data.path, false, identity);
      return true;
    }
    const request = context.switchToHttp().getRequest<IdentityRequest>();
    const url = request.url.split('?')[0].replace(/^\/api(?=\/)/, '');
    // Deployment health checks still require the ApiKeyGuard, but not a human.
    if (url === '/status' && request.method === 'GET') return true;
    // Authentik-exempt document transfers must carry a short-lived, path-bound token.
    if (request.headers['x-webui-auth-source'] === 'document') {
      return (
        url === '/files/serve' &&
        this.auth.verifyFileAccess(
          request.query?.access_token,
          request.query?.path,
        )
      );
    }
    const control = url === '/auth/impersonation';
    const identity = control
      ? this.identities.resolveOriginal(
          request.headers,
          request.authenticatedPersonId,
        )
      : this.identities.resolve(request.headers, request.authenticatedPersonId);
    request.platformIdentity = identity;
    if (control && request.method === 'DELETE') return true;
    if (
      identity.impersonation &&
      !['GET', 'HEAD', 'OPTIONS'].includes(request.method)
    )
      this.identities.auditImpersonation(
        identity.impersonation,
        'httpAttempt',
        request.method,
        url,
      );
    if (url === '/auth/me') return true;
    this.identities.requireActive(identity);
    if (identity.role === 'administrator') return true;
    const projectId = request.params?.projectId ?? request.params?.id;
    if (
      url.startsWith('/projects/') &&
      typeof projectId === 'string' &&
      !/^\/projects\/people(?:\/|$)/.test(url)
    )
      this.identities.requireProject(identity, projectId);
    if (typeof request.body?.projectId === 'string')
      this.identities.requireProject(identity, request.body.projectId);
    if (typeof request.params?.threadId === 'string')
      this.identities.requireThread(
        identity,
        request.params.threadId,
        url.startsWith('/simple-chat/') ? 'simple' : 'agent',
      );
    const ids = request.body?.threadIds ?? request.query?.threadIds;
    if (ids !== undefined) {
      const values =
        typeof ids === 'string' ? ids.split(',').filter(Boolean) : ids;
      if (!Array.isArray(values) || values.some((id) => typeof id !== 'string'))
        return false;
      for (const id of values)
        this.identities.requireThread(identity, id as string);
    }
    const admin =
      (/^\/projects\/[^/]+\/knowledge(?:\/|$)/.test(url) &&
        !(
          request.method === 'GET' && /^\/projects\/[^/]+\/knowledge$/.test(url)
        )) ||
      /^\/(settings|logs|database|mcp-servers|plugins|apps|codex\/config|codex\/catalog|codex\/cli)(\/|$)/.test(
        url,
      ) ||
      (/^\/account(\/|$)/.test(url) &&
        !(request.method === 'GET' && url === '/account/rate-limits')) ||
      (request.method !== 'GET' &&
        /^\/codex\/(approval-policy|sandbox-mode)$/.test(url)) ||
      (request.method !== 'GET' && /^\/skills(\/|$)/.test(url)) ||
      (request.method !== 'GET' && /^\/pending-approvals(\/|$)/.test(url)) ||
      (request.method !== 'GET' &&
        /^\/simple-chat\/(config|settings|models)(\/|$)/.test(url)) ||
      /^\/simple-chat\/(?:api-key|settings|audio-sessions)(\/|$)/.test(url) ||
      /^\/auth\/(?:configuration|local-accounts|sessions|impersonation-audit)(\/|$)/.test(
        url,
      ) ||
      (request.method !== 'GET' && /^\/projects\/people(\/|$)/.test(url)) ||
      (request.method !== 'GET' &&
        /^\/projects\/[^/]+\/participants(?:\/|$)/.test(url)) ||
      (request.method !== 'GET' &&
        /^\/projects\/[^/]+\/(?:mcp-servers|apps|agent-settings|browser-settings|test-environment)$/.test(
          url,
        ));
    const workspaceConnectionMutation =
      request.method !== 'GET' &&
      /^\/projects\/[^/]+\/workspace-resources(?:\/|$)/.test(url);
    if (
      admin ||
      workspaceConnectionMutation ||
      url === '/projects/reconcile-workspaces' ||
      (request.method === 'DELETE' && /^\/projects\/[^/]+$/.test(url))
    )
      this.identities.requireAdministrator(identity);
    if (request.method === 'DELETE') {
      const projectId = url.match(/^\/projects\/([^/]+)$/)?.[1];
      if (projectId)
        this.identities.requireWorkspaceDeletions(
          projectId,
          request.body?.deleteWorkspaceIds,
        );
      if (url.startsWith('/workspaces/')) {
        const name = request.params?.name;
        this.identities.requireWorkspacePath(
          typeof name === 'string' ? `/workspaces/${name}` : undefined,
          false,
          identity,
        );
      }
    }
    if (request.method !== 'GET') {
      const resource = url.match(
        /^\/projects\/[^/]+\/resources\/([^/]+)(?:\/|$)/,
      )?.[1];
      const serverExecution =
        /\/deliverables\/[^/]+\/agent$/.test(url) ||
        /\/(?:ai-plan|ai-replan|ai-advice|ai-subtasks)$/.test(url) ||
        (/^\/projects\/[^/]+\/agents(?:\/|$)/.test(url) &&
          !/^\/projects\/[^/]+\/agents\/[^/]+\/preview\/open$/.test(url)) ||
        (url.startsWith('/threads') && url !== '/threads/turn-counts') ||
        /\/automations(?:\/|$)|\/automation-runs(?:\/|$)/.test(url) ||
        request.body?.type === 'automation_board' ||
        (request.body?.agentState !== undefined &&
          request.body.agentState !== 'manual') ||
        request.body?.executionMode === 'agent' ||
        (resource && this.identities.isAutomationResource(resource));
      if (serverExecution) this.identities.requireAdministrator(identity);
    }
    if (
      request.method !== 'GET' &&
      /^\/(projects|workspaces|threads)(\/|$)/.test(url)
    ) {
      if (Array.isArray(request.body?.paths)) {
        for (const path of request.body.paths)
          this.identities.requireWorkspacePath(path, false, identity);
      }
      for (const key of [
        'path',
        'workspacePath',
        'cwd',
        'oldPath',
        'newPath',
      ]) {
        if (request.body?.[key] !== undefined)
          this.identities.requireWorkspacePath(
            request.body[key],
            url.startsWith('/projects'),
            identity,
          );
      }
    }
    if (/^\/(files|onlyoffice)(\/|$)/.test(url)) {
      for (const source of [request.query, request.body]) {
        for (const key of [
          'path',
          'root',
          'sourcePath',
          'destinationPath',
          'cwd',
        ]) {
          if (source?.[key] !== undefined)
            this.identities.requireWorkspacePath(source[key], false, identity);
        }
      }
    }
    return true;
  }
}
