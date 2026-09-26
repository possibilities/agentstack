import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

// Even without the sandbox, -h only prints usage and never opens a browser.
const open = spawnSync("/usr/bin/open", ["-h"], { timeout: 2_000, encoding: "utf8" });
writeFileSync(join(process.env.XDG_DATA_HOME, "native-marker.json"), JSON.stringify({
  pid: process.pid,
  args: process.argv.slice(2),
  browser: process.env.BROWSER,
  sshConnection: process.env.SSH_CONNECTION,
  sshClient: process.env.SSH_CLIENT,
  tty: process.stdin.isTTY === true,
  open: { error: open.error?.code ?? null, status: open.status },
}));

// Fail only after submission so the test can inspect the pending manual prompt.
if (process.env.FAKE_WORKER_LOGIN_NATIVE_FAIL) process.stdin.once("data", () => process.exit(23));
await import("./fake-worker-login-devin.mjs");
