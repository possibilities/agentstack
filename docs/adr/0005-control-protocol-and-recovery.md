# 0005: Private bounded control and deterministic recovery

Status: accepted 2026-09-20.

Expose `agentstack.control.v1` as HTTP/1.1 JSON over a same-user Unix socket. Milestone one supports status and explicit per-child restart. Status carries the validated `agentstack.system.v1` component inventory so future daemon and worker packages can contribute safe identity, status, capabilities, and preference metadata to the System surface. The Fx/Codex map is a derived convenience view. Frames are bounded, paths reject symlinks and foreign ownership, and clients cannot provide launch specifications or raw engine requests.

Restart returns a durable-shaped admission receipt immediately; terminal outcome is observed through status. A lost response remains outcome-unknown and must not be blindly retried. Server shutdown has a fixed deadline and aborts incomplete HTTP clients before stopping children. Signal ownership is installed before any child or readiness probe starts.

Unexpected child exits receive bounded exponential retry. Stable authentication and incompatibility results remain visible without crash loops. Every launch has a generation UUID so late events from an old process cannot update a replacement.

Structured logs recursively sanitize token forms, credential assignments, raw URLs and error values before a bounded JSON sink. Launch environments and future validated secret projections are never part of status, System inventory, or logs.

Preference descriptors are inventory only in milestone one. No user-facing JSON, TOML or environment configuration is created. A later versioned SQLite settings contract will combine shipped defaults with sparse user overrides and keep protected secrets in a separate database.
