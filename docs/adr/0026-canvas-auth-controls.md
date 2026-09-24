# 26. Operate the auth Package API from the canvas

Status: accepted, 2026-09-24. Extends [ADR 0024](0024-live-canvas-workbench.md). `/x` is no longer read-only.

The Accounts window, inspector, and command palette now call every `auth` operation. The browser issues mutations over the same loopback WebSocket channel it already reads from — `tools/call` on the `auth` endpoint — so there is no Next.js route or new trust boundary. Reads and notices work unchanged; a successful mutation additionally re-reads `accounts` and `login` so the canvas reflects the result even before its notice arrives.

Sign-in is a tracked object, not a transient card. The store remembers the most recent `LoginState` this page has seen (`attempt`), because `account_login_current` only reports pending attempts. When the current sign-in clears while a remembered attempt is still pending, the store resolves its outcome through `account_login_status`, which serves finished attempts too; an "unknown Codex sign-in" reply drops it. The card then keeps the outcome — the new or re-signed account, or the failure with retry — until dismissed.

`account_remove` is destructive, so its confirmation dialog names the account, flags whether it is active, and lists the Servers and Bots that will be stopped and deleted; when any exist, the operator types the account's `codex-N` label to unlock the action. An account stuck at `removing: true` offers "Finish removal", which retries the same `account_remove` call the API documents for that case.

Other Package APIs stay read-only in the inspector; their Actions blocks keep the lock note.
