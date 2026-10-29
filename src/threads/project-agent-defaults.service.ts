import { Injectable } from '@nestjs/common';
import { CodexService } from '../codex/codex.service';
import type { v2 } from '../codex/codex-schema';
import { SettingsService } from '../settings/settings.service';
import { SECURITY_SETTING_KEYS } from '../settings/settings.definitions';
import type { ProjectExecutionPolicy } from './project-connection-policy.service';
import { filteredTestNetworkAvailable } from './agent-test-profile';

/** Global starting defaults, never a policy rewrite on an existing conversation. */
@Injectable()
export class ProjectAgentDefaultsService {
  constructor(
    private readonly codex: CodexService,
    private readonly settings: SettingsService,
  ) {}

  async forNewAgent(
    params: v2.ThreadStartParams,
    project: ProjectExecutionPolicy | null,
  ): Promise<v2.ThreadStartParams> {
    if (
      !project ||
      project.readOnly !== false ||
      params.sandbox != null ||
      this.settings.getSetting(SECURITY_SETTING_KEYS.projectAgentTestProfile)
        .value !== true
    )
      return {};
    // Explicit profile/config choices are authority, not gaps to "repair".
    const raw = params as v2.ThreadStartParams & { permissions?: unknown };
    const config = params.config ?? {};
    if (
      raw.permissions != null ||
      Object.keys(config).some((key) =>
        [
          'sandbox_mode',
          'sandbox_workspace_write',
          'permissions',
          'default_permissions',
          'profile',
        ].some((prefix) => key === prefix || key.startsWith(prefix + '.')),
      )
    )
      return {};
    try {
      const response = await this.codex.request<unknown>(
        'configRequirements/read',
        {},
      );
      if (
        this.settings.getSetting(SECURITY_SETTING_KEYS.projectAgentTestProfile)
          .value !== true
      )
        return {};
      if (!filteredTestNetworkAvailable(response)) return {};
      const { requirements } = response as {
        requirements: Record<string, unknown>;
      };
      if (
        requirements.allowedPermissionProfiles != null ||
        requirements.defaultPermissions != null
      )
        return {};
      if (
        requirements.allowedSandboxModes != null &&
        (!Array.isArray(requirements.allowedSandboxModes) ||
          !requirements.allowedSandboxModes.includes('workspace-write'))
      )
        return {};
      const effective = await this.codex.request<v2.ConfigReadResponse>(
        'config/read',
        { cwd: params.cwd, includeLayers: false },
      );
      // Selecting the legacy sandbox must not bypass a named permission profile.
      if (
        !effective.config ||
        effective.config.sandbox_mode === 'read-only' ||
        effective.config.default_permissions != null ||
        effective.config.profile != null
      )
        return {};
      if (
        this.settings.getSetting(SECURITY_SETTING_KEYS.projectAgentTestProfile)
          .value !== true
      )
        return {};
      const workspace = effective.config.sandbox_workspace_write;
      const inherited =
        workspace && typeof workspace === 'object' && !Array.isArray(workspace)
          ? workspace
          : {};
      return {
        sandbox: 'workspace-write',
        config: {
          sandbox_workspace_write: { ...inherited, network_access: true },
        },
      };
    } catch {
      // An unavailable/old engine is not proof of a safe network. Keep its defaults.
      return {};
    }
  }
}
