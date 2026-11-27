#!/usr/bin/env bash
set -Eeuo pipefail
cd /build
# Pin the archived source set: the rolling Debian pool removes superseded releases.
fetch() {
  local source="$1" file="$2" digest="$3"
  curl --fail --silent --show-error --location --retry 3 \
    "https://snapshot.debian.org/archive/debian/20261006T203214Z/pool/main/o/${source}/${file}" --output "${file}"
  echo "${digest}  ${file}" | sha256sum --check --strict
}
fetch openssh openssh_10.6p1-1.dsc 3169605230f88ceeeffe12995c18bec6019d0649125326eea442dd76a19015d4
fetch openssh openssh_10.6p1.orig.tar.xz ff8514b95a2c4c8bafe07a87ac93d51bcf47bbe29ccbc185f2f9a9f86fd46c86
fetch openssh openssh_10.6p1-1.debian.tar.xz a12ee48c4a26c10473e7b781ce6c2df2228b648e3961fef051374407b50701a1
fetch openssh-gssapi openssh-gssapi_10.6p1.orig.tar.xz 715c8724c17be381d59561f5e26eb487951714f3379a685cd3e8ff6e9d6afc43
fetch openssh-gssapi openssh-gssapi_10.6p1-1.debian.tar.xz 7462e96b9b1d4241371aa33afa911f21886d3a0ad04e30ca1d7681f9c2741623
# Both source archives and Debian patch archives are pinned independently above.
# The descriptors are pinned as well; no signing key is fetched during the build.
fetch openssh-gssapi openssh-gssapi_10.6p1-1.dsc c04b474dac25f9cb141b5f9ad96206376220b9df8e6680e7c8137772ca6c644f
for source in openssh openssh-gssapi; do
  dpkg-source --no-check -x "${source}_10.6p1-1.dsc" "${source}"
  (
    cd "${source}"
    cp debian/changelog /tmp/openssh-changelog.original
    {
      printf '%s (1:10.6p1-1~webui13.1) trixie; urgency=high\n\n' "${source}"
      printf '  * Rebuild Debian 10.6p1-1 on Trixie; retain upstream security fixes.\n\n'
      printf ' -- WebUI maintainers <webui@example.invalid>  Fri, 23 Oct 2026 00:00:00 +0200\n\n'
      cat /tmp/openssh-changelog.original
    } > debian/changelog
    # Keep Debian hardening, patches and unit/compatibility tests. No nocheck.
    dpkg-buildpackage --build=binary --no-sign -Ppkg.openssh.nognome,noudeb -j2
  )
done
mkdir -p /out
cp openssh-common_*_amd64.deb openssh-client-gssapi_*_amd64.deb /out/
cp openssh_10.6p1-1.dsc openssh-gssapi_10.6p1-1.dsc /out/
