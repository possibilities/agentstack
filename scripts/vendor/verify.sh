#!/bin/sh

set -eu

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
. "$SCRIPT_DIR/common.sh"

ROOT=$(repo_root)
PAYLOAD="$ROOT/vendor/payloads/linux-x64"

verify_elf_x86_64() {
  file=$1
  description=$(file -b "$file")
  case "$description" in
    *"ELF 64-bit"*"x86-64"*) ;;
    *)
      printf 'Expected an ELF x86-64 executable at %s; got: %s\n' "$file" "$description" >&2
      exit 1
      ;;
  esac
  if [ ! -x "$file" ]; then
    printf 'Expected executable mode at %s\n' "$file" >&2
    exit 1
  fi
}

verify_sha256 "$PAYLOAD/node/bin/node" 7fde7b8afa198da66257f42ee2001d874c7355631e6d1579a5fb5ef1f246df4c
verify_sha256 "$PAYLOAD/codex/bin/codex-app-server" 7ad7ed70a8e8f72b5d3202ba65cc55ad3b9ab2914982b74092fe11e3269d910f
verify_sha256 "$PAYLOAD/codex/bin/codex-code-mode-host" 416467143642177de5e03734b3be94087a73a7bba058d84e8b1e54e2cd731010
verify_sha256 "$PAYLOAD/codex/codex-path/rg" e62198eb19b136b88c330af83647b5a962cb99b6b1f066758568f12de1974849
verify_sha256 "$PAYLOAD/codex/codex-resources/bwrap" 77360cb751ccedc5971391444ac86a8a33c15b04d6b4a6fe45f5d25496e62c4c
verify_sha256 "$PAYLOAD/codex/codex-resources/zsh/bin/zsh" 67faaaa89242c4a332e16e508a1977cffc24bf7fca31d4411cdfd101f3831ef3
verify_sha256 "$PAYLOAD/codex/codex-package.json" 3f9204cd9a7f0278bdcd1ce67876cab8dc6561a35569723b4a10ac11a1417ab1
if [ "$(uname -s)" != Linux ] || [ "$(uname -m)" != x86_64 ]; then
  printf 'Release payload verification requires Linux x86_64; got %s/%s
' "$(uname -s)" "$(uname -m)" >&2
  exit 1
fi
verify_sha256 "$ROOT/vendor/licenses/node-LICENSE.txt" 5888dbb9a1d2b18f2c3e6c5f6af1b39de658372b402a0577b002777f14c62ace
verify_sha256 "$ROOT/vendor/licenses/codex-LICENSE.txt" d17f227e4df5da1600391338865ce0f3055211760a36688f816941d58232d8dc
verify_sha256 "$ROOT/vendor/licenses/codex-NOTICE.txt" 9d71575ecfd9a843fc1677b0efb08053c6ba9fd686a0de1a6f5382fd3c220915
verify_sha256 "$ROOT/vendor/licenses/codex-bubblewrap-LICENSE.txt" 400d38e5cfee181230373a8b02d38f50271a5bf62c62410382efddb8e8b19e22
verify_sha256 "$ROOT/vendor/licenses/codex-ripgrep-LICENSE-MIT.txt" 0f96a83840e146e43c0ec96a22ec1f392e0680e6c1226e6f3ba87e0740af850f
verify_sha256 "$ROOT/vendor/licenses/codex-ripgrep-UNLICENSE.txt" 7e12e5df4bae12cb21581ba157ced20e1986a0508dd10d0e8a4ab9a4cf94e85c
verify_sha256 "$ROOT/vendor/licenses/codex-zsh-LICENCE.txt" d06fdf3ef9b1ec69d6b9e170b0a9516fbad3523261ff1668bde3bfea6e0ef5f5

for binary in \
  "$PAYLOAD/node/bin/node" \
  "$PAYLOAD/codex/bin/codex-app-server" \
  "$PAYLOAD/codex/bin/codex-code-mode-host" \
  "$PAYLOAD/codex/codex-path/rg" \
  "$PAYLOAD/codex/codex-resources/bwrap" \
  "$PAYLOAD/codex/codex-resources/zsh/bin/zsh"
do
  verify_elf_x86_64 "$binary"
done

node -e '
  const fs = require("node:fs");
  const p = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (p.layoutVersion !== 1 || p.version !== "0.155.1" ||
      p.target !== "x86_64-unknown-linux-musl" ||
      p.variant !== "codex-app-server" ||
      p.entrypoint !== "bin/codex-app-server") process.exit(1);
' "$PAYLOAD/codex/codex-package.json"

printf 'Verified pinned Linux x86-64 vendor payloads (Codex-only)\n'
