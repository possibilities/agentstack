import { stateCategories } from "@stack/api";
export const procStateCategories = stateCategories("proc", [
  { id: "ledger", kind: "history", paths: ["proc/proc.sqlite", "proc/proc.sqlite-wal"], reads: ["proc_status", "proc_schedule_list", "proc_execution_list", "proc_run_list"], actions: ["proc_schedule_remove", "proc_run_cancel", "proc_history_plan", "proc_history_clear"],
    retention: "Removed schedule definitions support exact input/argv/env/cwd redaction with a digest and marker; protected Brain schedules refuse. Captured admissions remain separate. Execution/run history is pruned after 30 days. Cancellation is not deletion.", regeneration: "Enabled schedules admit future work; removed definitions never re-admit. Already admitted actions retain their captured authority." },
  { id: "output", kind: "history", paths: [], ownership: "shared", reads: ["proc_run_get", "proc_run_read"], actions: ["proc_history_plan", "proc_history_clear"],
    retention: "Bounded stdout/stderr shares the Proc ledger. Read cursors report gaps and truncation; unknown exits remain unknown.", regeneration: "Live process guardians can append until the exact process exits." },
]);
