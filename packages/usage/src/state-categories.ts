import { stateCategories } from "@stack/api";
export const usageStateCategories = stateCategories("usage", [
  { id: "observations", kind: "cache", paths: ["usage/observations.json"], authority: "derived", sensitivity: "ordinary", reads: ["usage_snapshot"], actions: ["usage_observations_plan", "usage_observations_clear"],
    retention: "Last-good account/scope observations include freshness and sanitized failure evidence. Account disappearance is reconciled automatically.", regeneration: "Collectors repopulate observations. Clearing local measurements never resets provider quota or billing." },
]);
