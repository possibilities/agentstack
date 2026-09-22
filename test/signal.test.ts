import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));

test("SIGINT exits serve while a connection is open", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "agentstack-signal-"));
  const child = spawn(process.execPath, [cli, "serve"], {
    env: { ...process.env, AGENTSTACK_STATE_DIR: stateDir, AGENTSTACK_PORT: "0" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  try {
    const url = await waitForUrl(stderr, () => stderr);
    const port = Number(new URL(url).port);
    const socket = connect(port, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", () => resolve());
      socket.once("error", reject);
    });
    child.kill("SIGINT");
    const code = await Promise.race([
      new Promise<number | null>((resolve) => child.once("exit", resolve)),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error(`serve ignored SIGINT\n${stderr}`)), 3000)),
    ]);
    socket.destroy();
    assert.notEqual(code, null);
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    await rm(stateDir, { recursive: true, force: true });
  }
});

async function waitForUrl(current: string, read: () => string): Promise<string> {
  const started = Date.now();
  let text = current;
  while (!text.includes("http://127.0.0.1:")) {
    if (Date.now() - started > 3000) throw new Error(`serve did not print a URL\n${text}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
    text = read();
  }
  const match = text.match(/http:\/\/127\.0\.0\.1:\d+\/mcp/);
  if (!match) throw new Error(`serve did not print a URL\n${text}`);
  return match[0];
}
