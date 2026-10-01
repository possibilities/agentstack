import { stateCategories } from "@stack/api";
export const scrapeStateCategories = stateCategories("scrape", [
  { id: "queue", kind: "queue", paths: ["scrape/queue", "scrape/retry", "scrape/failed", "scrape/private"], reads: ["scrape_queue_list"], actions: ["scrape_queue_plan"],
    retention: "Generation claims and quarantine fence extraction/publication. A job's external destination is not an owned deletion target. Legacy failures may lack a persisted reason.", regeneration: "Explicit submit/retry and queue processing; Brain ingestion is a separate ledger." },
  { id: "definitions", kind: "configuration", paths: ["scrape"], reads: ["scrape_presets_list", "scrape_canary_inventory", "scrape_corpus_list"], actions: ["scrape_corpus_plan"],
    retention: "Local preset/canary definitions and captured corpus evidence are distinct from shipped source definitions and authenticated browser sessions.", regeneration: "Explicit capture or local definition edits.", issues: ["This aggregate overlaps queue storage; do not sum its bytes with the queue category."] },
]);
