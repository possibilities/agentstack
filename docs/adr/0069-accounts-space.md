# 69. An Accounts space beside Fleet, joined by card links

Status: accepted, 2026-09-26. Moves the Accounts, Usage and Models windows out
of Fleet ([ADR 0056](0056-fleet-usage-catalogs-and-bot-controls.md),
[ADR 0067](0067-one-accounts-window-and-bare-empty-states.md)) into a second
Canvas space on the open bench of
[ADR 0058](0058-open-bench-and-global-tools.md). Replaces the Bot-to-account
wires of ADR 0067 with links.

## Decision

The bench has two spaces. **Fleet** (`/x/fleet`, key 1) holds Bots and is
where upcoming Fleet work lands. **Accounts** (`/x/accounts`, key 2) is a
self-contained dashboard of accounts, usage limits and Worker model catalogs:
the `accounts`, `usage` and `model-catalogs` windows, side by side. `account`,
`worker-account`, `login`, `usage`, `usage-account`, `grok-bot-usage` and
`worker-catalog` destinations now name the Accounts space; `bot` stays in
Fleet. `/x` still opens Fleet.

A relationship between cards in different spaces is a link on the card, not a
wire. A Bot card's account and an account card's Bot chips are real links
(`NodeLink`): a plain click pans to the record in its own space, updates the
Spaces menu and URL, and keeps inspection; a modified click keeps the browser's
own behavior. Relationship wires are drawn only when both ends share a space,
so long curves never cross the gap between regions.

Attention follows the records: Bot recovery and the `bots` channel mark Fleet;
unfinished removals, pending sign-ins, a failed sign-in and the `auth`, `usage`
and `workers` channels mark Accounts.

## Consequences

Fleet is intentionally sparse until its next windows arrive. With no Bot and
account in one space, no wires currently render; the mechanism stays for
same-space relationships. A bench layout saved before this change keeps each
moved window's manual local position, now relative to the Accounts region;
Reset window positions (T) repacks it.
