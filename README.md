# Agentstack

Process owner for local agent servers. Each package exposes a typed Package API on a private Unix socket under `<state>/sockets/`; `agentstack serve` owns the `api`, `auth`, `roles`, `bots`, and `workers` children and serves `owner` status and change events in-process.

The `bots` Package API also provides [sanctioned Codex chat search, transcript reading, native viewing, and live interaction](docs/chats.md). ACP Worker sessions remain separate.
