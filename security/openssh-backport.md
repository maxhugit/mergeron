# OpenSSH client security update

The production Mergeron image uses real Debian packages rebuilt from the official
OpenSSH 10.6p1-1 source and Debian patch archives on Trixie. SHA-256 values for all
six inputs, including signed source descriptors, are pinned in
`scripts/build-openssh-backport.sh`. The local version is
`1:10.6p1-1~webui13.1`; this is a project-maintained rebuild, not an official Debian
Trixie security update. Future security releases require rebuilding this backport.
No sid repository or sid runtime library is added.

Packages installed: `openssh-common` and `openssh-client-gssapi`. The latter
provides/replaces `openssh-client`, retaining GSSAPI authentication and key exchange
that Debian moved out of the standard client. Common tools include ssh-keygen and
FIDO/PKCS#11 helpers. Debian patches, hardening and unit/compatibility tests are
retained. Build dependencies and server binaries stay in build/test-only stages.
The old client is replaced through apt/dpkg, not shadowed with another binary.

This fixes the client-side use-after-free during host-key re-exchange
(CVE-2026-60002, fixed upstream in 10.4) and unsafe command-line username handling
(CVE-2026-106583, fixed in 10.6). The four old server-only VEX statements are
removed; no SSH alert is hidden by an applicability statement. The raw scan is never filtered for SSH. Trivy's Debian detector treats Trixie
advisories with no FixedVersion as affecting every source version, including this
10.6p1 rebuild. Therefore known, source-fixed CVEs can remain in raw and final
reports. A gate instead binds the exact binary/source package versions to real
transfer/security test evidence; it fails on unknown SSH CVEs, changed versions,
or newly available Debian fixed-version metadata. It does not edit either report.

The helper dependency `systemd-standalone-sysusers` creates Debian's _ssh group
without adding systemd as an init system; its systemd-homed source-family alert
also remains visible. No VEX is added for this dependency.

The isolated SSH fixture runs only in CI on an internal Docker network, with no
published port or personal credentials. Ephemeral keys and containers are removed
on exit. The production client runs as UID 11002 with strict host-key checking.
Tests cover SSH commands, repeated key exchange during binary transfers, SFTP,
modern and legacy SCP, Git clone/commit/push/ls-remote/fetch/fast-forward, rejection
of a wrong host key and rejection of unsafe usernames. GSSAPI options are checked;
a full Kerberos realm and physical FIDO tokens are not exercised. Existing agent,
GPG, archives, Office and application health checks remain enabled.

Sources:
- https://www.openssh.org/releasenotes.html#10.6p1
- https://security-tracker.debian.org/tracker/CVE-2026-60002
- https://security-tracker.debian.org/tracker/CVE-2026-106583
- https://deb.debian.org/debian/pool/main/o/openssh/openssh_10.6p1-1.dsc
- https://deb.debian.org/debian/pool/main/o/openssh-gssapi/openssh-gssapi_10.6p1-1.dsc

Detector behavior: https://github.com/aquasecurity/trivy/blob/v0.76.1/pkg/detector/ospkg/debian/debian.go#L103-L107
