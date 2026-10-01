import { stateCategories } from "@stack/api";
export const brainStateCategories = stateCategories("brain", [
  { id: "research", kind: "storage", paths: ["brain"], reads: ["brain_status", "stats", "jobs_stats", "sources_list"], actions: ["delete", "brain_runs_plan", "brain_artifacts_plan"],
    retention: "Index, authoritative ledger, artifacts, sources, Runs, recovery policies and egress evidence share Brain's store. Document deletion redacts associated intents and collects unreferenced artifacts.", regeneration: "Enabled sources, devices and explicit submissions can admit the same content again. Admission is not indexing completion." },
  { id: "ingestion", kind: "queue", paths: [], ownership: "shared", reads: ["jobs_list", "jobs_show", "jobs_reveal"], actions: ["jobs_cancel", "jobs_exclude", "brain_jobs_plan"],
    retention: "Immutable intent, attempts and transitions survive retry. Content-free request/Chat bindings retain exact admitted job/Run identities across payload clear and backups. Reveal appends a sensitive-inspection audit. Active claims fence late completion.", regeneration: "Retry is an explicit new attempt; admission IDs and minimal receipts cannot be silently reused." },
  { id: "sources", kind: "configuration", paths: [], ownership: "shared", reads: ["sources_list", "sources_status"], actions: ["sources_pause", "sources_resume", "brain_source_plan"],
    retention: "Definitions, versions, audit and checkpoints are independent of indexed documents and already admitted jobs.", regeneration: "Source sync is scheduled through protected Proc authority; pause through Brain." },
  { id: "backups", kind: "storage", paths: [], ownership: "external", location: "external", reads: [],
    retention: "Selected backup/recovery files are outside the managed inventory unless explicitly registered; setup never adopts prior stores, tokens or manifests.", regeneration: "Explicit backup and recovery operations; device-held outboxes remain destination-bound." },
]);
