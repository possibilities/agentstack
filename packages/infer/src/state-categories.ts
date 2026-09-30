import { stateCategories } from "@stack/api";
export const inferStateCategories = stateCategories("infer", [
  { id: "requests", kind: "history", paths: ["infer/traces.sqlite", "infer/traces.sqlite-wal"], reads: ["infer_request_list", "infer_request_get", "infer_trace_read"], actions: ["infer_history_plan", "infer_history_clear"],
    retention: "Requests retain inputs, instructions, outputs, provider events, errors and usage. Request IDs prevent repeated dispatch and must survive payload cleanup.", regeneration: "Explicit admissions, including Signal interpretations; unknown outcomes may have been charged." },
  { id: "catalogs", kind: "cache", paths: [], authority: "derived", sensitivity: "ordinary", reads: ["infer_model_list"], actions: ["infer_discover"],
    retention: "Model discovery observations are in memory; temporary credential-bearing probes remain lifecycle-owned.", regeneration: "Explicit discovery; reads never authorize inference spend." },
]);
