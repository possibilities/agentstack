#!/usr/bin/env node
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const secret = process.env.FAKE_WORKER_LOGIN_SECRET ?? "fake-devin-secret";
const url = process.env.FAKE_WORKER_LOGIN_URL ?? "https://windsurf.com/devin/account/login?state=fake-state&code_challenge=fake-challenge&cli_pkce_marker=1";
const prompt = `Visit \x1b]8;;${url}\x1b\\${url}\x1b]8;;\x1b\\ to sign in, then copy the code and paste it below.\n`;

writeFileSync(join(process.env.XDG_DATA_HOME, "env-marker"), `ssh:${process.env.SSH_CONNECTION ? "set" : "unset"}`);
const reprompt = "Error: Failed to exchange code for host https://app.devin.ai\r\n\x1b[?2026h\x1b[?25l\x1b[?2026l";

if (process.env.FAKE_WORKER_LOGIN_DELAYED) {
  process.on("SIGTERM", () => undefined);
  setTimeout(() => process.stdout.write(prompt), 400);
} else {
  process.stdout.write(prompt);
}

let submitted = 0;
process.stdin.on("data", (data) => {
  if (process.env.FAKE_WORKER_LOGIN_ECHO) process.stdout.write(data);
  submitted += 1;
  // Like the real CLI, the first pasted code is rejected and the prompt re-arms.
  if (submitted === 1 && !process.env.FAKE_WORKER_LOGIN_ACCEPT_FIRST) {
    process.stdout.write(reprompt);
    return;
  }
  const dir = join(process.env.XDG_DATA_HOME, "devin");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "credentials.toml");
  writeFileSync(path, `api_key = "${secret}"\napi_server_url = "https://api.devin.ai"\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  process.exit(0);
});
