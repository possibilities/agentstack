import { stateCategories } from "@stack/api";
export const contentStateCategories = stateCategories("content", [
  { id: "vault", kind: "history", paths: ["wiki/vault"], reads: ["list", "get"], actions: ["rm", "restore"],
    retention: "Vault files are authoritative. Removal tombstones a document; local Git history, remotes and backups retain authored bodies independently.", regeneration: "Reconciliation rebuilds the derived index from files. Git history is not rewritten by ordinary deletion." },
  { id: "artifacts", kind: "storage", paths: ["wiki/artifacts"], reads: ["artifacts_list", "artifacts_show"], actions: ["artifacts_rm", "gc"],
    retention: "Immutable named Artifact versions are content-addressed; removal tombstones. Artifact gc reclaims tombstoned bytes in this store only.", regeneration: "Explicit publishing; shared live references keep their bytes." },
  { id: "collections", kind: "storage", paths: ["wiki/collections"], reads: ["collection_list", "item_list", "blob_stage_list", "content_blob_list"], actions: ["item_delete", "collection_delete", "blob_stage_abort", "content_storage_plan", "content_storage_collect"],
    retention: "Collection deletion ungroups items. Item deletion removes its row; collection CAS bytes and upload stages have separate retention from Artifact gc.", regeneration: "Uploads and item admissions can refer to existing content-addressed bytes." },
]);
