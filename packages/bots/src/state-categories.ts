import { stateCategories } from "@stack/api";
export const botStateCategories = stateCategories("bots", [
  { id: "instances", kind: "configuration", paths: ["configuration.sqlite", "bots/ledger.sqlite"], ownership: "shared", reads: ["bot_list", "bot_state_read"], actions: ["bot_remove"],
    retention: "Bot identities, assignments, settings and incarnation/generation metadata remain until explicit removal. Configuration SQLite is shared with Auth.", regeneration: "Explicit creation; recorded Bots autostart when the server starts." },
  { id: "workspaces", kind: "workspace", paths: ["bots"], reads: ["bot_list", "bot_workspace_list", "bot_workspace_read"], actions: ["bot_state_plan", "bot_workspace_clear"],
    retention: "Only ledger-owned workspaces may be cleared. External cwd, sibling workspaces and Bot identity survive. Includes all contents, including Git metadata, when selected.", regeneration: "Bot/native tools can write independently; file observations need explicit refresh.", issues: ["This storage root also contains Bot ledger and maintenance metadata; select a Bot before measuring its workspace."] },
  { id: "conversations", kind: "conversation", paths: ["history", "history-generations", "chats.sqlite", "chats.sqlite-wal"], reads: ["bot_history_list", "chat_tree", "bot_queue_history"], actions: ["bot_state_plan", "bot_session_reset", "bot_history_clear"],
    retention: "Conversation reset creates a fresh namespace. Old histories, queue outcomes and generation receipts are separate. Legacy shared history cannot be deleted wholesale.", regeneration: "Only the new generation may bind a new durable root; related Signal/Infer copies survive." },
  { id: "uploads", kind: "storage", paths: ["chat-uploads"], reads: ["chat_upload_list", "chat_upload_status"],
    retention: "Staged/finalized files and their transcript associations have independent lifecycles.", regeneration: "Explicit uploads." },
  { id: "runtime", kind: "credentials", paths: ["runtime", "runtime-recovery", "logs"], sensitivity: "credential", reads: ["bot_recovery_list", "bot_launch_read", "bot_log_read"], actions: ["bot_state_plan", "bot_log_clear", "bot_launch_args_clear"],
    retention: "Credential reconciliation evidence is not generic file content; running launch directories remain lifecycle-owned. Logs survive stop/start.", regeneration: "Next launch and credential reconciliation." },
]);
