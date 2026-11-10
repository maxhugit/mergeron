import type { PreviewProfile } from '../../runtime/preview-profile.cjs';

/** Public deployment reason codes; unknown or malformed results fail closed. */
export function previewManagerPrerequisites(
  capabilities: Record<string, unknown> | null,
): string[] {
  // Older Managers omit this additive field. New Managers report only public
  // reason codes: never expose their Docker errors, paths or environment here.
  const reasons: string[] = [];
  const managerReasons = capabilities?.prerequisites;
  if (managerReasons !== undefined) {
    const known = new Set([
      'docker_version_unsupported',
      'manager_docker_unavailable',
      'application_identity_invalid',
      'workspace_mount_invalid',
      'manager_identity_invalid',
      'manager_helper_volumes_unsupported',
      'runtime_image_unsupported',
      'runtime_image_missing',
    ]);
    if (
      !Array.isArray(managerReasons) ||
      managerReasons.some(
        (value: unknown) => typeof value !== 'string' || !known.has(value),
      )
    )
      reasons.push('manager_preflight_failed');
    else reasons.push(...(managerReasons as string[]));
  }
  return reasons;
}

/** Same read-only prerequisite checks for project settings and agent discovery. */
export function previewConfigurationPrerequisites(input: {
  platformEnabled: boolean;
  domain: string | undefined;
  viewerReady: boolean;
  capabilities: Record<string, unknown> | null;
  profile: PreviewProfile | null;
  profileConfigured: boolean;
}) {
  const { platformEnabled, domain, viewerReady, capabilities, profile } = input;
  const reasons: string[] = [];
  if (!platformEnabled) reasons.push('server_disabled');
  if (!domain) reasons.push('preview_domain_missing');
  if (platformEnabled && !viewerReady) reasons.push('viewer_not_ready');
  if (!capabilities) reasons.push('manager_unavailable');
  else {
    if (capabilities.enabled !== true) reasons.push('manager_not_configured');
    if (domain && capabilities.domain !== domain)
      reasons.push('preview_domain_mismatch');
  }
  reasons.push(...previewManagerPrerequisites(capabilities));
  const runtimes = new Set(
    (Array.isArray(capabilities?.runtimes) ? capabilities.runtimes : [])
      .map((value: unknown) =>
        value && typeof value === 'object'
          ? (value as { id?: unknown }).id
          : undefined,
      )
      .filter(
        (id): id is string =>
          typeof id === 'string' && /^[a-z][a-z0-9-]{0,39}$/.test(id),
      ),
  );
  if (!profile)
    reasons.push(
      input.profileConfigured
        ? 'project_profile_unreadable'
        : 'project_profile_missing',
    );
  else {
    if (!profile.enabled) reasons.push('project_disabled');
    if (!profile.agentManaged && !profile.start.trim())
      reasons.push('start_command_missing');
    if (
      profile.agentManaged &&
      capabilities &&
      !profile.agentRuntimes.some((id) => runtimes.has(id))
    )
      reasons.push('agent_runtimes_missing');
    if (!profile.agentManaged && capabilities && !runtimes.has(profile.runtime))
      reasons.push('runtime_not_allowed');
    if (
      capabilities &&
      !profile.agentManaged &&
      profile.services.some((service) => !runtimes.has(service.runtime))
    )
      reasons.push('service_runtime_not_allowed');
  }
  return { reasons, runtimes };
}
