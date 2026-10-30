#!/usr/bin/env bash
set -euo pipefail
image=${1:?Manager image required}
fixture_volume=$(docker volume create --label io.mergeron.test=manager-backup)
trap 'docker volume rm "$fixture_volume" >/dev/null' EXIT
docker run --rm --network none --read-only --cap-drop ALL --cap-add CHOWN --cap-add DAC_READ_SEARCH --security-opt no-new-privileges:true \
  -v "$fixture_volume:/fixture" --entrypoint /nodejs/bin/node "$image" --input-type=module -e '
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { copyPersistentTree, restorePersistentEntry, TransactionalUpdater } from "/opt/mergeron-manager/src/updater.mjs";
await fs.mkdir("/fixture/home", {mode: 0o700});
await fs.writeFile("/fixture/home/database", "private-state", {mode: 0o600});
await fs.chown("/fixture/home/database", 11002, 11002);
await fs.symlink("/outside-the-fixture", "/fixture/home/link");
await fs.mkdir("/fixture/home/.cache", {mode:0o700});
await fs.writeFile("/fixture/home/.cache/download", "regenerable", {mode:0o600});
await fs.chown("/fixture/home/.cache/download", 11002, 11002);
await fs.chown("/fixture/home/.cache", 11002, 11002);
await fs.chown("/fixture/home", 11002, 11002);
await copyPersistentTree("/fixture/home", "/fixture/backup");
assert.equal(await fs.readFile("/fixture/backup/database", "utf8"), "private-state");
const copied = await fs.stat("/fixture/backup/database");
assert.equal(copied.uid, 11002); assert.equal(copied.gid, 11002); assert.equal(copied.mode & 0o777, 0o600);
assert.equal((await fs.stat("/fixture/backup")).mode & 0o777, 0o700);
assert.equal(await fs.readlink("/fixture/backup/link"), "/outside-the-fixture");
// Essential production selection keeps private data while skipping owner-only caches.
await copyPersistentTree("/fixture/home", "/fixture/essential", 1, {policy:"production-essential-v1",path:"home"});
assert.equal(await fs.readFile("/fixture/essential/database", "utf8"), "private-state");
assert.equal((await fs.stat("/fixture/essential/database")).uid, 11002);
await assert.rejects(fs.lstat("/fixture/essential/.cache"), {code:"ENOENT"});
await fs.mkdir("/fixture/operation/backup", {recursive: true});
await copyPersistentTree("/fixture/home", "/fixture/operation/backup/home");
// Write as the owner would, without depending on DAC_OVERRIDE in this fixture.
await fs.chown("/fixture/home/database", 0, 0);
await fs.writeFile("/fixture/home/database", "newer-state");
await fs.chown("/fixture/home/database", 11002, 11002);
await restorePersistentEntry("/fixture", "/fixture/operation", "test-operation", "home");
assert.equal(await fs.readFile("/fixture/home/database", "utf8"), "private-state");
assert.equal(await fs.readFile("/fixture/operation/quarantine/home/database", "utf8"), "newer-state");
assert.equal((await fs.stat("/fixture/home")).uid, 11002);
assert.equal((await fs.stat("/fixture/home/database")).mode & 0o777, 0o600);
// Reproduce the real deletion failure: app-owned directories, no DAC_OVERRIDE/FOWNER.
const id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const updates = "/fixture/updates";
const operation = `${updates}/${id}`;
await fs.mkdir(`${operation}/backup`, {recursive:true});
await copyPersistentTree("/fixture/home", `${operation}/backup/home`);
// Create the fixture link as its owner (protected_hardlinks stays enabled).
await fs.chown("/fixture/home/database", 0, 0);
await fs.link("/fixture/home/database", `${operation}/backup/live-hardlink`);
await fs.chown("/fixture/home/database", 11002, 11002);
await fs.symlink("/fixture/home", `${operation}/backup/live-directory`);
await fs.chown(`${operation}/backup/home`, 0, 0);
await fs.chmod(`${operation}/backup/home`, 0o500);
await fs.chown(`${operation}/backup/home`, 11002, 11002);
await fs.writeFile(`${updates}/${id}.json`, JSON.stringify({id,stack:"mergeron-dev",environment:"development",status:"succeeded",backupComplete:true}));
const updater = new TransactionalUpdater({manifest:{stack:"mergeron-dev",environment:"development"},directory:updates});
await updater.deleteBackup({operationId:id,confirmation:"DELETE_UPDATE_BACKUP"});
await assert.rejects(fs.lstat(`${operation}/backup`), {code:"ENOENT"});
const journal = JSON.parse(await fs.readFile(`${updates}/${id}.json`, "utf8"));
assert.equal(journal.backupComplete, false); assert.ok(journal.backupDeletedAt);
assert.equal(await fs.readFile("/fixture/home/database", "utf8"), "private-state");
assert.equal((await fs.stat("/fixture/home/database")).uid, 11002);
assert.equal((await fs.stat("/fixture/home/database")).mode & 0o777, 0o600);
assert.equal((await fs.stat("/fixture/home")).uid, 11002);
assert.equal((await fs.stat("/fixture/home")).mode & 0o777, 0o700);
assert.equal(await fs.readFile("/fixture/operation/quarantine/home/database", "utf8"), "newer-state");
console.log("Manager backup, rollback and deletion preserve live data with minimal capabilities.");
'
