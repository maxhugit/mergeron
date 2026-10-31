#!/usr/bin/env bash
set -euo pipefail
image=${1:?Manager image required}
fixture_volume=$(docker volume create --label io.mergeron.test=manager-backup)
fixture_name="mergeron-manager-backup-$(date +%s)-$$"
cleanup() {
  docker rm -f -v "$fixture_name" >/dev/null 2>&1 || true
  docker volume rm "$fixture_volume" >/dev/null
}
trap cleanup EXIT
docker run --name "$fixture_name" --rm --network none --read-only --cap-drop ALL --cap-add CHOWN --cap-add DAC_READ_SEARCH --security-opt no-new-privileges:true \
  --memory 512m --cpus 0.25 --pids-limit 64 \
  -v "$fixture_volume:/fixture" --entrypoint /nodejs/bin/node "$image" --input-type=module -e '
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { copyPersistentTree, restorePersistentEntry, TransactionalUpdater } from "/opt/mergeron-manager/src/updater.mjs";
import { createBackupArchive, extractBackupArchive } from "/opt/mergeron-manager/src/backup-archive.mjs";
// Standard tar+gzip roundtrip under the real CHOWN + DAC_READ_SEARCH boundary.
// Keep protected_hardlinks enabled and preserve UID 11002 mode-0600 secrets.
await fs.mkdir("/fixture/compression/home", {recursive:true,mode:0o700});
await fs.writeFile("/fixture/compression/home/database", "private-state".repeat(10000), {mode:0o600});
await fs.link("/fixture/compression/home/database", "/fixture/compression/home/linked");
await fs.chown("/fixture/compression/home/database",11002,11002);
await fs.symlink("/outside-the-fixture", "/fixture/compression/home/link");
await fs.chmod("/fixture/compression/home",0o500);
await fs.chown("/fixture/compression/home",11002,11002);
const archived = await createBackupArchive({root:"/fixture/compression",path:"/fixture/backup.tar.gz",roots:["home"],policy:"full-v1"});
assert.ok(archived.bytes < 10000);
assert.equal((await fs.stat("/fixture/backup.tar.gz")).mode & 0o777,0o600);
await extractBackupArchive({path:"/fixture/backup.tar.gz",destination:"/fixture/extracted",descriptor:archived,roots:["home"]});
const restoredArchiveFile = await fs.stat("/fixture/extracted/home/database");
assert.equal(restoredArchiveFile.uid,11002); assert.equal(restoredArchiveFile.gid,11002);
assert.equal(restoredArchiveFile.mode & 0o777,0o600);
assert.equal(restoredArchiveFile.ino,(await fs.stat("/fixture/extracted/home/linked")).ino);
assert.equal((await fs.stat("/fixture/extracted/home")).mode & 0o777,0o500);
assert.equal(await fs.readlink("/fixture/extracted/home/link"),"/outside-the-fixture");
assert.equal(await fs.readFile("/fixture/extracted/home/database","utf8"),"private-state".repeat(10000));
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
// Minimal restoration changes only selected leaves inside a private app-owned parent.
const minimalRoot = "/fixture/minimal";
const minimalId = "bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee";
const minimalUpdates = `${minimalRoot}/manager-state/updates`;
const minimalBase = `${minimalUpdates}/${minimalId}`;
const privateHome = `${minimalRoot}/home/.codex`;
await fs.mkdir(`${privateHome}/sessions`, {recursive:true});
await fs.mkdir(`${minimalBase}/backup/home/.codex`, {recursive:true});
await fs.writeFile(`${privateHome}/codex-webui.sqlite`, "database-before", {mode:0o600});
await fs.chown(`${privateHome}/codex-webui.sqlite`, 11002, 11002);
await fs.writeFile(`${privateHome}/sessions/thread.jsonl`, "conversation-current");
await copyPersistentTree(`${privateHome}/codex-webui.sqlite`, `${minimalBase}/backup/home/.codex/codex-webui.sqlite`);
await fs.chown(`${privateHome}/codex-webui.sqlite`, 0, 0);
await fs.writeFile(`${privateHome}/codex-webui.sqlite`, "database-migrated");
await fs.chown(`${privateHome}/codex-webui.sqlite`, 11002, 11002);
await fs.writeFile(`${privateHome}/codex-webui.sqlite-wal`, "new-sidecar");
await fs.chmod(privateHome, 0o500);
await fs.chown(privateHome, 11002, 11002);
const minimalUpdater = new TransactionalUpdater({manifest:{stack:"mergeron-dev",environment:"development"},configuration:{hostStatePath:minimalRoot},directory:minimalUpdates});
minimalUpdater.current = {id:minimalId,status:"running",events:[],backupMissing:["home/.codex/codex-webui.sqlite-wal"]};
await minimalUpdater.restoreMinimalEntry(minimalBase, "home/.codex/codex-webui.sqlite");
await minimalUpdater.restoreMinimalEntry(minimalBase, "home/.codex/codex-webui.sqlite-wal");
assert.equal(await fs.readFile(`${privateHome}/codex-webui.sqlite`, "utf8"), "database-before");
assert.equal(await fs.readFile(`${privateHome}/sessions/thread.jsonl`, "utf8"), "conversation-current");
await assert.rejects(fs.lstat(`${privateHome}/codex-webui.sqlite-wal`), {code:"ENOENT"});
assert.equal(await fs.readFile(`${minimalBase}/quarantine/home/.codex/codex-webui.sqlite-wal`, "utf8"), "new-sidecar");
assert.equal((await fs.stat(privateHome)).uid, 11002);
assert.equal((await fs.stat(privateHome)).mode & 0o777, 0o500);
assert.equal((await fs.stat(`${privateHome}/codex-webui.sqlite`)).uid, 11002);
// Replay after a crash while the parent temporarily belongs to the Manager.
await fs.chown(privateHome, 0, 0);
await fs.chmod(privateHome, 0o700);
await minimalUpdater.restoreMinimalEntry(minimalBase, "home/.codex/codex-webui.sqlite");
assert.equal((await fs.stat(privateHome)).uid, 11002);
assert.equal((await fs.stat(privateHome)).mode & 0o777, 0o500);
console.log("Manager backup, rollback and deletion preserve live data with minimal capabilities.");
'
# Exercise the archive failure/recovery and Linux-only ownership/crash cases
# with the actual restricted capabilities. The complete updater suite remains
# mandatory in source CI; this shell-free image does not include its build tools.
docker run --name "$fixture_name" --rm --network none --read-only \
  --cap-drop ALL --cap-add CHOWN --cap-add DAC_READ_SEARCH \
  --security-opt no-new-privileges:true --memory 512m --cpus 0.25 --pids-limit 64 \
  -e TMPDIR=/fixture -v "$fixture_volume:/fixture" \
  --mount "type=bind,src=$(pwd)/manager/test/updater.test.mjs,dst=/opt/mergeron-manager/test/updater.test.mjs,readonly" \
  --entrypoint /nodejs/bin/node "$image" --test \
  --test-name-pattern='compressed|recovery discards a crashed extraction|minimal recovery restores private directory ownership' \
  test/updater.test.mjs
