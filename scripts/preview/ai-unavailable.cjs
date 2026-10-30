#!/usr/bin/env node
// Explicitly reject AI initialization, keeping the pipe open to avoid EPIPE.
// This is a fixture, never a successful model/account response.
if (process.argv.includes('--version')) {
  console.error('Preview only: AI runtime intentionally unavailable');
  process.exit(1);
}
require('node:readline')
  .createInterface({ input: process.stdin })
  .on('line', (line) => {
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      return;
    }
    if (request.id === undefined) return;
    process.stdout.write(
      JSON.stringify({
        id: request.id,
        error: {
          code: -32000,
          message: 'AI runtime intentionally unavailable in isolated preview',
        },
      }) + '\n',
    );
  });
