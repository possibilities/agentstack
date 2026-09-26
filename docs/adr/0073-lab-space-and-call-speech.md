# 73. A Lab space for experiment windows, starting with Call speech

Status: accepted, 2026-09-26. Adds a third Canvas space to the open bench of
[ADR 0058](0058-open-bench-and-global-tools.md), beside Fleet and Accounts
([ADR 0069](0069-accounts-space.md)). Builds on the main-thread voice call of
[ADR 0028](0028-main-thread-voice-call.md).

## Decision

**Lab** (`/x/lab`, key 3) is where experimental windows land while an idea is
being tried. A Lab window may be rough, narrowly scoped or short-lived; it uses
the ordinary `WindowDef` registration and Window chrome, and it can later be
promoted to a proper space or removed without affecting Fleet or Accounts.
Lab owns no record destinations, so `homeOf` is unchanged and links never pan
there; it reports no attention.

The first experiment is **Call speech** (`call-speech`). It shows the Bots
API's open voice call from `voice_status` — at most one — with its Bot, call
and thread, and offers text to that exact call through `voice_speak`, so the
call's realtime voice says it. Sending is allowed only while the call is
connected and the `bots` channel is open. Enter sends trimmed text once;
Shift+Enter adds a line. A failure is shown in place and never retried, since
an uncertain submission may already have been spoken. The window keeps the
page's recent submissions, labelled as accepted rather than heard, and a click
reuses one's text.

## Consequences

Three spaces pack as a triangle. `voice_speak` was already reachable through a
Bot's operation workbench; Call speech is a quicker surface for trying it and
does not replace that form. Submissions are page-local and vanish on reload.
