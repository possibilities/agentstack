# 0004: Session-scoped systemd user service and one Debian artifact

Status: accepted 2026-09-20.

Install one `.deb` under `/usr/lib/agentstack/releases/<version>`, select it with `current`, expose only `/usr/bin/agentstack`, and install a `systemd --user` unit without enabling it globally. The unit uses `Restart=on-failure`, `KillMode=mixed`, `UMask=0077`, and `RuntimeDirectory=agentstack`.

The product CLI performs explicit per-user enablement. It never enables linger, edits homes from root maintainer scripts, or falls back to a system service. Qualification installs an exact checksummed public GitHub Release through the consumer-owned installer; local package copies do not satisfy release qualification.
