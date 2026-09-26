# 62. Uniform usage limits and Grok Bot on the Grok Worker card

Status: accepted, 2026-09-26. Amends the Usage window presentation from
[ADR 0056](0056-fleet-usage-catalogs-and-bot-controls.md); the `usage` Package
API from [ADR 0044](0044-owner-usage-observations.md) is unchanged.

## Decision

A Usage card reads "Limit" whenever its account cannot continue: Codex's own
limit flag, Grok Bot's unavailable usage, or any exhausted (0% remaining)
window for Devin, Claude and a Grok Worker without pay-as-you-go. Devin with
daily quota but an exhausted weekly quota therefore matches Codex instead of
showing a red "0%".

When the snapshot holds exactly one Grok Worker account and it has a
measurement, the machine's Grok Bot usage is a "bot" gauge on that card, and
the card's freshness shows the worse of the two observations. The gauge label
still inspects the Grok Bot record. With no Grok Worker account, or several,
Grok Bot keeps its own card titled "Grok Bot". The invented
`grok-bot-account-1` label is retired.

## Consequences

This is a presentation choice by the human, not an identity claim: the `usage`
API still does not correlate Grok Bot with a Worker account. If a second Grok
Worker account is added, Grok Bot separates again rather than guessing.
