# GnuPG, systemd and SSH server applicability

Review date: 2026-10-22. Scope: exact Debian package versions and architectures in
`system-components-assessment.json`, in the immutable Mergeron image.
This is an applicability assessment, not a binary update or an assessment of the
Docker host, bind mounts, TPM passthrough or tools subsequently installed by users.

| CVE | HIGH findings | Affected implementation | Image decision |
| --- | ---: | --- | --- |
| CVE-2026-24882 | 7 | GnuPG tpm2daemon TPM private-key decryption | Not present; normal GPG tools retained |
| CVE-2026-16742 | 2 | systemd-homed authentication and systemd-homework | Not present in libsystemd0/libudev1 or elsewhere in image |

Sources, reviewed individually:
- https://security-tracker.debian.org/tracker/CVE-2026-24882
- https://github.com/systemd/systemd/security/advisories/GHSA-jm29-p7hh-vjhv
- https://security-tracker.debian.org/tracker/CVE-2026-59999
- https://security-tracker.debian.org/tracker/CVE-2026-60000
- https://security-tracker.debian.org/tracker/CVE-2026-106553
- https://security-tracker.debian.org/tracker/CVE-2026-106555
- https://www.openssh.org/releasenotes.html#10.4p1
- https://www.openssh.org/releasenotes.html#10.6p1

## Evidence and safeguards

Both PR and publication workflows inspect installed packages and the actual
filesystem under /usr, /opt, /root and /home as root, plus the compressed
toolchain seed restored by the entrypoint. Unreadable directories fail the check. The review fails if tpm2daemon,
systemd-homed, systemd-homework, sshd, sshd-auth or sshd-session appears, including
unpackaged files, or if a reviewed package version changes. Debian's merged /usr
covers /bin, /sbin and /lib. Runtime mounts and user modifications are outside this
immutable-image check. No package is removed and no client configuration changes.

Only after this inventory and the GPG/SSH functional tests succeed is a combined
OpenVEX document generated for Trivy. The audit compares the header-only report to
the final report and permits only the 9 exact HIGH package/CVE/PURL decisions.
Unknown CVEs, other versions/packages, client vulnerabilities and all CRITICAL
findings must remain. Raw, header-only and final JSON reports, the evidence and
all applicability documents are retained as CI artifacts. SARIF uses the same
combined document in the publication workflow.

Functional checks cover GPG key creation, detached signing/verification and signed
Git commit verification; SSH Ed25519 key creation, strict host-key configuration,
agent loading and an agent-backed signature/verification. They run in a disposable
container with temporary keys, without credentials or external network services.
They do not claim to test a remote SSH/SFTP connection. Existing image health,
Office, archive and GitHub CLI tests remain enabled.

## OpenSSH correction supersedes the former server-only assessment

The four OpenSSH server-only VEX statements were removed when the client was
upgraded to Debian OpenSSH 10.6p1 sources rebuilt on Trixie. Both the real client
CVEs and the server-only CVEs are fixed in the new source version; none are
suppressed by this VEX. See `openssh-backport.md` for provenance and transfer tests.
All unrelated findings remain, including the kernel-header CRITICAL. The
separate Linux-header assessment is unchanged.
