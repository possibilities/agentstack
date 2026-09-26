# 65. Codex Worker accounts are paired with Codex Bot accounts

Status: accepted, 2026-09-26. Supersedes the independent Codex Worker
accounts and native-identity `linkedAccounts` of
[ADR 0048](0048-separate-bot-and-worker-sign-ins.md), and Codex Worker
creation in the Worker account menu of
[ADR 0049](0049-canvas-worker-account-controls.md). Keeps ADR 0048's separate
Bot and Worker credentials and sign-ins, and
[ADR 0050](0050-api-driven-worker-sign-in.md)'s API-run Worker sign-in.

## Decision

A Codex Bot account and a Codex Worker account are one ChatGPT login used by
two native runtimes, which need separate credentials and separate browser
sign-ins. `auth` therefore keeps them as a pair instead of two independent
accounts:

- Creating a Codex Bot account (`account_login_start`) also creates its
  paired Codex Worker account, with its own ID and profile, not ready until
  its own sign-in finishes (`worker_account_login_start` or the terminal
  fallback with that Worker's ID).
- A paired Worker's sign-in must use its Bot's ChatGPT login when both
  identities are readable; a different login fails the sign-in and leaves the
  Worker not ready.
- `worker_account_login_start` and `worker_account_prepare` no longer create
  Codex Worker accounts, and `worker_account_remove` refuses a paired one.
  `account_remove` removes the Bot account, its Bots, and its paired Worker's
  runtime, profile and credentials.
- Once signed in, a Codex Worker is enabled, disabled, signed in again and
  used exactly like Grok, Devin and Claude Workers.
- `linkedAccounts` in both inventories and in `usage_snapshot` now reports
  this pairing, by ID, rather than a native-identity match. The usage
  observer takes it from auth instead of comparing identities itself.

When auth starts, a Codex Bot account without a paired Worker adopts an
unpaired Codex Worker that has its ID (an older shared-UUID profile) or its
signed-in native identity; otherwise it gets a new Worker awaiting sign-in.
A Codex Worker that matches no Bot account stays unpaired and removable, but
no new unpaired one can be created.

The Worker account window and command palette offer only Grok, Devin and
Claude for new Worker accounts. A paired Codex Worker card has no Remove
action and reads "Sign in" until its first sign-in; its chips read "Paired
with". The Bot account remove dialog says it also removes the paired Worker.

## Consequences

Each Codex login appears once in Bot accounts and once in Worker accounts, so
the Usage window's fold of a linked Codex Worker into its Bot's card
([ADR 0064](0064-codex-workers-fold-into-linked-bot-usage.md)) applies to
every Codex Worker, including one awaiting sign-in. A Bot account can no
longer be removed while keeping its Worker's sign-in. Workers already in use
keep their IDs, so durable Worker records and profiles are unaffected.
