import { spawn } from 'node:child_process';
import { expect, it } from 'vitest';
import { gitCredentialHelper } from './git-credentials';

function credentials(operation: string, username: string, password: string) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(
      'git',
      [
        '-c',
        'credential.helper=',
        '-c',
        `credential.helper=${gitCredentialHelper}`,
        'credential',
        operation,
      ],
      {
        env: {
          PATH: process.env.PATH,
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_TERMINAL_PROMPT: '0',
          // A nonexistent askpass proves no temporary executable is needed.
          GIT_ASKPASS: '/not/an/executable',
          MERGERON_GIT_USERNAME: username,
          MERGERON_GIT_TOKEN: password,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(output);
      else reject(new Error('Git credential helper failed'));
    });
    const supplied =
      operation === 'fill'
        ? ''
        : 'username=input-user\npassword=input-password\n';
    child.stdin.end(`protocol=https\nhost=example.invalid\n${supplied}\n`);
  });
}

it('supplies credentials to real Git without an executable temporary file or shell interpolation', async () => {
  const username = "user '$HOME $(false)";
  const password = "fake-password '$HOME $(false)";
  const result = await credentials('fill', username, password);
  expect(result).toContain(`username=${username}\n`);
  expect(result).toContain(`password=${password}\n`);
  expect(gitCredentialHelper).not.toContain(password);
});

it.each(['approve', 'reject'])(
  'never emits or stores credentials on %s',
  async (operation) => {
    expect(await credentials(operation, 'test-user', 'fake-password')).toBe('');
  },
);
