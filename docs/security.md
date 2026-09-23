# Local trust boundary

Agentstack is designed for one trusted local user account. Its Package API and Codex app-server control sockets live in mode `0700` state directories and use mode `0600` sockets. Anyone who can act as that OS user or read its state directory can control these local processes. Do not place the state directory on a shared filesystem.

The embedded UI binds to `127.0.0.1`. It accepts only the exact loopback Host and port it opened, and requires a random admission token before issuing an HttpOnly, SameSite=Strict cookie. Its WebSocket upgrade path applies the same Host and cookie checks. Keep the printed admission URLs private; the token grants access for that UI run. The package event WebSockets also bind to loopback and accept the configured UI Origin. They are local status feeds, so another process under the same OS user can still reach them.

These controls address cross-site requests and DNS rebinding from a browser. They do not provide isolation between mutually untrusted processes running as the same OS user. Agentstack should not be exposed through a public reverse proxy or a shared host account without an additional authentication and isolation design.
