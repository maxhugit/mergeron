#!/usr/bin/env bash
# Build-only, official pinned source plus reviewed Mergeron patch. No credentials.
set -Eeuo pipefail
git init /build/codex
cd /build/codex
git remote add origin https://github.com/openai/codex.git
git fetch --depth=1 origin 6aaac694803004a63c6f393d153c96d22521a6b9
git checkout --detach FETCH_HEAD
test "$(git rev-parse HEAD)" = 6aaac694803004a63c6f393d153c96d22521a6b9
git apply --check /reviewed/0.164.0-route-query.patch
git apply /reviewed/0.164.0-route-query.patch
cd codex-rs
test "$(grep -c '^version = "0.0.0"$' Cargo.lock)" -eq 166
sed -i 's/^version = "0.0.0"$/version = "0.164.0"/' Cargo.lock
cargo build --locked --release --bin codex
mkdir -p /out
cp target/release/codex /out/codex
test "$(/out/codex --version)" = 'codex-cli 0.164.0'
git apply --check /reviewed/0.164.0-route-query-tests.patch
git apply /reviewed/0.164.0-route-query-tests.patch
cargo test --locked --release -p codex-linux-sandbox --lib seccomp::tests -- --test-threads=1
cp /reviewed/0.164.0-route-query.patch /out/route-query.patch
