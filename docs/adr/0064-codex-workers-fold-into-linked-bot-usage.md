# 64. Codex Workers fold into their linked Bot's usage card

Status: accepted, 2026-09-26. Amends the Usage window card grouping of
[ADR 0063](0063-usage-subscription-end-and-sample-age.md); the `usage`
Package API is unchanged.

## Decision

A Codex Worker account linked by native identity to an observed Codex Bot
account always shares that Bot's Usage card, even when their two
measurements differ. The Bot leads the card: its measurement, freshness,
sample time and subscription end are what the card shows, and the Worker
appears only as the card's secondary name so links to its usage record still
land. A Worker keeps its own card only while its linked Bot is unobserved and
it is not. An unobserved Worker linked to a Bot is not listed separately
under "Not observed".

Previously a linked pair shared a card only when their measurements matched
exactly, so ordinary sampling skew showed one ChatGPT login as two cards.

## Consequences

Both accounts consume one login's quota, so the Worker's own measurement adds
no information on the card. It remains in `usage_snapshot` and in the
Worker's inspector record. This supersedes ADR 0063's "oldest measurement of
a linked row" for the card's sample time.
