# 57. Make the canvas the UI home

Status: accepted, 2026-09-25. Supersedes the separate root index in [ADR 0016](0016-live-ui-index-and-system-theme.md); extends [ADR 0042](0042-canvas-spaces.md).

The root index duplicated information already held by the live canvas. `/` now permanently redirects to `/x` (Fleet), and its separate component and data projection are removed. The owner still reports the app entry in `indexUrl` and the direct canvas location in `uixUrl`; neither URL requires a second rendering. Startup output calls the root URL “UI entry.”

The parity audit maps every root-page item to its canvas home:

| Root content | Canvas home |
| --- | --- |
| UI canvas link | The entry redirect opens Fleet; the space links navigate the canvas. |
| API reference and MCP Inspector links | System → Surfaces, with full URLs. Inspector is linked only while its child reports running. |
| Package API MCP URLs | System → MCP endpoints, with full, copyable URLs. |
| Running owner children and PIDs | System → Processes, which also shows stopped and failed children. |
| Running Bot IDs, PIDs, workspaces, endpoints, and recovery warnings | Fleet → Bots, with full, copyable paths and endpoints. Stopped Bots remain visible too. |
| Unavailable data | Existing window errors and empty states; live subscriptions refresh recovered data. |
| Refresh link | Browser reload refreshes the server snapshot; the canvas also refreshes on live change notices. |

The redundant Runtime index surface link is removed. Record inspection continues to expose all fields, including owner URLs. Verification covers the redirect and retained information under isolated socket fixtures, including an unavailable owner and a stopped Inspector. No live owner rebuild or restart is part of this route change.
