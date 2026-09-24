# 24. Make the first canvas experiment a live, read-only workbench

Status: accepted, 2026-09-24. Extends [ADR 0013](0013-owner-managed-ui-canvas.md), [ADR 0016](0016-live-ui-index-and-system-theme.md), and [ADR 0019](0019-markdown-twins.md). `/x` is no longer blank.

The separate Servers window and Bot-to-Server curves were superseded by [ADR 0029](0029-bots-own-codex-lifecycle.md); this paragraph records the original canvas design.

`/x` renders every Package API as windows on a pannable canvas: System (`owner_status`), Accounts and device sign-in (`account_list`, `account_login_current`), Servers (`server_list`), Bots (`bot_list`), an Activity feed of change notices, and the discovery catalog. Each record is a card; relationship curves join Servers to their assigned or running accounts and Bots to their Servers. A grid mode lays the same windows out as masonry columns, and window arrangement is kept in the browser's local storage.

The server renders one socket snapshot so the first paint is complete. The browser then connects directly to the loopback WebSocket URLs reported by discovery, re-reads state on each (re)connection, and re-reads the affected list on every notice. Each Server gets its own scoped subscription (`bots` for Bots, `codex` otherwise) so thread activity is attributed to one card. An ephemeral WebSocket port has no discoverable URL, so the page then stays at its server snapshot.

The canvas calls only read-only operations. The inspector lists the operations that act on a record, with their annotations and schemas, as the place later experiments add controls. The markdown twin renders the same snapshot.
