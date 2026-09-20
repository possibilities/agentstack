#!/bin/sh

set -eu

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
. "$SCRIPT_DIR/common.sh"

ROOT=$(repo_root)
VERSION=0.16.0
ARCHIVE="zig-x86_64-linux-$VERSION.tar.xz"
URL="https://ziglang.org/download/$VERSION/$ARCHIVE"
EXPECTED_ARCHIVE_SHA256=70e49664a74374b48b51e6f3fdfbf437f6395d42509050588bd49abe52ba3d00
DEST="$ROOT/vendor/toolchains/zig-linux-x64"
TMP=$(mktemp -d "${TMPDIR:-/tmp}/agentstack-zig.XXXXXX")
trap 'rm -rf "$TMP"' EXIT HUP INT TERM

curl --fail --location --proto '=https' --tlsv1.2 "$URL" -o "$TMP/$ARCHIVE"
verify_sha256 "$TMP/$ARCHIVE" "$EXPECTED_ARCHIVE_SHA256"
rm -rf "$DEST"
mkdir -p "$DEST"
tar -xJf "$TMP/$ARCHIVE" -C "$DEST" --strip-components=1
test "$("$DEST/zig" version)" = "$VERSION"
printf '%s\n' "$DEST/zig"
