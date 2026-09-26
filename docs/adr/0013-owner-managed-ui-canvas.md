# 13. Run the standalone UI canvas with the owner

Status: accepted, 2026-09-24. Complements [ADR 0009](0009-serve-docs-with-owner.md): the Package API reference remains an in-process, live-generated listener.

[ADR 0058](0058-open-bench-and-global-tools.md) later moves that reference into UIX and retires its separate listener. This app lifecycle and restart boundary remain in force.

`packages/uix` is a standalone Next.js experiment canvas. `agentstack serve`
starts its built app as a required child, bound only to loopback on
`AGENTSTACK_UIX_PORT` (8745 by default). The owner prints and reports its URL,
stops its process group on shutdown, and shuts down if the child exits. Keeping
the canvas on its own listener lets Next.js serve its assets and future routes
without teaching the docs listener to proxy them. The installation build
prepares `.next`; changing an experiment requires a rebuild and an authorized
owner restart to appear in the owned app.
