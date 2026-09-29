# Agentstack

Service for local agent processes. Each package exposes a typed Package API on a private Unix socket under `<state>/sockets/`; `agentstack serve` supervises the package children, shared transport gateways and UI, and serves `serve` status and change events in-process. See the [local trust boundary](docs/security.md) and [quickstart](docs/quickstart.md).

The `bots` Package API also provides [sanctioned Codex chat search, transcript reading, native viewing, and live interaction](docs/chats.md). ACP Worker sessions remain separate.
