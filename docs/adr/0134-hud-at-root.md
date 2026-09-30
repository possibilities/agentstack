# 134. Land on the HUD space

Status: accepted, 2026-09-29. Changes the landing space of
[ADR 0116](0116-ui-at-root.md) from Fleet to the HUD space of [ADR 0133](0133-hud-space.md).

## Decision

`/` serves HUD, the shared Work surface, and it is first in the Spaces menu. Fleet moves
to `/fleet`; its key (`1`), windows and controls are unchanged. `/hud` is not an alias:
as for every landing space, only the root addresses it and `/hud` is not found.
Links built from node destinations (`goTo`, `spaceHref`, `?focus=`) follow the new
paths automatically. The authenticated Access UI origin forwards `/fleet` and no
longer forwards `/hud`.

## Consequences

A human opening Stack sees what the team is trying to accomplish and what needs them
before the Bots that do it. Bookmarks to `/` now open HUD; a Fleet deep link is
`/fleet?focus=…`. As ADR 0116 decided for `/x`, nothing redirects from
the earlier address. Each space keeps its own camera and window
state, so moving the landing space loses no arrangement.
