import { stateCategories } from "@stack/api";
export const contentStateCategories = stateCategories("content", [
  { id: "vault", kind: "history", paths: ["wiki/vault"], reads: ["list", "get", "content_vault_history_plan"], actions: ["rm", "restore"],
    retention: "Vault files are authoritative. Removal tombstones a document; local Git history, remotes and backups retain authored bodies independently.", regeneration: "Reconciliation rebuilds the derived index from files. Git history is not rewritten by ordinary deletion." },
  { id: "artifacts", kind: "storage", paths: ["wiki/artifacts"], reads: ["artifacts_list", "artifacts_show", "content_publication_list"], actions: ["artifacts_rm", "gc", "content_publication_plan"],
    retention: "Immutable named Artifact versions are content-addressed; removal tombstones. Artifact gc reclaims tombstoned bytes in this store only. Exact claimed dead-writer publication temporaries may collect; live/uncertain writers, legacy paths and admission evidence remain.", regeneration: "Explicit publishing; shared live references keep their bytes. Collection never republishes." },
  { id: "collections", kind: "storage", paths: ["wiki/collections"], reads: ["collection_list", "item_list", "blob_stage_list", "content_blob_list"], actions: ["item_delete", "collection_delete", "blob_stage_abort", "content_storage_plan", "content_storage_collect"],
    retention: "Collection deletion ungroups items. Item deletion removes its row; collection CAS bytes and upload stages have separate retention from Artifact gc.", regeneration: "Uploads and item admissions can refer to existing content-addressed bytes." },
]);
