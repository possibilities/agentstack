# 6. Render the Package API reference from discovery

Status: accepted, 2026-09-23. Builds on [ADR 0001](0001-package-apis.md) and [ADR 0002](0002-private-control-transport.md).

The optional `@agentstack/docs` package renders a local browser reference from the running `api` Package API's `docs_list` and `docs_get` operations. It presents the four current non-discovery packages, their supported socket/WebSocket transports, operations with JSON Schemas, and change-event topics. The page fetches fresh documents on each request and checks for changes while open. No generated copy of the operation definitions is committed.

MDX-first static documentation frameworks would introduce a second content source and a rebuild or export step for these typed, changing contracts. A small dependency-free renderer keeps the discovery API authoritative and permits a reading layout tailored to socket operations rather than presenting them as HTTP routes. The docs command is separate from the required process owner, binds to loopback, and is read-only; it does not proxy operation calls or subscribe to sensitive runtime data.
