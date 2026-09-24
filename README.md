# Agentstack

Process owner for local agent servers. Each package exposes a typed Package API on a private Unix socket under `<state>/sockets/`; `agentstack serve` owns the `api`, `auth`, `codex`, and `bots` children and serves `owner` status and change events in-process.
