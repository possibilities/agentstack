#!/bin/sh

set -eu

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
. "$SCRIPT_DIR/common.sh"

ROOT=$(repo_root)
VERSION=0.155.1
TAG=rust-v0.155.1
TARGET=x86_64-unknown-linux-musl
ARCHIVE="codex-app-server-package-$TARGET.tar.gz"
URL="https://github.com/openai/codex/releases/download/$TAG/$ARCHIVE"
EXPECTED_ARCHIVE_SHA256=a1784b0f3991e4853caaddcc167d2bc8c540f12eddb1b5e40b1ec49f2dbcc024
DEST="$ROOT/vendor/payloads/linux-x64/codex"
TMP=$(mktemp -d "${TMPDIR:-/tmp}/agentstack-codex.XXXXXX")
trap 'rm -rf "$TMP"' EXIT HUP INT TERM

curl --fail --location --proto '=https' --tlsv1.2 "$URL" -o "$TMP/$ARCHIVE"
verify_sha256 "$TMP/$ARCHIVE" "$EXPECTED_ARCHIVE_SHA256"

# Refuse absolute paths and parent traversal before unpacking upstream bytes.
if tar -tzf "$TMP/$ARCHIVE" | awk '$0 ~ /^\// || $0 ~ /(^|\/)\.\.($|\/)/ { found=1 } END { exit found ? 0 : 1 }'; then
  printf 'Unsafe archive path in %s\n' "$ARCHIVE" >&2
  exit 1
fi

rm -rf "$DEST"
mkdir -p "$DEST"
tar -xzf "$TMP/$ARCHIVE" -C "$DEST"
chmod 0755 \
  "$DEST/bin/codex-app-server" \
  "$DEST/bin/codex-code-mode-host" \
  "$DEST/codex-path/rg" \
  "$DEST/codex-resources/bwrap" \
  "$DEST/codex-resources/zsh/bin/zsh"

verify_sha256 "$DEST/bin/codex-app-server" 7ad7ed70a8e8f72b5d3202ba65cc55ad3b9ab2914982b74092fe11e3269d910f
verify_sha256 "$DEST/bin/codex-code-mode-host" 416467143642177de5e03734b3be94087a73a7bba058d84e8b1e54e2cd731010
verify_sha256 "$DEST/codex-path/rg" e62198eb19b136b88c330af83647b5a962cb99b6b1f066758568f12de1974849
verify_sha256 "$DEST/codex-resources/bwrap" 77360cb751ccedc5971391444ac86a8a33c15b04d6b4a6fe45f5d25496e62c4c
verify_sha256 "$DEST/codex-resources/zsh/bin/zsh" 67faaaa89242c4a332e16e508a1977cffc24bf7fca31d4411cdfd101f3831ef3

printf 'Fetched Codex app-server %s (%s) to %s\n' "$VERSION" "$TARGET" "$DEST"
