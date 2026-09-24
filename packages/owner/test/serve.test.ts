import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { socketCall, socketSubscribe } from "@agentstack/api";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const socketNames = ["api", "auth", "codex", "bots", "owner"];

test("serve owns its sockets and HTTP MCP child, then shuts them down", { timeout: 120_000 }, async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "agentstack-serve-"));
  const child = spawn(process.execPath, [cli, "serve"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, AGENTSTACK_STATE_DIR: stateDir, AGENTSTACK_MCP_PORT: "0" },
  });
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const ownerSock = join(stateDir, "sockets", "owner.sock");
  try {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline && !socketNames.every((name) => existsSync(join(stateDir, "sockets", `${name}.sock`)))) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`serve exited early\n${stderr}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    for (const name of socketNames) assert.ok(existsSync(join(stateDir, "sockets", `${name}.sock`)), `${name}.sock missing`);

    let status = (await socketCall(ownerSock, "tools/call", { name: "owner_status", arguments: {} })) as {
      pid: number;
      children: Array<{ name: string; pid: number | null; running: boolean }>;
    };
    assert.equal(status.pid, child.pid);
    assert.deepEqual(status.children.map((entry) => entry.name).sort(), ["api", "auth", "bots", "codex", "mcp"]);
    for (let i = 0; i < 200 && status.children.some((entry) => !entry.running); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      status = (await socketCall(ownerSock, "tools/call", { name: "owner_status", arguments: {} })) as typeof status;
    }
    assert.ok(status.children.every((entry) => entry.running));

    for (let i = 0; i < 200 && !/owner MCP: (http:\/\/\S+)/.test(stderr); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const url = /owner MCP: (http:\/\/\S+)/.exec(stderr)?.[1];
    assert.ok(url, stderr);
    const client = new Client({ name: "owner-test", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));
    try {
      assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name), ["owner_status"]);
      const result = await client.callTool({ name: "owner_status", arguments: {} });
      assert.equal((result.structuredContent as { pid?: number } | undefined)?.pid, child.pid);
    } finally {
      await client.close();
    }

    const subscription = await socketSubscribe(ownerSock, ["pids_changed"], () => undefined);

    assert.ok(!stderr.includes("https://"), stderr);
    assert.ok(!stderr.includes("token="), stderr);
    assert.ok(stderr.includes("owner.sock"), stderr);

    child.kill("SIGTERM");
    const code = await new Promise<number | null>((resolve) => child.once("exit", (exitCode) => resolve(exitCode)));
    assert.equal(code, 0, stderr);
    await subscription.closed;
    for (const name of socketNames) {
      const sock = join(stateDir, "sockets", `${name}.sock`);
      for (let i = 0; i < 100 && existsSync(sock); i += 1) await new Promise((resolve) => setTimeout(resolve, 25));
      assert.equal(existsSync(sock), false, `${name}.sock left behind`);
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await rm(stateDir, { recursive: true, force: true });
  }
});
