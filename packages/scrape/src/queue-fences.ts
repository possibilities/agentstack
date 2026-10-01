import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { resolveDataHome } from "./queue-paths.js";

/** Read-only and fail-closed, including standalone processors in other processes. */
export function queueGenerationFenced(id: string): boolean {
  const path = join(resolveDataHome(), "maintenance.sqlite");
  if (!existsSync(path)) return false;
  const db = new DatabaseSync(path, { readOnly: true });
  try { return !!db.prepare("SELECT id FROM queue_fences WHERE id=?").get(id); }
  finally { db.close(); }
}

/** Retired local capture IDs are never assigned to new evidence. */
export function retiredCaptureSequence(preset: string): number {
  const path = join(resolveDataHome(), "maintenance.sqlite");
  if (!existsSync(path)) return 0;
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const row = db.prepare("SELECT max(CAST(substr(id,8) AS INTEGER)) AS n FROM corpus_fences WHERE preset=?").get(preset) as { n: number | null };
    return row.n ?? 0;
  } finally { db.close(); }
}

export function queueFencesFor(ids: string[]): Map<string, { requestId: string; action: string; status: string }> {
  const path = join(resolveDataHome(), "maintenance.sqlite"), result = new Map<string, { requestId: string; action: string; status: string }>();
  if (!existsSync(path)) return result;
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const read = db.prepare("SELECT f.request_id AS requestId,f.action,json_extract(r.receipt,'$.status') AS status FROM queue_fences f JOIN state_receipts r ON r.id=f.request_id WHERE f.id=?");
    for (const id of ids) { const row = read.get(id); if (row) result.set(id, row as { requestId: string; action: string; status: string }); }
    return result;
  } finally { db.close(); }
}
