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
const socketNames = ["api", "auth", "roles", "bots", "workers", "usage", "wiki", "owner"];

test("serve owns sockets, MCP, WebSocket, Inspector, docs, and UI canvas, then shuts them down", { timeout: 120_000 }, async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "agentstack-serve-"));
  const inspectorPort = await availablePort();
  const uixPort = await availablePort();
  const child = spawn(process.execPath, [cli, "serve"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, AGENTSTACK_STATE_DIR: stateDir, AGENTSTACK_AGENTGROK_BIN: join(stateDir, "missing-agentgrok"),
      AGENTSTACK_MCP_PORT: "0", AGENTSTACK_WEBSOCKET_PORT: "0", AGENTSTACK_INSPECTOR_PORT: String(inspectorPort), AGENTSTACK_UIX_PORT: String(uixPort), AGENTSTACK_WIKI_PORT: "0", AGENTSTACK_WIKI_ARTIFACT_PORT: "0", MCP_INSPECTOR_API_TOKEN: "test-token" },
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
    assert.deepEqual(status.children.map((entry) => entry.name).sort(), ["api", "auth", "bots", "inspector", "roles", "uix", "usage", "websocket", "wiki", "workers"]);
    for (let i = 0; i < 200 && status.children.some((entry) => !entry.running); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      status = (await socketCall(ownerSock, "tools/call", { name: "owner_status", arguments: {} })) as typeof status;
    }
    assert.ok(status.children.every((entry) => entry.running));
    const usage = await socketCall(join(stateDir, "sockets", "usage.sock"), "tools/call", { name: "usage_snapshot", arguments: {} }) as { accounts: unknown[]; grokBot: { fresh: boolean } };
    assert.deepEqual(usage.accounts, []);
    assert.equal(typeof usage.grokBot.fresh, "boolean");

    for (let i = 0; i < 200 && !/owner MCP: (http:\/\/\S+)/.test(stderr); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const url = /owner MCP: (http:\/\/\S+)/.exec(stderr)?.[1];
    assert.ok(url, stderr);
    const client = new Client({ name: "owner-test", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));
    try {
      assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name), ["owner_status", "events_catalog", "events_subscribe", "events_status", "events_unsubscribe"]);
      const result = await client.callTool({ name: "owner_status", arguments: {} });
      assert.equal((result.structuredContent as { pid?: number } | undefined)?.pid, child.pid);
    } finally {
      await client.close();
    }

    for (let i = 0; i < 200 && !/owner WebSocket: (ws:\/\/\S+)/.test(stderr); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const wsUrl = /owner WebSocket: (ws:\/\/\S+)/.exec(stderr)?.[1];
    assert.ok(wsUrl, stderr);
    for (const name of socketNames) assert.match(stderr, new RegExp(`${name} WebSocket: ws://127\\.0\\.0\\.1:\\d+/websocket/${name}`));
    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = () => reject(new Error("WebSocket did not open")); });
    const frame = () => new Promise<any>((resolve) => { ws.onmessage = (event) => resolve(JSON.parse(String(event.data))); });
    const call = frame();
    ws.send(JSON.stringify({ id: 1, method: "tools/call", params: { name: "owner_status", arguments: {} } }));
    assert.equal((await call).result.pid, child.pid);
    const subscribed = frame();
    ws.send(JSON.stringify({ id: 2, method: "events/subscribe", params: { topics: ["pids_changed"] } }));
    assert.deepEqual(await subscribed, { id: 2, result: { topics: ["pids_changed"] } });

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
    assert.deepEqual(Object.keys((await servers.json() as { mcpServers: Record<string, unknown> }).mcpServers).sort(), ["auth", "bots", "owner", "roles", "usage", "wiki", "workers"]);
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
    const indexUrl = `http://127.0.0.1:${uixPort}/`;
    const uixUrl = `http://127.0.0.1:${uixPort}/x`;
    assert.ok(stderr.includes(`AgentStack index: ${indexUrl}`), stderr);
    assert.ok(stderr.includes(`AgentStack UI canvas: ${uixUrl}`), stderr);
    const ownerStatus = await socketCall(ownerSock, "tools/call", { name: "owner_status", arguments: {} }) as {
      indexUrl: string; uixUrl: string; inspectorUrl: string; mcpUrls: Record<string, string>;
    };
    assert.equal(ownerStatus.indexUrl, indexUrl);
    assert.equal(ownerStatus.uixUrl, uixUrl);
    assert.equal(ownerStatus.inspectorUrl, inspectorUrl);
    assert.equal(ownerStatus.mcpUrls.owner, url);
    const duplicate = spawn(process.execPath, [cli, "serve"], {
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, AGENTSTACK_STATE_DIR: stateDir, AGENTSTACK_MCP_PORT: "0", AGENTSTACK_WEBSOCKET_PORT: "0" },
    });
    let duplicateError = "";
    duplicate.stderr?.on("data", (chunk: Buffer) => { duplicateError += chunk.toString(); });
    assert.equal(await new Promise<number | null>((resolve) => duplicate.once("exit", resolve)), 0);
    assert.match(duplicateError, /AgentStack is already running/);
    assert.ok(duplicateError.includes(docsUrl), duplicateError);
    assert.ok(duplicateError.includes(indexUrl), duplicateError);
    assert.ok(duplicateError.includes(uixUrl), duplicateError);
    assert.doesNotMatch(duplicateError, /a required child stopped|EADDRINUSE/);
    assert.equal((await socketCall(ownerSock, "tools/call", { name: "owner_status", arguments: {} }) as { pid: number }).pid, child.pid);
    const page = await fetch(docsUrl);
    assert.equal(page.status, 200);
    assert.equal(page.headers.get("cache-control"), "no-store");
    const html = await page.text();
    assert.match(html, /id="package-bots"/);
    assert.match(html, /href="\/docs\/site\.css"/);
    assert.match(html, /src="\/docs\/site\.js"/);
    const revision = await fetch(`${docsUrl}/revision`);
    assert.equal(revision.status, 200);
    assert.match(html, new RegExp((await revision.json() as { revision: string }).revision));
    assert.equal((await fetch(`${docsUrl}/site.css`)).status, 200);
    assert.equal((await fetch(new URL("/", docsUrl))).status, 404);
    let index: Response | undefined;
    for (let i = 0; i < 200; i += 1) {
      try {
        index = await fetch(new URL("/", uixUrl));
        if (index.ok) break;
      } catch {
        // Next.js may still be starting.
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(index?.status, 200, stderr);
    const indexHtml = await index.text();
    assert.match(indexHtml, /<h1[^>]*>AgentStack<\/h1>/);
    assert.match(indexHtml, /Local links and bot processes/);
    assert.match(indexHtml, /Package API reference/);
    assert.match(indexHtml, /MCP Inspector/);
    assert.match(indexHtml, /No running bots/);
    assert.match(indexHtml, /Package API URLs/);
    assert.ok(indexHtml.includes(uixUrl));
    assert.ok(indexHtml.includes(docsUrl));
    assert.ok(indexHtml.includes(ownerStatus.mcpUrls.owner));
    const canvas = await fetch(uixUrl);
    assert.equal(canvas.status, 200);
    const canvasHtml = await canvas.text();
    assert.match(canvasHtml, /<main[^>]*data-canvas="workbench"/);
    assert.match(canvasHtml, /<h1[^>]*>AgentStack Fleet canvas<\/h1>/);
    assert.doesNotMatch(canvasHtml, /Local links and Server processes/);
    const stylesheet = /href="(\/_next\/static\/[^"]+\.css)"/.exec(canvasHtml)?.[1];
    assert.ok(stylesheet);
    const css = await fetch(new URL(stylesheet, uixUrl));
    assert.equal(css.status, 200);
    assert.match(await css.text(), /prefers-color-scheme:\s*dark/);

    assert.ok(!stderr.includes("https://"), stderr);
    assert.ok(!stderr.includes("token="), stderr);
    assert.ok(stderr.includes("owner.sock"), stderr);

    child.kill("SIGTERM");
    const code = await new Promise<number | null>((resolve) => child.once("exit", (exitCode) => resolve(exitCode)));
    assert.equal(code, 0, stderr);
    await assert.rejects(fetch(inspectorUrl));
    await assert.rejects(fetch(docsUrl));
    await assert.rejects(fetch(uixUrl));
    await subscription.closed;
    await new Promise<void>((resolve) => { if (ws.readyState === WebSocket.CLOSED) resolve(); else ws.onclose = () => resolve(); });
    await assert.rejects(new Promise<void>((resolve, reject) => {
      const probe = new WebSocket(wsUrl);
      probe.onopen = () => { probe.close(); resolve(); };
      probe.onerror = () => reject(new Error("WebSocket listener closed"));
    }));
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

