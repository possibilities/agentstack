#!/bin/sh

set -eu

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
. "$SCRIPT_DIR/common.sh"

ROOT=$(repo_root)
EXPECTED_COMMIT=e639de6aded41ae168a8888b920ff71db41877d0
EXPECTED_ZIG=0.16.0
EXPECTED_LINUX_NATIVE_SHA256=ce9837da78ff43181c7e180626d39582ea715cb246f1ba29dad68588308bd1ba
EXPECTED_DARWIN_CROSS_SHA256=3926591e083eed79330c8de74031c4a4679ea60ee1421e09128b35420f120e09
TARGET=x86_64-linux-musl
DEST="$ROOT/vendor/payloads/linux-x64/fx"

case "$(uname -s)" in
  Linux)
    if [ "$(uname -m)" != x86_64 ]; then
      printf 'Fx release build requires Linux x86_64; got %s\n' "$(uname -m)" >&2
      exit 1
    fi
    EXPECTED_BINARY_SHA256=$EXPECTED_LINUX_NATIVE_SHA256
    QUALIFICATION=release-linux-native
    ;;
  Darwin)
    if [ "$(uname -m)" != arm64 ]; then
      printf 'Fx diagnostic cross-build requires Darwin arm64; got %s\n' "$(uname -m)" >&2
      exit 1
    fi
    EXPECTED_BINARY_SHA256=$EXPECTED_DARWIN_CROSS_SHA256
    QUALIFICATION=development-darwin-cross-build
    ;;
  *)
    printf 'Unsupported Fx build host: %s\n' "$(uname -s)" >&2
    exit 1
    ;;
esac

if [ "$#" -ne 1 ]; then
  printf 'Usage: %s /path/to/possibilities-fx-checkout\n' "$0" >&2
  exit 2
fi

SOURCE=$1
actual_commit=$(git -C "$SOURCE" rev-parse HEAD)
if [ "$actual_commit" != "$EXPECTED_COMMIT" ]; then
  printf 'Fx source must be at %s; got %s\n' "$EXPECTED_COMMIT" "$actual_commit" >&2
  exit 1
fi
if [ -n "$(git -C "$SOURCE" status --porcelain=v1)" ]; then
  printf 'Fx source checkout must be clean\n' >&2
  exit 1
fi
if [ "$(zig version)" != "$EXPECTED_ZIG" ]; then
  printf 'Fx build requires Zig %s; got %s\n' "$EXPECTED_ZIG" "$(zig version)" >&2
  exit 1
fi

TMP=$(mktemp -d "${TMPDIR:-/tmp}/agentstack-fx.XXXXXX")
trap 'rm -rf "$TMP"' EXIT HUP INT TERM

(
  cd "$SOURCE"
  zig build \
    --cache-dir "$TMP/cache" \
    --global-cache-dir "$TMP/global-cache" \
    --prefix "$TMP/stage" \
    -Dtarget="$TARGET" \
    -Doptimize=ReleaseSafe
)

verify_sha256 "$TMP/stage/bin/fx" "$EXPECTED_BINARY_SHA256"
rm -rf "$DEST"
mkdir -p "$DEST/bin"
install -m 0755 "$TMP/stage/bin/fx" "$DEST/bin/fx"

printf 'Built Fx %s (%s, %s) from %s to %s\n' \
  "$EXPECTED_COMMIT" "$TARGET" "$QUALIFICATION" "$SOURCE" "$DEST"
