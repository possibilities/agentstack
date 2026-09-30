# 141. Retire Grok support without deleting stored data

Status: accepted, 2026-09-30. Supersedes the Grok-specific portions of
[ADR 0036](0036-account-bound-acp-foundation.md),
[ADR 0040](0040-opencode-v2-worker-accounts.md),
[ADR 0044](0044-owner-usage-observations.md),
[ADR 0050](0050-api-driven-worker-sign-in.md),
[ADR 0062](0062-usage-limits-and-grok-bot-card.md),
[ADR 0066](0066-grok-bot-usage-beside-a-grok-worker.md),
[ADR 0128](0128-managed-runtime-settings.md), and
[ADR 0139](0139-owner-maintenance-in-existing-spaces.md).

The operator requested removal of all Grok support and explicitly selected
**support removal only**, retaining existing stored accounts, credentials and
Worker history. Stack supports Codex, Devin and Claude Workers. Grok sign-in,
ACP launch selection, model catalogs, managed settings and usage collection are
removed. The machine-level Grok Bot CLI integration is removed entirely.

Package API provider enums and UI agree on the remaining providers.
`usage_snapshot` no longer has `grokBot`; `usage_observations_plan` selects only
nonempty exact account/scope pairs. No compatibility alias or hidden UI control
keeps the retired feature available.

Auth and Worker reads exclude unsupported provider rows, including direct ID
reads and HUD admissions. Existing database rows, private account profiles,
Worker files, branches and settings remain on disk and are not migrated to
another provider. Usage sidecars advance to version 4 while preserving opaque
legacy provider rows and machine observations on disk, outside live snapshots
and collection. Historical ADRs remain as the record of earlier decisions;
this decision governs current behavior.

Removing support neither uninstalls an external Grok application nor touches
AgentUsage accounts or a provider subscription. A live server continues its
loaded implementation until an independently authorized rebuild and restart.
