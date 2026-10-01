import { stateCategories } from "@stack/api";
export const hudStateCategories = stateCategories("hud", [
  { id: "work", kind: "history", paths: ["hud/work.sqlite", "hud/work.sqlite-wal"], reads: ["work_list", "work_tree", "work_activity_list", "work_resources"], actions: ["hud_history_plan", "hud_history_clear"],
    retention: "Exact journal-body redaction retains Work; item-and-journal also tombstones authored fields and metadata while preserving semantic identity, hierarchy, state and dependencies. Worker captures and other owner copies remain.", regeneration: "Tombstones cannot be reopened; new Work is explicit. Journal-only permits future collaboration. Native completion never completes Work." },
  { id: "focus", kind: "configuration", paths: [], ownership: "shared", reads: ["work_focus_get", "work_focus_list", "work_metadata_get"], actions: ["work_focus_set", "work_metadata_set", "work_focus_retire_plan", "work_focus_retire"],
    retention: "Focus is bound to the exact Bot root and Chat. Saved null is an inheritance barrier, not deletion. Worker admissions retain their captured Work context independently.", regeneration: "A fresh Bot root never inherits retired-root focus; explicit focus edits and metadata updates create new revisions." },
]);
