import { stateCategories } from "@stack/api";
export const roleStateCategories = stateCategories("roles", [
  { id: "catalog", kind: "configuration", paths: ["roles.sqlite", "roles.sqlite-wal"], reads: ["roles_snapshot", "role_snapshot", "role_launch_preview"], actions: ["role_delete"],
    retention: "Named Roles, per-Role bot.md personalities and launch defaults are authored configuration. Default Roles retain their deletion constraints. A current Role is not a historical launch snapshot.", regeneration: "Explicit edits affect later launches, never already captured Bot/Worker resources." },
  { id: "launches", kind: "conversation", paths: ["roles"], reads: ["role_launch_list"], actions: ["role_launch_plan"],
    retention: "Exact exited injection directories can be cleared. Live PID/start identities block; legacy locks or interrupted teardown stay unknown. Bot/Worker materializations and external native histories remain separate.", regeneration: "Explicit Role injection and native launches.", issues: ["Current Role Preview is not evidence of retained launch contents. Minimal receipts and unresolved quarantine remain."] },
  { id: "shims", kind: "configuration", paths: [], location: "external", ownership: "stack", reads: ["role_shim_list"], actions: ["role_shim_delete"],
    retention: "Exact hash-fenced Stack scripts live in the command directory. Unrelated/manual scripts are not adopted.", regeneration: "Explicit shim installation." },
]);
