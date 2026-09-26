# 66. Observe Grok Bot usage only beside a signed-in Grok Worker

Status: accepted, 2026-09-26. Amends [ADR 0044](0044-owner-usage-observations.md),
which observed the machine's Grok Bot login unconditionally, and the
standalone Grok Bot card of
[ADR 0062](0062-usage-limits-and-grok-bot-card.md).

## Decision

The `usage` observer reads the machine's Grok Bot CLI login the same way
(`agentgrok usage --json`), but only while at least one signed-in (ready),
non-removing Grok Worker account is in auth's inventory. Otherwise it does
not run the CLI, forgets any last reading, and `usage_snapshot.grokBot` is
`null`. When a Grok Worker becomes ready, the next cycle reads Grok Bot at
once; a reading from before the gap is never shown again.

In the Usage window, Grok Bot therefore appears only when there is a Grok
Worker to reference: as the "bot" gauge on the only Grok Worker's card, or as
its own card when there are several (ADR 0062). It no longer appears, or
counts toward the window's total, on a machine with no signed-in Grok Worker.

## Consequences

The Grok Bot login is still not identified with any Worker account; the
Grok Worker is only the reason to observe it. Clearing AgentStack's accounts
now clears Grok Bot from AgentStack's view without signing the CLI out.
