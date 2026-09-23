#!/bin/bash
set -euo pipefail

repo_root=$(cd -P -- "$(dirname -- "$0")/.." && pwd)
code_root="${AGENTSTACK_CODE_ROOT:-$HOME/code}"
bin_dir="${AGENTSTACK_INSTALL_BIN_DIR:-$HOME/.local/bin}"
runtime_installer="$code_root/codexnk/scripts/install.sh"
# Exact reviewed runtime dependency; keep AgentStart's shared consumer pin aligned.
release_tag=codexnk-v0.1.1
integration_sha=2945e58e2fb751dcaa1957f594bbef50fbd78392
mode="${1:---check}"
if [ "$#" -gt 1 ]; then mode=invalid; fi
case "$mode" in
    --check)
        printf 'Install required %s (%s) through %s.\n' "$release_tag" "$integration_sha" "$runtime_installer"
        printf 'Build AgentStack and link %s/agentstack. No services started or restarted.\n' "$bin_dir"
        exit 0
        ;;
    --install) ;;
    *) printf 'Usage: scripts/install.sh [--check|--install]\n' >&2; exit 64 ;;
esac
[ "$(id -u)" -ne 0 ] || { printf 'Run as the target user, not root.\n' >&2; exit 1; }
[ -x "$runtime_installer" ] || {
    printf 'Required codexnk installer is missing: %s. Check out codexnk beside AgentStack.\n' "$runtime_installer" >&2
    exit 1
}
target="$bin_dir/agentstack"
if [ -e "$target" ] || [ -L "$target" ]; then
    [ -L "$target" ] && [ "$(readlink "$target")" = "$repo_root/bin/agentstack" ] || {
        printf 'Refusing to replace an independent command: %s\n' "$target" >&2
        exit 1
    }
fi
# Relocated workshop installs are test facilities, not AgentStack runtime choices.
expected_runtime="$HOME/.local/libexec/codexnk/codex"
[ "$("$runtime_installer" --print-bin)" = "$expected_runtime" ] || {
    printf 'codexnk must install AgentStack runtime at %s; unset CODEXNK_INSTALL_ROOT.\n' "$expected_runtime" >&2
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
ln -sfn "$repo_root/bin/agentstack" "$target"
printf 'Installed AgentStack with required %s. Running processes were not restarted.\n' "$release_tag"
