#!/bin/sh

set -eu

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

verify_sha256() {
  file=$1
  expected=$2
  actual=$(sha256_file "$file")
  if [ "$actual" != "$expected" ]; then
    printf 'SHA-256 mismatch for %s\nexpected: %s\nactual:   %s\n' "$file" "$expected" "$actual" >&2
    exit 1
  fi
}

repo_root() {
  CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd
}
