# 2. Keep local control on private Unix sockets

Status: accepted, 2026-09-23. Supersedes the Codex transport details in [ADR 0001](0001-package-apis.md).

The Codex Package API remains a typed library served on a namespaced Unix socket. It also publishes lifecycle and thread invalidation events on a loopback WebSocket for its UI. Managed Codex app servers listen on private Unix WebSocket sockets under the state directory. Their thread reads use the normal WebSocket handshake over that socket.

Previously, managed app servers listened on unauthenticated loopback TCP ports. A private state directory and socket permissions give the control plane an OS user boundary. This is a local single-user design, not mutual isolation among processes that run as that user.

The Package API establishes socket ownership before loading persisted server records. A second instance fails without reaping the incumbent's children. The Package API refuses an existing socket path, including a stale path, because probing then unlinking can erase a new owner's live socket. Operators verify and remove a stale path explicitly. The UI separately validates its loopback Host and admits a browser through a random token and cookie.
