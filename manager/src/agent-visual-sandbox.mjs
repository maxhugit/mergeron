/**
 * Opt-in DEV migration for images shipping local visual tests. Chromium needs
 * chroot after entering its own user namespace. Docker's capability-gated rule
 * is absent with CapDrop=ALL, even though the child has namespace-local caps.
 * Preserve every other restriction and never enable this on production stacks.
 */
export function agentVisualSandbox(host, { environment, component, labels }) {
  if (
    environment !== 'development' ||
    component !== 'application' ||
    labels?.['io.mergeron.agent-visual-testing'] !== '1'
  )
    return host;
  if (
    host.Privileged ||
    !host.ReadonlyRootfs ||
    !host.CapDrop?.includes('ALL') ||
    host.CapAdd?.length
  ) {
    throw new Error('updateAgentSandboxIsolationRequired');
  }
  const index =
    host.SecurityOpt?.findIndex((option) => option.startsWith('seccomp=')) ??
    -1;
  let profile;
  try {
    profile = JSON.parse(host.SecurityOpt[index].slice('seccomp='.length));
  } catch {
    throw new Error('updateAgentSandboxProfileRequired');
  }
  if (
    profile.defaultAction !== 'SCMP_ACT_ERRNO' ||
    !Array.isArray(profile.syscalls)
  )
    throw new Error('updateAgentSandboxProfileRequired');
  const unconditional = (rule) =>
    rule.action === 'SCMP_ACT_ALLOW' &&
    !rule.args?.length &&
    !Object.keys(rule.includes ?? {}).length &&
    !Object.keys(rule.excludes ?? {}).length;
  for (const syscall of ['clone', 'unshare', 'setns']) {
    if (
      !profile.syscalls.some(
        (rule) => rule.names?.includes(syscall) && unconditional(rule),
      )
    )
      throw new Error('updateAgentSandboxNamespacesRequired');
  }
  // Never override a deliberate custom denial.
  if (
    profile.syscalls.some(
      (rule) =>
        rule.names?.includes('chroot') && rule.action !== 'SCMP_ACT_ALLOW',
    )
  )
    throw new Error('updateAgentSandboxChrootDenied');
  if (
    profile.syscalls.some(
      (rule) => rule.names?.includes('chroot') && unconditional(rule),
    )
  )
    return host;
  profile.syscalls.push({
    names: ['chroot'],
    action: 'SCMP_ACT_ALLOW',
    comment:
      'Chromium sandbox: kernel still requires namespace-local CAP_SYS_CHROOT',
  });
  const SecurityOpt = [...host.SecurityOpt];
  SecurityOpt[index] = `seccomp=${JSON.stringify(profile)}`;
  return { ...host, SecurityOpt };
}
