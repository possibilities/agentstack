import { stateCategories } from "@stack/api";
export const workerStateCategories = stateCategories("worker", [
  { id: "ledger", kind: "history", paths: ["workers.sqlite", "workers.sqlite-wal"], reads: ["worker_list", "worker_detail", "worker_turn_list", "worker_record_list", "worker_work_list"], actions: ["worker_close", "worker_remove"],
    retention: "Closing retains transcripts, turns, settings and captured Work context; removal clears Stack records but does not imply provider-native session deletion.", regeneration: "Explicit Worker admissions; unknown turns must not be dispatched again." },
  { id: "worktrees", kind: "workspace", paths: ["workers/worktrees", "workers/roles"], reads: ["worker_list", "worker_diff", "worker_workspace_list", "worker_workspace_read"], actions: ["worker_remove"],
    retention: "Closed Worker's Git worktree remains; removal requires explicit discardWorktree. Source-repository branches remain after removal.", regeneration: "New Worker creation creates a new worktree and frozen Role snapshot." },
  { id: "native-sessions", kind: "conversation", paths: [], ownership: "shared", reads: ["worker_detail", "worker_runtime_list", "worker_catalog"],
    retention: "Native sessions and catalogs live in account-owned profiles shared by sibling Workers; no per-session native purge is claimed.", regeneration: "Account runtimes reobserve catalogs; recovery may reload native sessions.", issues: ["Provider-native storage is not measured by Stack's Worker ledger inventory."] },
]);
