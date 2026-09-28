# 103. A Scrape space, and Scrape's operator operations on the local WebSocket

Status: accepted, 2026-09-28. Adds a tenth Canvas space to the benches of
[ADR 0088](0088-isolated-space-benches.md), after the Workers space of
[ADR 0102](0102-workers-space.md), and gives the `scrape` Package API of
[ADR 0090](0090-scrape-package-api.md) its first UI. Revises ADR 0090's statement that live
checks and queue mutations "stay on the local socket", using the independent transport selections
of [ADR 0096](0096-explicit-transport-exposure.md). Leaves remote UIX policy of
[ADR 0101](0101-remote-uix-through-access.md) unchanged.

## Decision

**Scrape** (`/x/scrape`, key 0, a new `scrape` accent) is where the operator tries extractions,
checks preset health and runs the scrape-to-file queue. It has seven windows:

- **Extract** (`scrape-extract`) runs `scrape_fetch` (Page) or `scrape_links` (Links) for one
  URL with an Automatic, Generic or named preset and the operations' optional selectors, limits,
  color scheme and browser session. With Automatic selected, a preview mirrors Scrape's matching
  and warns when a claimed host has no matching pattern, since that URL fails rather than falling
  back; Scrape's answer remains authoritative. Results show the envelope's status, extractor,
  size and digest, page-reported metadata (labelled as such), and a failure's class, retryability,
  message and evidence, with a link to the preset a `malformed_provider_output` names. Content is
  rendered as untrusted Markdown: raw HTML stays text, images are not loaded, and links open only
  on an explicit click in a new tab without a referrer. The window keeps its last 20 runs for this
  page, with results for the newest five.
- **Feeds** (`scrape-feeds`) runs `scrape_feed_discover` over direct public HTTP, including HTML
  archive selectors, and offers **Check for newer**, which repeats the request with the first
  page's validators bound to that page's exact URL. **Parse recorded** runs `scrape_feed_parse` on
  pasted content without network access. Results state that a missing item does not imply deletion.
- **Convert** (`scrape-convert`) runs `scrape_convert_html` on pasted HTML.
- **Presets** (`scrape-presets`) lists presets grouped by the host they claim, with explicit-only
  `*` presets last, and whether a live canary is configured. Configured is not passing. The new
  `preset` node kind has its home here; **Use** chooses a preset in Extract.
- **Status** (`scrape-status`) shows the state root and each optional route executable as present
  or missing, not as proven working.
- **Checks** (`scrape-checks`) runs `scrape_corpus_replay` for every preset or one, and
  `scrape_presets_check` for chosen presets with an optional browser session. A canary run needs
  the egress consent switch. `not_configured` is always shown as neutral, never as a pass.
  The latest replay and canary outcomes are kept for this page only.
- **Queue** (`scrape-queue`) lists jobs from the new read-only `scrape_queue_list` and re-reads it
  on every `scrape_queue_changed` notice. It submits jobs (URL, destination path, summary,
  frontmatter, egress consent) and runs **Process now**. The new `scrape-job` node kind has its
  home here.

Every browser-backed request asks for egress consent (`allowPrivateNetwork`) through a switch that
clears after each run. Consent is never remembered. The space flags attention only when the
`scrape` channel is closed or the browser runtime is missing. Other missing tools affect narrower
routes and are shown only in Status.

`scrape_queue_list` reads the pending, retry and failed directories without claiming, repairing,
retiring or creating state. A job's ID is its generation ID where one can be derived, so a job
keeps its ID as it moves between states. Where a scan sees one generation in more than one state,
failed wins over retrying and retrying over pending, the order processing resolves them in.
Frontmatter values are omitted, and failed records carry no reason because the queue keeps none.

Scrape's WebSocket selection adds exactly `scrape_corpus_replay`, `scrape_presets_check`,
`scrape_queue_list`, `scrape_queue_submit` and `scrape_queue_process` for this UI. MCP keeps its
nine agent-facing operations and `events: []`. Exposing an operator operation to the local UI is a
separate decision from exposing it to agents. Machine-path conversion, fetch-to-file, corpus capture
and browser session administration remain socket-only.

The WebSocket gateway forwards the long operations with timeouts that match their own bounds:
- `scrape_fetch`: 120 seconds
- `scrape_links`: 180 seconds
- `scrape_feed_discover`: 310 seconds
- `scrape_corpus_replay`: 120 seconds
- `scrape_presets_check` and `scrape_queue_process`: 600 seconds

The UI shows elapsed time while a call runs. It treats a timeout or dropped connection as an unknown
outcome, and it never resends a call automatically. After a queue submit or process, it re-reads the
list whether the call succeeded or not.

## Consequences

Remote UIX intersects Access policy with this WebSocket selection. Scrape has no remote control
allowlist, so a remote session can list presets and the queue, parse, convert and replay, but it
cannot fetch, check canaries, submit or process jobs, even with `uix:control`. The windows say
these controls are available only on the local UIX. The Scrape space adds no Brain admission
control and no browser session window: session listing does not exist, and headful browser work
belongs to Browse. Scrape's corpus capture, local preset validation and file-path operations
remain available only through the socket.
