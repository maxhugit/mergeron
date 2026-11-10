import { zipSync, strToU8 } from 'fflate';
import { createHash } from 'node:crypto';

/** A publication is always a ZIP, even when all assets are embedded in one HTML. */
export function mockupArchive(source: {
  html: string;
  reference: unknown;
}): Buffer {
  const html = strToU8(source.html);
  const manifest = {
    type: 'mergeron.mockup.archive',
    version: 1,
    entrypoint: 'index.html',
    reference: source.reference,
    files: [
      {
        path: 'index.html',
        bytes: html.length,
        sha256: createHash('sha256').update(html).digest('hex'),
      },
    ],
  };
  return Buffer.from(
    zipSync({
      'index.html': html,
      'mergeron-mockup.json': strToU8(JSON.stringify(manifest, null, 2)),
    }),
  );
}
