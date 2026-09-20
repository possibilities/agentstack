# Debian qualification

Qualification records the target `/etc/os-release`, architecture, systemd version, `loginctl show-user … -p Linger`, immutable public release tag, package SHA-256, release-manifest identity, installed file hashes, product and engine versions, and UTC timestamps. Evidence is compact and redacted. The first live install for a version must use `scripts/install-host` against the exact GitHub Release; a locally copied package is development evidence only.

The live sequence installs the `.deb`, activates the ordinary user's unit, and proves:

1. one loaded user unit with `Restart=on-failure` and `KillMode=mixed`;
2. one AgentStack daemon directly parenting one Fx and one Codex process;
3. a mode-0700 runtime directory and mode-0600 control socket;
4. Codex initialize/initialized readiness and Fx ACP initialize or stable `auth-required`, without a prompt or provider inference;
5. killing one child changes only that child's PID and generation;
6. restarting the unit removes all old children and creates new generations;
7. forced daemon failure leaves no old owned children and systemd starts a fresh tree;
8. no TCP listener, global command replacement, linger change, or user-state deletion.

An SSH session kept open for evidence invalidates a claim that the user manager stopped after last logout. Report that exact limit unless a separate authorized observer proves it.
