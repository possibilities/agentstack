import { stateCategories } from "@stack/api";
export const signalStateCategories = stateCategories("signal", [
  { id: "attention", kind: "history", paths: ["attention/attention.sqlite", "attention/attention.sqlite-wal"], reads: ["attention_status", "attention_message_list", "attention_run_list", "attention_infer_requests"], actions: ["attention_control", "attention_history_plan", "attention_history_clear"],
    retention: "Captured message revisions, source-read blobs, partial Worker buffers, jobs/runs, feedback, semantic items and events are independent copies of upstream chats.", regeneration: "Source readers can capture surviving transcripts; pausing interpretation alone does not prove all readers or admitted Infer work are drained." },
  { id: "checkpoints", kind: "configuration", paths: [], ownership: "shared", reads: ["attention_status", "attention_defaults_get"], actions: ["attention_defaults_set", "attention_checkpoint_plan"],
    retention: "Rebaseline replaces exact source cursors/partial buffers while retaining captured content, suppression, Infer correlation, activation and sibling checkpoints.", regeneration: "Rebaseline-to-now skips existing messages without inference. Explicit replay is a separate spend-bearing operation; resumed reads can interpret later messages." },
]);
