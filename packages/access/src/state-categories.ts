import { stateCategories } from "@stack/api";
export const accessStateCategories = stateCategories("access", [
  { id: "authority", kind: "credentials", paths: ["access/access.db", "access/access.db-wal"], sensitivity: "credential", reads: ["access_snapshot"], actions: ["access_revoke"],
    retention: "Stable server identity, client/grant/credential records, pairings, invitations, sessions, receipts and audit remain after revocation. Expired material is pruned during mutations.", regeneration: "Pairing and enrollment admissions; device outboxes remain bound to the original server identity. Revocation is distinct from deletion." },
]);
