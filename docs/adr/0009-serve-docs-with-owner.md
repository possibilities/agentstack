# 9. Serve the Package API reference with the owner

Status: superseded by [ADR 0058](0058-open-bench-and-global-tools.md), 2026-09-25. Accepted 2026-09-24. Supersedes [ADR 0006](0006-live-package-api-reference.md)'s separate-by-default docs process.

`agentstack serve` starts the read-only docs listener alongside its sockets and
required children, and closes it on shutdown. It binds to loopback at an
available port, prints `http://127.0.0.1:<port>/docs`, and accepts an explicit
`AGENTSTACK_DOCS_PORT` when a stable port is useful. Assets and revision checks
remain under `/docs`; page content is read from the running discovery Package
API on each request, and an open page reloads when the document revision
changes. The separate `agentstack docs` command remains available for an
independent reference when needed.

This removes the need to run or restart a second process for normal use. It
also keeps the docs within the owner's lifecycle while preserving the
loopback-only, read-only HTTP boundary. No Portless route or dependency is
needed. Source code changes still enter a running owner only on its next
authorized restart; live Package API documents update without one.
