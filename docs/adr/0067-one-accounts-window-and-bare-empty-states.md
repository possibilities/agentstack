# 67. One Accounts window and bare, fitted empty states

Status: accepted, 2026-09-26. Supersedes the separate Bot accounts and Worker
accounts windows, their creation menus and the Bot–Worker connector of
[ADR 0049](0049-canvas-worker-account-controls.md), and the "Paired with"
chips of [ADR 0065](0065-codex-workers-paired-with-bot-accounts.md).

## Decision

Fleet shows every account in one **Accounts** window (`accounts`), grouped
by provider. Under Codex, each Codex Bot account and its paired Codex Worker
account are drawn as one joined card, so the pairing needs no wire or chip;
they remain separate `account` and `worker-account` records with their own
inspection, status and sign-in. An unpaired older Codex Worker follows the
pairs. Grok, Devin and Claude Worker accounts follow in their own sections.
The header's single **Add account** menu offers Codex (a Bot account and its
Worker), Grok, Devin and Claude. Every account card uses one status badge:
Disabled, else Needs sign-in, else Ready.

Fleet windows share one set of conventions: a creation action, when a window
has one, is a labelled outline button in its header; a window's list has no
trailing add row; and an empty window shows only its icon and a short title,
"No accounts" or "No bots" ("Accounts unavailable", "Bots unavailable",
"Usage unavailable" before data arrives). Read errors are reported in the
window header's status, not in the body. An empty window fits its
placeholder, treating a height the human set as a ceiling, and returns to
that height once it has records.

## Consequences

Bot-to-account wires remain, now ending in the Accounts window. Bench layout
still packs by each window's configured footprint, so a shrunken window can
leave space below it. This consciously sets aside the fleet guidance that
empty states explain the next step: the header button is that step.
