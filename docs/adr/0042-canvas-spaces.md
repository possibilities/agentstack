# 42. Organize the canvas into spaces

Status: accepted, 2026-09-25. Extends [ADR 0024](0024-live-canvas-workbench.md). Supersedes the UI app's `/index.md` and `/x.md` twins from [ADR 0019](0019-markdown-twins.md).

One canvas holding every window stopped scaling: unrelated windows competed for the same plane, and the UI is expected to grow many times over (subagents, single-conversation views, richer references). A person usually works on one concern at a time and jumps between them. The canvas is therefore split into **spaces**, each an independent canvas of related windows: **Fleet** (Accounts and Bots, and later subagents), **System** (owner, processes, surfaces, MCP endpoints, and the Activity feed), and **API** (the Package API reference).

A space is a view, not a separate page or connection. `/x/<space>` selects one (`/x` is Fleet) and an optional `?focus=<node key>` lands on a card, so any card is linkable. The browser keeps one store, one set of WebSocket subscriptions, one voice call, one auth flow, and one inspector across spaces; switching only swaps the mounted windows, uses history `pushState`, and never refetches the server snapshot or reconnects. A live call therefore survives moving around. Only the active space's windows mount, which keeps a large canvas responsive. Each space keeps its own window arrangement, view, and canvas/grid mode in local storage; the pre-space arrangement is discarded once.

Every node kind has one home space and window (`lib/stack/spaces.ts`). Focusing a node from anywhere — the palette, an Activity row, an inspector link, or a URL — switches to its home space and pans to it. Relationship curves stay within a space. The top bar lists spaces as ordinary links, with `1`–`3` shortcuts and a palette group.

With room of its own, the API reference is no longer one dense window. A Packages index summarizes every Package API and its live channel; each package gets its own window with transports, events and their notice counts, and its operations grouped into reads and actions, each card showing its description and input parameters. Full schemas and a request frame remain in the inspector. Windows may be derived from live data, so a package appearing in discovery adds a window.

The UI app no longer serves markdown twins. `/x.md` would have had to split per space and was a second rendering kept in step with every change; `/index.md` went with it so the app has one rendering path. The reference's `/docs/index.md` remains.

Adding a space, or a window to one, is new UI and still follows the repository rule that UI is added only on explicit request.
