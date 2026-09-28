import { chmod, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export async function writeV2Credential(path: string, provider: "xai" | "openai", value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  try {
    db.exec("CREATE TABLE IF NOT EXISTS credential (integration_id TEXT, value TEXT)");
    db.prepare("INSERT INTO credential (integration_id, value) VALUES (?, ?)").run(provider, value);
  } finally { db.close(); }
  await chmod(path, 0o600);
}
