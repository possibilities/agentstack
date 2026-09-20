# AgentStack context

**AgentStack daemon**

The single OS-managed foreground process that directly owns Codex app-server. It owns its pipes, process handles, readiness, bounded recovery, and private control socket.

_Avoid: core, host, broker, server fleet_

**Engine**

One pinned, product-owned native executable supervised by the AgentStack daemon. Milestone one has exactly `codex`.

_Avoid: provider, when referring to the local process_

**Readiness**

Protocol evidence that a running engine answered its documented initialize exchange, or a stable `auth-required`, `incompatible`, or `unavailable` reason. A PID alone is not readiness.

_Avoid: healthy, when only process existence is known_

**Control socket**

The same-user Unix socket under `$XDG_RUNTIME_DIR/agentstack` that exposes `agentstack.control.v1` status and explicit child restart operations. It is not a product API or raw engine proxy.

**Release root**

The immutable `/usr/lib/agentstack/releases/<version>` directory resolved once by a running process. `current` selects the installed release for new processes.

**Debian qualification host**

An explicitly authorized Debian installation used to qualify an exact public release. AgentStack owns its consumer installer and workload lifecycle; the host owns generic operating-system setup.

_Avoid: test VM, AgentStack host service_
