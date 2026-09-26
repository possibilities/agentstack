#!/usr/bin/env node
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const secret = process.env.FAKE_WORKER_LOGIN_SECRET ?? "fake-codex-secret";
const prompt = "⠋\x1b[?25l Working…\x1b[?25h\nEnter code: FAKE-C0DEX\nhttps://auth.openai.com/codex/device\n";

const writeEvidence = () => {
  const dir = join(process.env.XDG_DATA_HOME, "opencode");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "opencode.db");
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE credential (integration_id TEXT, value TEXT)");
  db.prepare("INSERT INTO credential VALUES (?, ?)").run("openai", JSON.stringify({ type: "oauth", access: "fake-codex-access", refresh: secret, metadata: { accountID: "fixture-account" } }));
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
} else if (process.env.FAKE_WORKER_LOGIN_FAIL) {
  setTimeout(() => { process.stderr.write(`access_token=${secret}\n`); process.exit(1); }, 80);
} else {
  setTimeout(() => { process.stderr.write(`refresh_token=${secret}\n`); writeEvidence(); process.exit(0); }, 80);
}
