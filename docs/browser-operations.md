# Browser operations

The Browser Package API owns a local-only Hypeman/Kernel lifecycle and private
`agent-browser` toolchain. Agents and humans use `agent-browser` CLI/MCP for page
actions, not these management operations. Each task gets a disposable profile;
close removes its target and storage. Session names are routing keys, not
Bot/Worker authorization boundaries. There is no saved-profile selection,
remote backend or remote-file staging.

An AgentStack owner writes `<AGENTSTACK_STATE_DIR>/browser/agent-browser.json`
when it starts. To test the provider without changing AgentStart's global
config, start an **isolated** owner with `AGENTSTACK_BROWSER_PROVIDER=agentstack`
and a disposable `AGENTSTACK_STATE_DIR`; its Bot and Worker children inherit
`AGENT_BROWSER_CONFIG` pointing to that file. A human can choose that file with
`AGENT_BROWSER_CONFIG=/absolute/path/to/agent-browser.json agent-browser
--session unique-task open https://example.com`. Do not use a saved profile or
the production owner for this smoke test.

The provider needs an explicitly selected local Hypeman installation. Use
`hypeman_detect`, `hypeman_location_set` for a nonstandard root, then
`hypeman_enable`. `hypeman_install` installs a separate, receipt-owned copy;
neither detection nor installation silently selects a host. The private
`agent-browser` installation uses exact release versions and defaults to manual
update acceptance; opt into automatic release installs explicitly. A Bot/Worker
also needs an agent-browser executable/MCP definition in its Role. A Worker
account has an isolated `HOME`, so use a stable absolute executable there.

**Production gate:** agent-browser 0.38.1 currently suppresses provider-close
failures, including plugin `success:false`; its provider time budgets are 60s
for launch and 15s for close. Until fixed and tested with disposable Hypeman
targets, a successful `agent-browser close` cannot certify cleanup. The ledger
preserves failed work for exact manual reconciliation; no lease is stolen by age.
