# 80. Fleet chat windows follow each Bot's main thread

Status: accepted, 2026-09-26. Adds windows to the Fleet space of the open bench
([ADR 0058](0058-open-bench-and-global-tools.md)) and extends the Bots API's
live main-thread projection used by the Bot tools.

## Decision

**Chat windows.** Fleet always has one primary **Chat** window beside Bots. A
Bot card's **Chat** button shows that Bot's main thread in the window already
showing it, or else switches the primary window to it; a ⌘-, Ctrl- or
Shift-click opens another chat window in the next column. Every chat window
has a Bot switcher and a "new chat window" control; additional windows close,
while closing the primary only empties it. Which Bot each window shows is
browser-local (`stack.uix.chats.v1`), restored after hydration, and a
removed Bot's windows are pruned. A chat window is a `chat:<window>` node for
navigation (`homeOf` → its own Fleet window) but has no inspectable record.
Chat windows keep a fixed footprint height (a `WindowDef.fixed` window) and
scroll their own transcript instead of growing with content.

**Transcript.** Only human (`userMessage`) and assistant (`agentMessage`) text
is shown; other native items stay out of the chat for now but remain in the
model, so later work can render them. The look is a terminal harness rather than
chat bubbles: monospace throughout, the human prompt behind a left accent bar,
assistant markdown indented beneath it, a quiet `▣ duration · time` line after
each finished turn, and a block cursor while text streams. A one-line status
bar reports Thinking / Working / Responding with the newest reasoning summary
heading and elapsed time, or the idle, stopped or missing state. The view
follows the end until the reader scrolls up and resumes at the end; earlier
turns page in as the top approaches, holding the reader's distance from the
end. Markdown is split into top-level blocks so streaming re-parses only the
last one.

**Data.** `lib/stack/main-chat.ts` shares one feed per Bot across windows and
lingers 60 s after the last window leaves, so switching back is instant. It
pages `chat_main_items` newest first (enough pages for about 24 entries, then
on demand), merges `chat_main_live` rows by `(turnId, item.id)` in native start
order, and lets canonical history replace drafts (`lib/stack/transcript.ts`).
Its own Bot-scoped subscription keeps high-frequency notices out of the
store's activity log.

**API.** `chat_main_live` accepts `after: { instance, revision }` and then
returns only rows changed since (`reset: false`); a new instance, a revert or a
stale cursor returns the full snapshot with `reset: true`. It reports
`activeTurnStartedAt` and projects reasoning summary and content deltas.
Completions keep their row's position. A Bot-scoped `chat_live_changed` notice,
coalesced to one per 32 ms, replaces polling. Against an older owner the feed
detects the missing topic and field, never sends `after`, and polls
`chat_main_live` while a turn is active.

## Consequences

A stopped Bot's chat shows that it is stopped: `chat_main_items` needs the
running app-server, and presenting rollout history for stopped Bots would need
a separate read. The live projection stays partial and bounded; history is the
authority after each turn completes. The window arrangement is per browser,
not shared.
