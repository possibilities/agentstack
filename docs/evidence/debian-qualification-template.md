# Debian qualification receipt

This is a blank receipt. Complete it on the authorized Debian host only after
installing the recorded package. Fixture tests and source-checkout runs do not
fill any item below.

## Subject

| Field                                 | Value |
| ------------------------------------- | ----- |
| Operator and date (UTC)               |       |
| Host and ordinary service user        |       |
| `/etc/os-release`                     |       |
| `uname -m`                            |       |
| `systemctl --version`                 |       |
| Package filename and SHA-256          |       |
| Public repository and release tag     |       |
| Release-manifest revision/attestation |       |
| Product version and build identity    |       |
| Codex payload version/hash  |       |
| Authorization reference               |       |

## Package inspection before installation

```sh
gh attestation verify ./agentstack_VERSION_amd64.deb --repo OWNER/REPO
sha256sum --check SHA256SUMS
node scripts/inspect-deb.mjs --package ./agentstack_VERSION_amd64.deb --json
dpkg-deb --field ./agentstack_VERSION_amd64.deb Package Version Architecture
```

Record that the package contains the thin `/usr/bin/agentstack` launcher, one
release under `/usr/lib/agentstack/releases/VERSION`, its bundled `licenses/`,
`current` pointing to that release, the user unit, documentation, and no
maintainer scripts. Record that there are no files in `/usr/local`, `/etc`,
`/var`, `/home`, or `/run`.

## Install and session service

```sh
scripts/install-host \
  --remote QUALIFICATION_HOST \
  --repository OWNER/REPO \
  --tag vVERSION \
  --expected-sha256 PACKAGE_SHA256 \
  --enable \
  --confirm INSTALL-AGENTSTACK-ON-QUALIFICATION_HOST
agentstack status --json
systemctl --user show agentstack.service \
  --property=Id,LoadState,ActiveState,SubState,Type,Restart,KillMode,UMask
systemctl --user cat agentstack.service
```

Record the command outputs, the service user's UID, and the exact service
tree. Confirm one user unit whose direct daemon child owns the pinned
Codex children. Confirm `KillMode=mixed`, `Restart=on-failure`, `UMask=0077`,
and a 0700 runtime directory. Record `stat -c '%a %U %G %n'` for the runtime
directory and control socket; the socket must be 0600 and same-user owned.

## Engine and recovery proof

Record the real pinned Codex app-server initialization result without creating
a thread or turn. Record the real Codex version and app-server initialization
without inference. If authentication prevents Codex capability initialization,
record `auth-required`, the exact sanitized reason, and leave that capability
unproven.

With disposable owned child processes only, kill one native child and record
that only that child's generation changes, its bounded retry behavior, and the
sibling generation remains stable. Stop and restart the entire service, then
record that all old child processes disappear, new generations appear, and the
runtime directory is recreated safely. Force only the disposable test daemon
to die and record the cgroup cleanup result.

## Session and host boundaries

Record `ss -ltnp` (or equivalent) showing no AgentStack TCP listener,
`loginctl show-user "$USER" -p Linger`, and `command -v codex` before and
after installation. A logout proof requires a separate authorized observer;
an SSH session held open for observation does not prove that the user manager
stops after the last login ends. Record that limitation when no observer is
available.

## Upgrade and removal

Use the documented stop, package upgrade, start sequence. Record installed and
running versions before and after the restart. Remove and purge the package,
then record that `$XDG_CONFIG_HOME/agentstack` and `$XDG_STATE_HOME/agentstack`
remain unchanged. Do not delete state as part of this qualification.
