# 1. Package APIs are typed libraries served by transport

The original Codex transport description below records the first implementation. [ADR 0002](0002-private-control-transport.md) supersedes its Unix-socket-only and app-server WebSocket details.

Codex start, stop, and list were MCP tools on the codex process. Those operations stay, but packages should not each invent a server. The monorepo needs one place that can later serve the same operations over more than one transport.

A package that offers operations exports a typed library: name, description, input and output schemas, and the call. It also keeps `api.yaml` in that package root, with server-level text for selection and one entry per transport (`socket`, `mcp`, `websocket`). `@agentstack/api` is the only server. `agentstack api <package> <transport>` loads that package and serves the declared composition. The socket path is namespaced by the server name.

Codex is the first server: three operations, unix socket only, at `<state>/sockets/codex.sock`. MCP and websocket can be written down before they run. Codex no longer speaks MCP. Its package UI calls `server_list` on the socket and reads threads from each app-server websocket.

MCP HTTP clients of `server_start`, `server_stop`, and `server_list` have to use the socket.
