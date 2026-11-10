import type { PreviewProfile } from '../../runtime/preview-profile.cjs';

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
