#!/usr/bin/env bash
# Assemble the self-host bundle (PRD §Day-15): compose.yaml + .env.example + README + initdb, with the
# image refs in .env.example PINNED to this release. Output: relay-selfhost.tar.gz. Called by the
# release workflow (VERSION=<tag>) and available locally via `make selfhost-bundle`.
set -euo pipefail

VERSION="${VERSION:-${1:-latest}}"
VERSION="${VERSION#v}" # GHCR tags carry no leading v (docker/metadata {{version}})
OWNER="${GHCR_OWNER:-chetan-01-source}"
SRC="deploy/selfhost"
OUT="relay-selfhost.tar.gz"

[ -d "$SRC" ] || { echo "missing $SRC" >&2; exit 1; }

stage="$(mktemp -d)/relay-selfhost"
mkdir -p "$stage"
cp -R "$SRC/compose.yaml" "$SRC/README.md" "$SRC/initdb" "$stage/"

# Pin the two image refs from :latest to :<version> so a downloaded bundle boots a fixed, signed release.
sed -e "s|ghcr.io/[^/]*/relay:latest|ghcr.io/${OWNER}/relay:${VERSION}|" \
    -e "s|ghcr.io/[^/]*/relay-console:latest|ghcr.io/${OWNER}/relay-console:${VERSION}|" \
    "$SRC/.env.example" >"$stage/.env.example"

tar -czf "$OUT" -C "$(dirname "$stage")" "$(basename "$stage")"
echo "wrote $OUT ($(du -h "$OUT" | cut -f1)), images pinned to ${VERSION}"
