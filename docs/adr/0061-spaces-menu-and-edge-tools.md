# 61. A Spaces menu apart from edge-anchored tools

Status: accepted, 2026-09-26. Amends the top bar and System dock from
[ADR 0058](0058-open-bench-and-global-tools.md).

## Decision

The top bar separates places from tools. Spaces are places: a Spaces menu shows
the current space's name and lists every registered space with its description,
number-key shortcut and attention, plus "Show all". It scales to many spaces
without widening the bar, and each entry stays a real link. System and API
reference are tools: each toggle sits on the edge where its dock opens — System
at the far left, API at the far right beside search.

The System dock leads with a compact filter and an owner summary (PID, running
children as a segmented bar, read time). Connections and MCP endpoints merge
into one Packages list, one row per package with WebSocket and MCP copy chips
instead of printed URLs. MCP Inspector is a header link while its child runs;
the UI and its reference are not relinked. The reference header is a
breadcrumb (API reference › package › operation) with a compact search, and
operation annotations render as badges.

## Consequences

A new space needs only its `spaces.ts` registration to appear in the menu. A
future minimap or space overview can extend the menu without moving the tools.
