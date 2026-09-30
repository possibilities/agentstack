import { stateCategories } from "@stack/api";
export const signalStateCategories = stateCategories("signal", [
  { id: "attention", kind: "history", paths: ["attention/attention.sqlite", "attention/attention.sqlite-wal"], reads: ["attention_status", "attention_message_list", "attention_run_list", "attention_infer_requests"], actions: ["attention_control", "attention_history_plan", "attention_history_clear"],
    retention: "Captured message revisions, source-read blobs, partial Worker buffers, jobs/runs, feedback, semantic items and events are independent copies of upstream chats.", regeneration: "Source readers can capture surviving transcripts; pausing interpretation alone does not prove all readers or admitted Infer work are drained." },
  { id: "checkpoints", kind: "configuration", paths: [], ownership: "shared", reads: ["attention_status", "attention_defaults_get"], actions: ["attention_defaults_set"],
    retention: "Cursors, baselines, processing/default settings share the attention ledger. Replay appends an attempt instead of deleting history.", regeneration: "Checkpoint replay can re-admit inference and incur spend; related Infer traces remain separate." },
]);
