#!/bin/sh

set -eu

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
. "$SCRIPT_DIR/common.sh"

ROOT=$(repo_root)
VERSION=24.21.0
ARCHIVE="node-v$VERSION-linux-x64.tar.xz"
URL="https://nodejs.org/dist/v$VERSION/$ARCHIVE"
EXPECTED_ARCHIVE_SHA256=fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6
EXPECTED_BINARY_SHA256=7fde7b8afa198da66257f42ee2001d874c7355631e6d1579a5fb5ef1f246df4c
DEST="$ROOT/vendor/payloads/linux-x64/node"
TMP=$(mktemp -d "${TMPDIR:-/tmp}/agentstack-node.XXXXXX")
trap 'rm -rf "$TMP"' EXIT HUP INT TERM

curl --fail --location --proto '=https' --tlsv1.2 "$URL" -o "$TMP/$ARCHIVE"
verify_sha256 "$TMP/$ARCHIVE" "$EXPECTED_ARCHIVE_SHA256"

rm -rf "$DEST"
mkdir -p "$DEST/bin"
tar -xJf "$TMP/$ARCHIVE" -C "$TMP" "node-v$VERSION-linux-x64/bin/node"
install -m 0755 "$TMP/node-v$VERSION-linux-x64/bin/node" "$DEST/bin/node"
verify_sha256 "$DEST/bin/node" "$EXPECTED_BINARY_SHA256"

printf 'Fetched Node.js %s (linux-x64) to %s\n' "$VERSION" "$DEST"