test("a claimed MCP port refuses startup before the owner creates a socket", { timeout: 30_000 }, async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "agentstack-occupied-"));
  const listener = createServer();
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address();
  assert.ok(address && typeof address !== "string");
  try {
    const child = spawn(process.execPath, [cli, "serve"], {
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, AGENTSTACK_STATE_DIR: stateDir, AGENTSTACK_MCP_PORT: String(address.port) },
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    assert.equal(await new Promise<number | null>((resolve) => child.once("exit", resolve)), 1);
    assert.match(stderr, new RegExp(`MCP port ${address.port} is already in use`));
    assert.equal(existsSync(join(stateDir, "sockets", "owner.sock")), false);
  } finally {
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("a claimed WebSocket port refuses startup before the owner creates a socket", { timeout: 30_000 }, async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "agentstack-ws-occupied-"));
  const listener = createServer();
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address();
  assert.ok(address && typeof address !== "string");
  try {
    const child = spawn(process.execPath, [cli, "serve"], {
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, AGENTSTACK_STATE_DIR: stateDir, AGENTSTACK_MCP_PORT: "0", AGENTSTACK_WEBSOCKET_PORT: String(address.port) },
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    assert.equal(await new Promise<number | null>((resolve) => child.once("exit", resolve)), 1);
    assert.match(stderr, new RegExp(`WebSocket port ${address.port} is already in use`));
    assert.equal(existsSync(join(stateDir, "sockets", "owner.sock")), false);
  } finally {
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("a claimed Inspector port refuses startup before the owner creates a socket", { timeout: 30_000 }, async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "agentstack-inspector-occupied-"));
  const listener = createServer();
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address();
  assert.ok(address && typeof address !== "string");
  try {
    const child = spawn(process.execPath, [cli, "serve"], {
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, AGENTSTACK_STATE_DIR: stateDir, AGENTSTACK_MCP_PORT: "0", AGENTSTACK_WEBSOCKET_PORT: "0", AGENTSTACK_INSPECTOR_PORT: String(address.port) },
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    assert.equal(await new Promise<number | null>((resolve) => child.once("exit", resolve)), 1);
    assert.match(stderr, new RegExp(`Inspector port ${address.port} is already in use`));
    assert.equal(existsSync(join(stateDir, "sockets", "owner.sock")), false);
  } finally {
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("a claimed UI canvas port refuses startup before the owner creates a socket", { timeout: 30_000 }, async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "agentstack-uix-occupied-"));
  const inspectorPort = await availablePort();
  const listener = createServer();
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address();
  assert.ok(address && typeof address !== "string");
  try {
    const child = spawn(process.execPath, [cli, "serve"], {
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, AGENTSTACK_STATE_DIR: stateDir, AGENTSTACK_MCP_PORT: "0", AGENTSTACK_WEBSOCKET_PORT: "0", AGENTSTACK_INSPECTOR_PORT: String(inspectorPort), AGENTSTACK_UIX_PORT: String(address.port) },
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    assert.equal(await new Promise<number | null>((resolve) => child.once("exit", resolve)), 1);
    assert.match(stderr, new RegExp(`UI canvas port ${address.port} is already in use`));
    assert.equal(existsSync(join(stateDir, "sockets", "owner.sock")), false);
  } finally {
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("a claimed wiki document port refuses startup before the owner creates a socket", { timeout: 30_000 }, async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "agentstack-wiki-occupied-"));
  const inspectorPort = await availablePort();
  const uixPort = await availablePort();
  const listener = createServer();
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address();
  assert.ok(address && typeof address !== "string");
  try {
    const child = spawn(process.execPath, [cli, "serve"], {
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, AGENTSTACK_STATE_DIR: stateDir, AGENTSTACK_MCP_PORT: "0", AGENTSTACK_WEBSOCKET_PORT: "0", AGENTSTACK_INSPECTOR_PORT: String(inspectorPort), AGENTSTACK_UIX_PORT: String(uixPort), AGENTSTACK_WIKI_PORT: String(address.port), AGENTSTACK_WIKI_ARTIFACT_PORT: "0" },
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    assert.equal(await new Promise<number | null>((resolve) => child.once("exit", resolve)), 1);
    assert.match(stderr, new RegExp(`Wiki documents port ${address.port} is already in use`));
    assert.equal(existsSync(join(stateDir, "sockets", "owner.sock")), false);
  } finally {
    await new Promise<void>((resolve) => listener.close(() => resolve()));
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
