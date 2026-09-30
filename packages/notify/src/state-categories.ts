import { stateCategories } from "@stack/api";
export const notifyStateCategories = stateCategories("notify", [
  { id: "notifications", kind: "history", paths: ["notify/notifications.sqlite", "notify/notifications.sqlite-wal"], reads: ["notification_counts", "notification_list", "notification_get"], actions: ["notification_dismiss", "notification_dismiss_all", "notification_history_plan", "notification_history_clear"],
    retention: "Dismissal records the first outcome and retains bodies, prompts, responses and send digests. It does not erase history or manufacture an answer.", regeneration: "New sends and group replacements; send identities must survive payload clearing." },
]);
