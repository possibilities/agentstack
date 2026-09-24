# 19. Serve markdown twins from the local pages

Status: accepted, 2026-09-24. Extends [ADR 0009](0009-serve-docs-with-owner.md) and [ADR 0016](0016-live-ui-index-and-system-theme.md).

Both loopback HTTP surfaces serve a markdown twin of every page at the page URL with `.md` appended, using `index.md` for filename-less URLs: `/index.md` and `/x.md` on the UI app, `/docs/index.md` (also reachable as `/docs.md`, and `/index.md` or `/.md` when the reference runs standalone at `/`). Unknown `.md` paths still 404.

Twins render the same live data as their HTML pages — owner status, Codex Servers, and MCP URLs on the index; the discovery catalog on the reference — so they stay current without a second content source, and share the page's `no-store`, loopback-only, read-only posture. HTML pages point at their twin with `rel="alternate" type="text/markdown"`, as a link element and `Link` header where the surface supports it. An unavailable discovery socket answers `503` in markdown rather than a stale document.
