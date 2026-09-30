import { stateCategories } from "@stack/api";
export const inferStateCategories = stateCategories("infer", [
  { id: "requests", kind: "history", paths: ["infer/traces.sqlite", "infer/traces.sqlite-wal"], reads: ["infer_request_list", "infer_request_get", "infer_trace_read"], actions: ["infer_history_plan", "infer_history_clear"],
    retention: "Requests retain inputs, instructions, outputs, provider events, errors and usage. Request IDs prevent repeated dispatch and must survive payload cleanup.", regeneration: "Explicit admissions, including Signal interpretations; unknown outcomes may have been charged." },
  { id: "catalogs", kind: "cache", paths: [], authority: "derived", sensitivity: "ordinary", reads: ["infer_model_list"], actions: ["infer_discover", "infer_catalog_clear"],
    retention: "Model discovery observations are in memory. Exact catalog eviction aborts and fences discovery; request/trace history and credentials are separate.", regeneration: "Explicit discovery; reads and eviction never start discovery or authorize inference spend." },
]);
