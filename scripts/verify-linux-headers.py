"""Verify the header-only package and native compilation inside the Linux image."""

import json
from pathlib import Path
import subprocess
import tempfile


def run(*args):
    return subprocess.check_output(args, text=True, timeout=60).strip()


version = run("dpkg-query", "-W", "-f=${Version}", "linux-libc-dev")
subprocess.run(
    ["dpkg", "--compare-versions", version, "ge", "6.12.115-2"],
    check=True, timeout=60,
)
headers = 0
missing_documentation = []
for name in run("dpkg-query", "-L", "linux-libc-dev").splitlines():
    path = Path(name)
    if path.is_dir():
        continue
    is_header = name.startswith(("/usr/include/", "/usr/lib/linux/uapi/")) and name.endswith(".h")
    is_doc = name == "/usr/share/doc/linux-libc-dev" or name.startswith("/usr/share/doc/linux-libc-dev/")
    if not (is_header or is_doc):
        raise RuntimeError(f"Unexpected package payload; review VEX applicability: {name}")
    # Debian slim removes documentation while dpkg retains its file inventory.
    # Only documentation may be absent; missing headers still fail below.
    if is_doc and not path.exists():
        missing_documentation.append(name)
        continue
    if path.read_bytes().startswith(b"\x7fELF"):
        raise RuntimeError(f"Executable code in header package: {name}")
    headers += is_header
if not headers:
    raise RuntimeError("No userspace headers found")

installed = run("dpkg-query", "-W", "-f=${db:Status-Abbrev} ${Package}\n")
kernel_packages = [
    line for line in installed.splitlines()
    if line.startswith("ii ") and line.split()[-1].startswith(("linux-image-", "linux-modules-"))
]
if kernel_packages:
    raise RuntimeError(f"Kernel implementation is present; review VEX applicability: {kernel_packages}")

with tempfile.TemporaryDirectory(prefix="webui-native-smoke-") as directory:
    root = Path(directory)
    c_source = root / "headers.c"
    c_source.write_text(r'''
#include <linux/futex.h>
#include <linux/netlink.h>
#include <sys/mman.h>
#include <sys/socket.h>
#include <unistd.h>
int main(void) {
    int sockets[2];
    struct nlmsghdr header = {0};
    if (socketpair(AF_UNIX, SOCK_STREAM, 0, sockets)) return 1;
    void *memory = mmap(0, 4096, PROT_READ | PROT_WRITE,
                        MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    if (memory == MAP_FAILED) return 2;
    *(int *)memory = FUTEX_WAIT + (int)header.nlmsg_len;
    if (munmap(memory, 4096)) return 3;
    close(sockets[0]); close(sockets[1]);
    return 0;
}
''')
    cpp_source = root / "headers.cpp"
    cpp_source.write_text(r'''
#include <linux/memfd.h>
#include <thread>
#include <vector>
int main() {
    std::vector<int> values{MFD_CLOEXEC};
    std::thread worker([&] { values.push_back(42); });
    worker.join();
    return values.at(1) == 42 ? 0 : 1;
}
''')
    for compiler, source in (("gcc", c_source), ("g++", cpp_source)):
        binary = root / compiler
        run(compiler, "-Wall", "-Werror", "-pthread", str(source), "-o", str(binary))
        run(str(binary))

print(json.dumps({
    "package": "linux-libc-dev",
    "version": version,
    "header_files_checked": headers,
    "missing_documentation": missing_documentation,
    "kernel_packages": kernel_packages,
    "native_c_and_cpp": "passed",
    "host_kernel": "not assessed; this inventory covers only the container filesystem",
}, indent=2))
