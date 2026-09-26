# 16. Use the UI root for live local links

Status: accepted, 2026-09-24. Extends [ADR 0013](0013-owner-managed-ui-canvas.md): its canvas now lives at `/x` rather than the app root.

The separate root index is superseded by [ADR 0057](0057-canvas-as-ui-home.md). The system appearance policy remains in effect.

The owned Next.js app serves a live index at `/`, reading `owner_status` and
Codex `server_list` over local sockets for every request. The owner reports
the actual index, docs, Inspector, MCP, and canvas URLs, including dynamically
allocated ports, instead of the page reconstructing them from defaults. The
index shows running processes and Codex Servers and treats an unavailable
socket as unavailable state rather than inventing data. `/x` stays blank for
experiments. CSS follows `prefers-color-scheme` on both routes without client
theme state or a visible switch. The existing `/docs` stylesheet already follows
the same system preference, including when discovery is unavailable.
