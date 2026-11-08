import { mkdir, lstat, chown, chmod } from 'node:fs/promises';

// The app needs search permission on the directory as well as access to the
// socket. Repair only this dedicated directory, never its parents or contents.
export async function prepareSocketDirectory(
  directory,
  group,
  operations = { mkdir, lstat, chown, chmod },
) {
  if (!Number.isInteger(group) || group < 0)
    throw new Error('Invalid Manager socket group');
  await operations.mkdir(directory, { recursive: true, mode: 0o750 });
  const info = await operations.lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error('Invalid Manager socket directory');
  if (info.uid !== 0 || info.gid !== group)
    await operations.chown(directory, 0, group);
  await operations.chmod(directory, 0o750);
}
