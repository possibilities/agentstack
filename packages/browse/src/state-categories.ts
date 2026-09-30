import { stateCategories } from "@stack/api";
export const browseStateCategories = stateCategories("browse", [
  { id: "profiles", kind: "configuration", paths: ["browser/profiles.json", "browser/sessions.json"], reads: ["browser_profile_list", "browser_controller_list", "browser_handoff_list"], actions: ["browser_profile_delete", "browser_controller_close"],
    retention: "Bot removal unassigns profiles. Profile deletion removes data only through its provider; unresolved handoffs and selected controllers block deletion.", regeneration: "Server supervision restarts retained profiles and refreshes controller observations." },
  { id: "volumes", kind: "storage", paths: [], location: "external", ownership: "stack", reads: ["browser_profile_list"],
    retention: "Provider-owned VM volumes contain cookies, local storage, IndexedDB, cache, history and tabs. Ledger deletion is not volume deletion.", regeneration: "Browser sessions and site activity.", issues: ["Volume bytes and site-data categories require the native provider; inventory has no cookie values."] },
  { id: "toolchain", kind: "runtime", paths: ["browser/system.json"], reads: ["browser_status"],
    retention: "Installed toolchain and VM artifacts use the Browser installation lifecycle.", regeneration: "Explicit install and owned profile startup." },
]);
