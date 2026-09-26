import { spawn, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const root = process.env.CLAUDE_CONFIG_DIR;
const native = process.env.FAKE_CLAUDE_NATIVE === "1";
const open = native ? spawnSync("/usr/bin/open", ["-h"], { encoding: "utf8" }) : null;
const stubborn = process.env.FAKE_CLAUDE_STUBBORN_DESCENDANT === "1";
const descendant = spawn(process.execPath, ["-e", `${stubborn ? 'process.on("SIGTERM", () => {});' : ""}setInterval(() => {}, 1000)`], { stdio: stubborn ? "inherit" : "ignore" });
writeFileSync(join(root, "fixture-marker.json"), JSON.stringify({ pid: process.pid, descendant: descendant.pid,
  args: process.argv.slice(2), browser: process.env.BROWSER, config: root, home: process.env.HOME,
  bypass: process.env.AGENTSTART_SHIM_BYPASS, openError: open?.error?.code,
  leaked: Object.keys(process.env).filter((key) => /^(ANTHROPIC_|CLAUDE_CODE_OAUTH|CLAUDE_SECURESTORAGE|AWS_|GOOGLE_|AZURE_)/.test(key)),
}), { mode: 0o600 });
const url = process.env.FAKE_CLAUDE_URL ?? "https://claude.com/cai/oauth/authorize?code=true&response_type=code&client_id=fixture-client&state=fixture-state&code_challenge=fixture-challenge&code_challenge_method=S256&login_method=claudeai";
process.stderr.write("private-fixture-token-never-publish\n");
process.stdout.write(`Opening browser to sign in…\nIf the browser didn't open, visit: ${url}\n`);
setTimeout(() => process.stdout.write("Paste code here if prompted > "), 30);
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  if (process.env.FAKE_CLAUDE_FAIL === "1" || line !== "fixture-code#fixture-state") {
    process.stderr.write("Login failed: private-fixture-token-never-publish\n");
    descendant.kill();
    process.exit(1);
  }
  writeFileSync(join(root, ".credentials.json"), JSON.stringify({ claudeAiOauth: {
    accessToken: "fixture-access", refreshToken: "fixture-refresh", expiresAt: 9999999999999,
    scopes: ["user:inference", "user:profile"], subscriptionType: "max",
  } }), { mode: 0o600 });
  writeFileSync(join(root, ".claude.json"), JSON.stringify({ oauthAccount: {
    accountUuid: process.env.FAKE_CLAUDE_IDENTITY ?? "10000000-0000-4000-8000-000000000001", emailAddress: "fixture@example.invalid",
  } }), { mode: 0o600 });
  descendant.kill();
  process.stdout.write("Login successful.\n");
  process.exit(0);
});
