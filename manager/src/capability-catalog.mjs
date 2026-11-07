/** Reviewed, bundled catalogue. This is not an executable marketplace manifest. */
export const CAPABILITY_CATALOG = Object.freeze([
  {
    schemaVersion: 1,
    id: 'browser',
    version: '1.0.0',
    driver: 'browser',
    defaultInstalled: false,
    title: { fr: 'Navigation web', en: 'Web browsing' },
    description: {
      fr: 'Navigateur isolé à la demande pour les agents.',
      en: 'On-demand isolated browser for agents.',
    },
    imageRepository: 'ghcr.io/maxhugit/mergeron-browser',
    resources: { memoryMiB: 1024, cpu: 1.5 },
    policy: 'browser-isolation-v1',
    documentation: 'docs/navigateur-annote.md',
  },
  {
    schemaVersion: 1,
    id: 'transcription',
    version: '1.0.0',
    driver: 'transcription',
    defaultInstalled: false,
    title: { fr: 'Transcription', en: 'Transcription' },
    description: {
      fr: 'Conversion locale des pistes audio et vidéo en texte.',
      en: 'Local conversion of audio and video tracks to text.',
    },
    imageRepository: 'ghcr.io/maxhugit/mergeron-transcription',
    resources: { memoryMiB: 6144, cpu: 4 },
    policy: 'transcription-isolation-v1',
    documentation: 'docs/file-transcription.md',
  },
]);

/** Registration is code-owned, never accepted from HTTP input or remote JSON. */
export function capabilityRegistry(catalogue, drivers) {
  const seen = new Set();
  return catalogue.map((entry) => {
    const driver = drivers[entry.driver];
    if (
      entry.schemaVersion !== 1 ||
      !/^[a-z][a-z0-9-]{0,47}$/.test(entry.id ?? '') ||
      seen.has(entry.id) ||
      entry.defaultInstalled !== false ||
      !/^\d+\.\d+\.\d+$/.test(entry.version ?? '') ||
      !/^ghcr\.io\/[a-z0-9-]+\/[a-z0-9-]+$/.test(entry.imageRepository ?? '') ||
      !/^[a-z0-9-]+-v\d+$/.test(entry.policy ?? '') ||
      !/^docs\/[a-zA-Z0-9-]+\.md$/.test(entry.documentation ?? '') ||
      !['fr', 'en'].every(
        (lang) =>
          typeof entry.title?.[lang] === 'string' &&
          typeof entry.description?.[lang] === 'string',
      ) ||
      !(entry.resources?.memoryMiB > 0 && entry.resources.cpu > 0) ||
      !driver ||
      ![
        'inspect',
        'status',
        'install',
        'prune',
        'busy',
        'activeLeases',
        'legacyEnabled',
        'configure',
      ].every((key) => typeof driver[key] === 'function')
    )
      throw Error('CAPABILITY_CATALOG_INVALID');
    seen.add(entry.id);
    return { ...structuredClone(entry), lifecycle: driver };
  });
}
