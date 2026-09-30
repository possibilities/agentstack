import { stateCategories } from "@stack/api";
export const hudStateCategories = stateCategories("hud", [
  { id: "work", kind: "history", paths: ["hud/work.sqlite", "hud/work.sqlite-wal"], reads: ["work_list", "work_tree", "work_activity_list", "work_resources"],
    retention: "Shared Work, hierarchy, dependencies, metadata and immutable collaboration journal survive native resource removal. Journal before/after values retain copies of authored bodies.", regeneration: "Explicit semantic edits; native completion never completes Work." },
  { id: "focus", kind: "configuration", paths: [], ownership: "shared", reads: ["work_focus_get", "work_focus_list", "work_metadata_get"], actions: ["work_focus_set", "work_metadata_set", "work_focus_retire_plan", "work_focus_retire"],
    retention: "Focus is bound to the exact Bot root and Chat. Saved null is an inheritance barrier, not deletion. Worker admissions retain their captured Work context independently.", regeneration: "A fresh Bot root never inherits retired-root focus; explicit focus edits and metadata updates create new revisions." },
]);
