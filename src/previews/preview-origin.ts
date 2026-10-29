/** Fail closed if an old ingress template sends preview hosts to the SPA. */
export function isPreviewHost(host: unknown, domain: string | undefined) {
  if (typeof host !== 'string' || !domain || domain === 'preview.invalid')
    return false;
  try {
    const name = new URL('http://' + host).hostname
      .toLowerCase()
      .replace(/\.$/, '');
    return name === domain || name.endsWith('.' + domain);
  } catch {
    return true;
  }
}
