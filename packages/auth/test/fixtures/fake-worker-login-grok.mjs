#!/usr/bin/env node
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const secret = process.env.FAKE_WORKER_LOGIN_SECRET ?? "fake-grok-secret";
const prompt = "\x1b[36m▲\x1b[0m Open https://accounts.x.ai/oauth2/device on any device and enter code: FAKE-XAIC\nhttps://accounts.x.ai/oauth2/device?user_code=FAKE-XAIC\n";

const writeEvidence = () => {
  const dir = join(process.env.XDG_DATA_HOME, "opencode");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "opencode.db");
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE credential (integration_id TEXT, value TEXT)");
  db.prepare("INSERT INTO credential VALUES (?, ?)").run("xai", JSON.stringify({ type: "oauth", access: "fake-grok-access", refresh: secret }));
  db.close();
  chmodSync(path, 0o600);
};

if (process.env.FAKE_WORKER_LOGIN_DELAYED) {
  process.on("SIGTERM", () => undefined);
  setTimeout(() => process.stdout.write(prompt), 400);
} else {
  process.stdout.write(prompt);
}
if (process.env.FAKE_WORKER_LOGIN_HANG) {
  setInterval(() => undefined, 60_000);
} else {
  setTimeout(() => { process.stderr.write(`refresh_token=${secret}\n`); writeEvidence(); process.exit(0); }, 80);
}
