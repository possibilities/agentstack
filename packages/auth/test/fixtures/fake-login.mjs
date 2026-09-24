#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const prompt = `\nWelcome to Codex [v[90m0.0.0-test[0m]\n[90mOpenAI's command-line coding agent[0m\n\nFollow these steps to sign in with ChatGPT using device code authorization:\n\n1. Open this link in your browser and sign in to your account\n   [34mhttps://auth.openai.com/codex/device[0m\n\n2. Enter this one-time code [90m(expires in 15 minutes)[0m\n   [34mABCD-EFGH[0m\n\n[90mContinue only if you started this login in Codex. If a website or another person gave you this code, cancel.[0m\n`;

const writeAuth = () => writeFileSync(
  join(process.env.CODEX_HOME, "auth.json"),
  JSON.stringify({ tokens: { refresh_token: "fixture-secret", access_token: "access", id_token: "fixture.jwt.signature" } }),
);

if (process.env.FAKE_LOGIN_DELAYED) {
  process.on("SIGTERM", () => undefined);
  writeFileSync(join(process.env.CODEX_HOME, "ready"), "");
  setTimeout(() => process.stdout.write(prompt), 200);
  setTimeout(() => { writeAuth(); process.exit(0); }, 600);
} else if (process.env.FAKE_LOGIN_STUBBORN) {
  process.on("SIGTERM", () => undefined);
  process.stdout.write(prompt);
  setTimeout(writeAuth, 120);
  setInterval(() => undefined, 60_000);
} else {
  const split = prompt.indexOf("codex/device");
  process.stdout.write(prompt.slice(0, split));
  setTimeout(() => {
    process.stdout.write(prompt.slice(split));
    setTimeout(() => {
      writeAuth();
      if (process.env.FAKE_LOGIN_HANG) setInterval(() => undefined, 60_000);
      else process.exit(0);
    }, 120);
  }, 10);
}
