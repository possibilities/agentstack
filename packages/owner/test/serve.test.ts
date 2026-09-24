import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { socketCall, socketSubscribe } from "@agentstack/api";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const socketNames = ["api", "auth", "codex", "bots", "owner"];

test("serve owns its sockets, HTTP MCP, Inspector, and live docs, then shuts them down", { timeout: 120_000 }, async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "agentstack-serve-"));
  const inspectorPort = await availablePort();
  const child = spawn(process.execPath, [cli, "serve"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, AGENTSTACK_STATE_DIR: stateDir, AGENTSTACK_MCP_PORT: "0", AGENTSTACK_INSPECTOR_PORT: String(inspectorPort), MCP_INSPECTOR_API_TOKEN: "test-token" },
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
    assert.deepEqual(status.children.map((entry) => entry.name).sort(), ["api", "auth", "bots", "codex", "inspector"]);
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

    let servers: Response | undefined;
    for (let i = 0; i < 200; i += 1) {
      try {
        servers = await fetch(`http://127.0.0.1:${inspectorPort}/api/servers`, {
          headers: { "x-mcp-remote-auth": "Bearer test-token" },
        });
        if (servers.ok) break;
      } catch {
        // The Inspector child may still be starting.
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(servers?.status, 200, stderr);
    assert.deepEqual(Object.keys((await servers.json() as { mcpServers: Record<string, unknown> }).mcpServers).sort(), ["auth", "bots", "codex", "owner"]);
    const inspectorUrl = `http://127.0.0.1:${inspectorPort}/`;
    assert.equal((await fetch(inspectorUrl)).status, 200);
    const catalogDir = (await readdir(stateDir)).find((entry) => entry.startsWith("inspector-"));
    assert.ok(catalogDir);
    const catalogPath = join(stateDir, catalogDir, "mcp.json");
    const config = JSON.parse(await readFile(catalogPath, "utf8")) as { mcpServers: Record<string, unknown> };
    config.mcpServers.sample = { type: "http", url };
    await writeFile(catalogPath, JSON.stringify(config));
    let refreshed = false;
    for (let i = 0; i < 100 && !refreshed; i += 1) {
      const response = await fetch(`${inspectorUrl}api/servers`, { headers: { "x-mcp-remote-auth": "Bearer test-token" } });
      const current = await response.json() as { mcpServers: Record<string, unknown> };
      refreshed = current.mcpServers.sample !== undefined;
      if (!refreshed) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(refreshed, true, "Inspector did not reload its server list");

    const subscription = await socketSubscribe(ownerSock, ["pids_changed"], () => undefined);

    for (let i = 0; i < 200 && !/AgentStack reference: (http:\/\/\S+\/docs)/.test(stderr); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const docsUrl = /AgentStack reference: (http:\/\/\S+\/docs)/.exec(stderr)?.[1];
    assert.ok(docsUrl, stderr);
    const page = await fetch(docsUrl);
    assert.equal(page.status, 200);
    assert.equal(page.headers.get("cache-control"), "no-store");
    const html = await page.text();
    assert.match(html, /id="package-codex"/);
    assert.match(html, /href="\/docs\/site\.css"/);
    assert.match(html, /src="\/docs\/site\.js"/);
    const revision = await fetch(`${docsUrl}/revision`);
    assert.equal(revision.status, 200);
    assert.match(html, new RegExp((await revision.json() as { revision: string }).revision));
    assert.equal((await fetch(`${docsUrl}/site.css`)).status, 200);
    assert.equal((await fetch(new URL("/", docsUrl))).status, 404);

    assert.ok(!stderr.includes("https://"), stderr);
    assert.ok(!stderr.includes("token="), stderr);
    assert.ok(stderr.includes("owner.sock"), stderr);

    child.kill("SIGTERM");
    const code = await new Promise<number | null>((resolve) => child.once("exit", (exitCode) => resolve(exitCode)));
    assert.equal(code, 0, stderr);
    await assert.rejects(fetch(inspectorUrl));
    await assert.rejects(fetch(docsUrl));
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

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}
