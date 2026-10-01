import { stateCategories } from "@stack/api";
export const browseStateCategories = stateCategories("browse", [
  { id: "profiles", kind: "configuration", paths: ["browser/profiles.json", "browser/sessions.json"], reads: ["browser_profile_list", "browser_controller_list", "browser_handoff_list"], actions: ["browser_profile_delete", "browser_controller_close", "browser_profile_reset_plan", "browser_handoff_history_plan"],
    retention: "Exact reset retains profile ID/assignment and advances generation; stopped Bot/no controllers/open handoffs required. Resolved handoff body redaction keeps identity/timing/outcome and admission digest. Unknown profile effects remain durably fenced.", regeneration: "Explicit reset creates a fresh provider volume/instance; later supervision recovers only unfenced retained profiles." },
  { id: "volumes", kind: "storage", paths: [], location: "external", ownership: "stack", reads: ["browser_profile_list", "browser_volume_list"], actions: ["browser_site_data_plan", "browser_volume_plan"],
    retention: "Exact provider ownership/reference/mount checks guard orphan collection. Scoped CDP cookie domain/path/partition and origin storage/CacheStorage clearing never widens to HTTP cache/history. Ledger deletion is not volume deletion.", regeneration: "Browser sessions and site activity.", issues: ["Bytes unmeasured; no cookie values in inventory. Native external writers/pages, persisted history, HTTP cache and independent backups remain outside scoped guarantees."] },
  { id: "toolchain", kind: "runtime", paths: ["browser/system.json"], reads: ["browser_status"],
    retention: "Installed toolchain and VM artifacts use the Browser installation lifecycle.", regeneration: "Explicit install and owned profile startup." },
]);
