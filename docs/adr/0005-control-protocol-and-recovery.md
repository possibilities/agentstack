# 0005: Private bounded control and deterministic recovery

Status: accepted 2026-09-20.

Expose `agentstack.control.v1` as HTTP/1.1 JSON over a same-user Unix socket. Milestone one supports status and explicit per-child restart. Status carries the validated `agentstack.system.v1` component inventory so future daemon and worker packages can contribute safe identity, status, capabilities, and preference metadata to the System surface. The Fx/Codex map is a derived convenience view. Frames are bounded, paths reject symlinks and foreign ownership, and clients cannot provide launch specifications or raw engine requests.

Unexpected child exits receive bounded exponential retry. Stable authentication and incompatibility results remain visible without crash loops. Every launch has a generation UUID so late events from an old process cannot update a replacement.
