# 115. Name the process package Serve and the canvas package UI

Status: accepted, 2026-09-28. This is a naming cutover of the process and canvas, not a change to their lifecycle or permissions.

The process package lives in `packages/serve` as `@stack/serve`. Its Package API is named `serve`, with `serve_status`, `serve_resources`, `serve_resource_history`, `serve_local_connect`, and `serve_local_revoke` on `serve.sock` and the corresponding MCP and WebSocket addresses. Describe the process as the **server** or **service**; ownership still means actual possession or authority over a resource, process, Bot, Worker, or record. Resource observations use the server component and `server_tree` / `server_missing` wire values. The private Bot MCP port setting is `STACK_SERVER_MCP_PORT`.

The Next.js package lives in `packages/ui` as `@stack/ui`. The required child, local bootstrap target and audience, local port setting, remote Access origin and port settings, headers, cookies, response URL and Access scopes use `ui` rather than `uix`. On startup, Access migrates existing pairing and grant scope arrays from `uix:view` / `uix:control` to `ui:view` / `ui:control`, increasing affected grant revisions once, and moves existing session rows to the renamed table. UI browser-local storage keys remain `stack.uix.*` so a new build retains saved arrangements and drafts; these are private persistence keys, not the current product name or a public API.

Old socket paths, operation names, environment variables, and bootstrap targets are not aliases. Clients and operator configuration must move to the new names together at an authorized rebuild and server restart. Earlier ADR filenames and historical descriptions retain the names in effect when those decisions were accepted.
