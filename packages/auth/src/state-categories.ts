import { stateCategories } from "@stack/api";
export const authStateCategories = stateCategories("auth", [
  { id: "accounts", kind: "credentials", paths: ["configuration.sqlite", "secrets.sqlite"], ownership: "shared", sensitivity: "credential", reads: ["account_list", "worker_account_list"], actions: ["account_remove", "worker_account_remove"],
    retention: "Codex account removal cascades to assigned/launched Bots and paired Worker account. Worker account removal drains its runtime and exact owned profile/keychain item; Worker records/worktrees are separate.", regeneration: "Explicit native sign-in; ambient personal logins and keychains are external." },
  { id: "profiles", kind: "storage", paths: [], ownership: "shared", sensitivity: "credential", reads: ["worker_account_list", "worker_account_login_current"],
    retention: "Native account profiles mix credentials, session history, catalogs and caches shared by sibling Workers. Removing a profile is broader than resetting one Worker.", regeneration: "Owned account runtimes and login attempts.", issues: ["Credential values are never exposed by state inventory; backend-native storage is not allocated to individual sessions."] },
]);
