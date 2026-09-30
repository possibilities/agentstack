import { stateCategories } from "@stack/api";
export const xcomStateCategories = stateCategories("xcom", [
  { id: "archive", kind: "history", paths: ["xcom/following.sqlite3", "xcom/following.sqlite3-wal"], reads: ["xcom_status", "xcom_search", "xcom_get"], actions: ["xcom_control", "xcom_history_plan", "xcom_history_clear", "xcom_reindex"],
    retention: "Observed posts, article bodies/raw payloads, users, failures and cursors remain in the private archive. FTS is derived and repairable.", regeneration: "Enabled head/backfill scans can fetch retained upstream posts again; archive coverage is best-effort." },
]);
