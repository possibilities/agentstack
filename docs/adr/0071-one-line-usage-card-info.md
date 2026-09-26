# 71. At most one info line on a Usage card

Status: accepted, 2026-09-26. Amends the always-visible sample age of
[ADR 0063](0063-usage-subscription-end-and-sample-age.md).

## Decision

Below its meters a Usage card shows at most one line, and none when there is
nothing to add. The line holds the provider notes (reset credits, Grok
allowances, Devin or Claude credits), then a stale sample age, then the
subscription end on the right. Notes truncate first, with the full text on
hover; whole dollar amounts drop their cents.

A fresh sample's age (five minutes or newer) moves into the freshness dot's
tooltip, which lists every sample behind the card. A stale or missing sample
still shows "updated 7h ago" on the card, so the case ADR 0063 guarded
against, an old value hidden behind a dot, stays visible.

## Consequences

Cards with fresh data and no notes are two rows shorter. Reading an exact
fresh sample time takes a hover.
