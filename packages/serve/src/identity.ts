import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join, resolve } from "node:path";
import { stateDir } from "@stack/api";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The installation identity under one state root: the Access instance UUID, read from the Access store without
 * writing it. Throws when the store or its row is absent; a caller that needs a value (factory reset) must not guess.
 */
export function accessServerId(root: string): string {
  const db = new DatabaseSync(join(root, "access", "access.db"), { readOnly: true });
  try {
    const row = db.prepare("SELECT uuid FROM instance WHERE id=1").get() as { uuid?: unknown } | undefined;
    if (typeof row?.uuid !== "string" || !uuid.test(row.uuid)) throw new Error("access instance identity is missing");
    return row.uuid;
  } finally { db.close(); }
}

/** The same identity for `serve_status`: null before Access has created its store or while it cannot be read, never invented. */
export function readServerId(env: NodeJS.ProcessEnv): string | null {
  const root = resolve(stateDir(env));
  if (!existsSync(join(root, "access", "access.db"))) return null;
  try { return accessServerId(root); } catch { return null; }
}
