/** Shared gateway/scheduler budgets. These are response waits, not cancellation
 * deadlines: losing a reply never establishes that an operation did not run. */
export const forwardTimeouts = new Map<string, number>([
  ["auth/account_remove", 300_000],
  ["bots/voice_dial", 75_000],
  ["infer/infer_complete", 75_000],
  ["signal/attention_models", 75_000],
  ["proc/proc_run_join", 310_000],
]);

export function forwardTimeout(pkg: string, operation: string): number {
  return forwardTimeouts.get(`${pkg}/${operation}`) ?? 60_000;
}

/** Codex's per-server tool wait must outlast the gateway's longest operation. */
export function mcpToolTimeoutSeconds(pkg: string): number {
  return Math.ceil(Math.max(60_000, ...[...forwardTimeouts].filter(([key]) => key.startsWith(`${pkg}/`)).map(([, ms]) => ms)) / 1000) + 5;
}
