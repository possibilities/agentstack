# 90. Keep extraction and preset drift inside AgentStack Scrape

Status: accepted, 2026-09-27. Revises [ADR 0059](0059-isolated-brain-and-platform-clients.md)'s external Agentscrape boundary and extends [ADR 0076](0076-internal-disposable-browser-lifecycle.md)'s browser lifecycle split.
Live checks and queue mutations reach the local UIX over the WebSocket, not MCP, per [ADR 0103](0103-scrape-space-and-local-operator-exposure.md).

## Decision

`packages/scrape` owns the former Agentscrape extraction, links, feed/archive discovery, provider presets, corpus, canaries, HTML conversion, browser-session adapter and durable scrape-to-file queue. Its only published control surface is the typed AgentStack Package API over the shared socket/MCP/WebSocket transports; it does not install a second CLI or MCP daemon. Agent-facing transports expose bounded retrieval and preset inspection. Machine paths, corpus capture, live checks, queue mutations and browser session administration stay on the local socket. Brain's Ingestion worker consumes Scrape's typed engine rather than finding an `agentscrape` binary. Its ledger and Scrape's scrape-to-file queue remain distinct.

Scrape state defaults exclusively to `<AGENTSTACK_STATE_DIR>/scrape`, without adopting a prior Agentscrape queue, captures, local presets, profile or credentials. The upstream MIT license and shipped preset corpus are retained. Extraction envelopes keep schema version 1 and extractor identity `agentscrape` for Brain's existing stored evidence; that name is provenance, not an installed command. A shape or output-contract mismatch fails as non-retryable `malformed_provider_output` with the preset name and an instruction to update it; it must not quietly fall through to generic text. An unconfigured live canary is reported as `not_configured`, not a pass.

Page operations still run through the selected `agent-browser` executable and provider. `packages/browser` owns its managed private installation and disposable lifecycle; this port does not add saved sign-ins or imply that authenticated provider checks can run without a human-established session. Direct Markdown and feeds retain their separate DNS-pinned HTTP policy; browser-backed egress still requires explicit consent.

## Consequences

The owner supervises one additional Scrape child and shuts it down before its Browser dependency. Brain no longer needs a fleet CLI on `PATH`. Optional `gh`, `pdftotext`, `pandoc`, `summaryctl` and the browser runtime remain route-specific capabilities, not a reason to claim all routes work on an empty machine. The corpus proves recorded shapes; live provider health needs a separately authorized browser validation, including authenticated sessions for X and ChatGPT.
