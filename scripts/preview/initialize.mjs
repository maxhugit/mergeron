import { createRequire } from 'node:module';
import { join } from 'node:path';
import {
  symlink,
  lstat,
  readlink,
  writeFile,
  readFile,
  chmod,
} from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { configuration, prepareDirectory, repository } from './config.mjs';

const require = createRequire(join(repository, 'package.json'));

export async function initialize(config) {
  if (!/^[a-z0-9][a-z0-9._-]{2,63}$/.test(config.username))
    throw new Error('Invalid preview administrator username');
  if (config.password !== undefined && config.password.length < 12)
    throw new Error('Preview password requires at least 12 characters');
  await prepareDirectory(config.dataDirectory);
  const unavailableRuntime = join(config.dataDirectory, 'ai-unavailable.cjs');
  await writeFile(
    unavailableRuntime,
    await readFile(join(repository, 'scripts/preview/ai-unavailable.cjs')),
    { mode: 0o700 },
  );
  await chmod(unavailableRuntime, 0o700);
  const migrations = join(config.dataDirectory, 'drizzle');
  try {
    await symlink(join(repository, 'drizzle'), migrations, 'dir');
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (
      !(await lstat(migrations)).isSymbolicLink() ||
      (await readlink(migrations)) !== join(repository, 'drizzle')
    )
      throw new Error('Preview migration link points outside this repository');
  }
  const { DatabaseService } = require(
    join(repository, 'dist/database/database.service.js'),
  );
  const { ConfigService } = require('@nestjs/config');
  const { people, localAuthCredentials } = require(
    join(repository, 'dist/database/schema.js'),
  );
  const { eq } = require('drizzle-orm');
  const { hash, verify } = require('@node-rs/argon2');
  const previous = process.cwd();
  let database;
  try {
    // Only a genuinely new database may authorize first installation. Restarting
    // or switching modes must never re-arm an existing installation.
    const databasePath = join(config.dataDirectory, 'mergeron-test.sqlite');
    const newDatabase = await lstat(databasePath).then(
      () => false,
      (error) => {
        if (error.code === 'ENOENT') return true;
        throw error;
      },
    );
    process.chdir(config.dataDirectory);
    database = new DatabaseService(
      new ConfigService({
        WEBUI_DB_PATH: join(config.dataDirectory, 'mergeron-test.sqlite'),
      }),
    );
    if (!config.seedAdmin) {
      if (newDatabase) {
        await writeFile(
          join(config.dataDirectory, 'codex/webui-initial-admin.json'),
          JSON.stringify({
            version: 1,
            installationId: randomUUID(),
            state: 'armed',
          }),
          { mode: 0o600, flag: 'wx' },
        );
      }
      console.log(
        'Preview installation initialized without a pre-created account',
      );
      return;
    }
    const existing = database.db
      .select()
      .from(localAuthCredentials)
      .where(eq(localAuthCredentials.username, config.username))
      .get();
    if (existing) {
      const person = database.db
        .select()
        .from(people)
        .where(eq(people.id, existing.personId))
        .get();
      if (!person?.active || person.role !== 'administrator')
        throw new Error(
          'Existing preview account is not an active administrator',
        );
      console.log(`Preview administrator ${config.username} preserved`);
      return;
    }
    const password = config.password ?? randomBytes(24).toString('base64url');
    const passwordHash = await hash(password, {
      algorithm: 2,
      memoryCost: 19456,
      timeCost: 2,
      parallelism: 1,
      outputLen: 32,
    });
    if (!(await verify(passwordHash, password)))
      throw new Error('Preview password hash verification failed');
    const now = Date.now();
    database.db.transaction((tx) => {
      tx.insert(people)
        .values({
          id: 'preview-admin',
          reference: 'PREVIEW-ADMIN',
          name: config.username,
          role: 'administrator',
          active: true,
          createdAt: now,
          updatedAt: now,
        })
        .run();
      tx.insert(localAuthCredentials)
        .values({
          id: 'preview-local-admin',
          personId: 'preview-admin',
          username: config.username,
          passwordHash,
          passwordChangedAt: now,
          createdAt: now,
          updatedAt: now,
        })
        .run();
    });
    if (config.password === undefined) {
      const credentials = join(config.dataDirectory, 'admin-credentials.json');
      await writeFile(
        credentials,
        JSON.stringify({ username: config.username, password }),
        { mode: 0o600, flag: 'wx' },
      );
      console.log(
        `Generated preview credentials written to ${credentials} (not printed)`,
      );
    }
    console.log(
      `Preview administrator ${config.username} initialized; password hash verified`,
    );
  } finally {
    database?.onModuleDestroy();
    process.chdir(previous);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  initialize(configuration()).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
