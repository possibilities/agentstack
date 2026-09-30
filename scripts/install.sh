#!/bin/bash
set -euo pipefail

repo_root=$(cd -P -- "$(dirname -- "$0")/.." && pwd)
workshops_root="${STACK_WORKSHOPS_ROOT:-$HOME/workshops}"
bin_dir="${STACK_INSTALL_BIN_DIR:-$HOME/.local/bin}"
runtime_installer="$workshops_root/codexnk/scripts/install.sh"
# Exact reviewed runtime dependency; keep AgentStart's shared consumer pin aligned.
release_tag=codexnk-v0.1.7
integration_sha=3aae20d1ad1d41734b7303b4f0a4bfe95eb56d8c
mode="${1:---check}"
if [ "$#" -gt 1 ]; then mode=invalid; fi
case "$mode" in
    --check)
        printf 'Install required %s (%s) through %s.\n' "$release_tag" "$integration_sha" "$runtime_installer"
        printf 'Build Stack and link %s/stack. No services started or restarted.\n' "$bin_dir"
        printf 'Remote UI stays disabled until STACK_ACCESS_HOST, STACK_ACCESS_UI_ORIGIN, TLS key/cert and distinct Access ports are configured.\n'
        exit 0
        ;;
    --install) ;;
    *) printf 'Usage: scripts/install.sh [--check|--install]\n' >&2; exit 64 ;;
esac
[ "$(id -u)" -ne 0 ] || { printf 'Run as the target user, not root.\n' >&2; exit 1; }
[ -x "$runtime_installer" ] || {
    printf 'Required codexnk installer is missing: %s. Check out codexnk under the Workshops root.\n' "$runtime_installer" >&2
    exit 1
}
target="$bin_dir/stack"
if [ -e "$target" ] || [ -L "$target" ]; then
    [ -L "$target" ] && [ "$(readlink "$target")" = "$repo_root/bin/stack" ] || {
        printf 'Refusing to replace an independent command: %s\n' "$target" >&2
        exit 1
    }
fi
# Relocated workshop installs are test facilities, not Stack runtime choices.
expected_runtime="$HOME/.local/libexec/codexnk/codex"
[ "$("$runtime_installer" --print-bin)" = "$expected_runtime" ] || {
    printf 'codexnk must install Stack runtime at %s; unset CODEXNK_INSTALL_ROOT.\n' "$expected_runtime" >&2
    exit 1
}
"$runtime_installer" --install --tag "$release_tag" --sha "$integration_sha"
[ -f "$expected_runtime" ] && [ -x "$expected_runtime" ] || {
    printf 'Required runtime was not installed: %s\n' "$expected_runtime" >&2
    exit 1
}
cd "$repo_root"
pnpm install --frozen-lockfile
pnpm build
mkdir -p "$bin_dir"
ln -sfn "$repo_root/bin/stack" "$target"
printf 'Installed Stack with required %s. Running processes were not restarted.\n' "$release_tag"
