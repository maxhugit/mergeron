"""Bounded USTAR export. All source traversal uses no-follow directory FDs."""
import hashlib
import io
import json
import os
import re
import stat
import sys
import tarfile

EXCLUDED = re.compile(r"^(?:\.git|\.env(?:\..*)?|\.ssh|\.codex|\.aws|\.docker|\.kube|\.config|\.local|\.npmrc|\.yarnrc(?:\.yml)?|\.netrc|\.pypirc|\.gitconfig|\.secrets|credentials|id_rsa|id_ed25519|authorized_keys|\.mergeron.*|\.webui|\.agent-document-drafts|node_modules|\.venv|venv|\.cache|\.next|\.pytest_cache|__pycache__|dist|build|coverage|artifacts|logs)$", re.I)
PRIVATE = re.compile(r"\.(?:pem|key|p12|pfx|sqlite3?(?:-wal|-shm|-journal)?|db)$", re.I)
FLAGS = os.O_RDONLY | os.O_NOFOLLOW | os.O_DIRECTORY


def fail(code):
    raise RuntimeError(code)


def open_root(value):
    if not os.path.isabs(value) or os.path.normpath(value) != value:
        fail("PREVIEW_UNSAFE_SOURCE")
    fd = os.open("/", FLAGS)
    try:
        for component in value.split("/")[1:]:
            if not component:
                fail("PREVIEW_UNSAFE_SOURCE")
            following = os.open(component, FLAGS, dir_fd=fd)
            os.close(fd)
            fd = following
        return fd
    except BaseException:
        os.close(fd)
        raise


def inventory(root):
    result, total = [], 0

    def walk(fd, prefix="", depth=0):
        nonlocal total
        if depth > 40:
            fail("PREVIEW_SOURCE_LIMIT")
        for name in sorted(os.listdir(fd)):
            if EXCLUDED.match(name) or PRIVATE.search(name):
                continue
            relative = prefix + name
            if len(relative.encode("utf8")) > 240 or re.search(r"[\x00-\x1f\\]", relative):
                fail("PREVIEW_UNSAFE_SOURCE")
            value = os.stat(name, dir_fd=fd, follow_symlinks=False)
            if stat.S_ISLNK(value.st_mode):
                fail("PREVIEW_SOURCE_SYMLINK")
            row = [relative, value.st_dev, value.st_ino, value.st_size,
                   value.st_mtime_ns, value.st_ctime_ns, value.st_mode & 0o111]
            if stat.S_ISDIR(value.st_mode):
                child = os.open(name, FLAGS, dir_fd=fd)
                try:
                    opened = os.fstat(child)
                    if (opened.st_ino, opened.st_dev) != (value.st_ino, value.st_dev):
                        fail("PREVIEW_SOURCE_CHANGED")
                    result.append(["d"] + row)
                    walk(child, relative + "/", depth + 1)
                finally:
                    os.close(child)
            elif stat.S_ISREG(value.st_mode) and value.st_nlink == 1:
                total += value.st_size
                if value.st_size > 16 * 1024**2 or total > 50 * 1024**2:
                    fail("PREVIEW_SOURCE_LIMIT")
                result.append(["f"] + row)
            else:
                fail("PREVIEW_UNSAFE_SOURCE")
            if len(result) > 15000:
                fail("PREVIEW_SOURCE_LIMIT")
    walk(root)
    return result


def read_file(root, item):
    parts = item[1].split("/")
    fd = os.dup(root)
    try:
        for component in parts[:-1]:
            child = os.open(component, FLAGS, dir_fd=fd)
            os.close(fd)
            fd = child
        source = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
        try:
            def signature():
                value = os.fstat(source)
                if not stat.S_ISREG(value.st_mode) or value.st_nlink != 1:
                    fail("PREVIEW_UNSAFE_SOURCE")
                return [value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns,
                        value.st_ctime_ns, value.st_mode & 0o111]
            if signature() != item[2:]:
                fail("PREVIEW_SOURCE_CHANGED")
            chunks, remaining = [], item[4]
            while remaining:
                chunk = os.read(source, min(remaining, 1024 * 1024))
                if not chunk:
                    fail("PREVIEW_SOURCE_CHANGED")
                chunks.append(chunk)
                remaining -= len(chunk)
            if os.read(source, 1) or signature() != item[2:]:
                fail("PREVIEW_SOURCE_CHANGED")
            return b"".join(chunks)
        finally:
            os.close(source)
    finally:
        os.close(fd)


def main():
    root = open_root(sys.argv[1])
    try:
        items = inventory(root)
        if not any(row[0] == "f" for row in items):
            fail("PREVIEW_EMPTY_SOURCE")
        if len(sys.argv) == 3 and sys.argv[2] == "--check":
            print(json.dumps({"fingerprint": hashlib.sha256(json.dumps(items).encode()).hexdigest()}))
            return
        with tarfile.open(fileobj=sys.stdout.buffer, mode="w|", format=tarfile.USTAR_FORMAT) as archive:
            for row in [["d", ".", 0, 0, 0, 0, 0, 0]] + items:
                entry = tarfile.TarInfo(row[1])
                entry.uid = entry.gid = 11002
                entry.mtime = 0
                entry.mode = 0o700 if row[0] == "d" or row[7] else 0o600
                entry.type = tarfile.DIRTYPE if row[0] == "d" else tarfile.REGTYPE
                buffer = b"" if row[0] == "d" else read_file(root, row)
                entry.size = len(buffer)
                archive.addfile(entry, io.BytesIO(buffer))
            if inventory(root) != items:
                fail("PREVIEW_SOURCE_CHANGED")
    finally:
        os.close(root)


try:
    main()
except BaseException as error:
    code = str(error)
    print(code if re.fullmatch(r"PREVIEW_[A-Z_]+", code) else "PREVIEW_UNSAFE_SOURCE", file=sys.stderr)
    sys.exit(1)
