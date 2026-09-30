import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { socketCall, socketSubscribe, operatorHeaders, withLocalAuth, type SocketSubscription, type StatePage } from "@stack/api";
import WebSocket from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { serverResourcesOutput, serverResourceHistoryOutput } from "../src/resources/schema.js";

const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const socketNames = ["access", "api", "signal", "auth", "roles", "bots", "brain", "xcom", "proc", "browse", "scrape", "content", "worker", "usage", "infer", "notify", "hud", "serve"];
const brainEnv = { STACK_BRAIN_SHARE_HOST: "127.0.0.1", STACK_BRAIN_SHARE_PORT: "0" };

test("serve owns sockets, MCP, WebSocket, Inspector, and UI canvas without a standalone reference listener, then shuts them down", { timeout: 120_000 }, async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "stack-serve-"));
  const inspectorPort = await availablePort();
  const uiPort = await availablePort();
  const retiredDocsPort = await availablePort();
  const previousHeaders = operatorHeaders({ STACK_STATE_DIR: stateDir });
  const previousSession = withLocalAuth({ STACK_STATE_DIR: stateDir }, auth => auth.redeem(auth.bootstrap(`http://127.0.0.1:${uiPort}`, "ui"), `http://127.0.0.1:${uiPort}`, "ui"));
  const child = spawn(process.execPath, [cli, "serve"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...brainEnv, STACK_STATE_DIR: stateDir, STACK_AGENTGROK_BIN: join(stateDir, "missing-agentgrok"),
      STACK_MCP_PORT: "0", STACK_WEBSOCKET_PORT: "0", STACK_INSPECTOR_PORT: String(inspectorPort), STACK_UI_PORT: String(uiPort), STACK_DOCS_PORT: String(retiredDocsPort), STACK_WIKI_PORT: "0", STACK_WIKI_ARTIFACT_PORT: "0", MCP_INSPECTOR_API_TOKEN: "test-token" },
  });
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const serverSock = join(stateDir, "sockets", "serve.sock");
  const env = { STACK_STATE_DIR: stateDir };
  const authenticate = async (target: "ui" | "inspector") => {
    const bootstrap = await socketCall(serverSock, "tools/call", { name: "serve_local_connect", arguments: { target } }) as { url: string };
    const url = new URL(bootstrap.url);
    let response: Response | undefined;
    for (let i = 0; i < 200; i++) {
      try { response = await fetch(`${url.origin}/connect/local/session`, { method: "POST", headers: { origin: url.origin, "content-type": "application/json" }, body: JSON.stringify({ token: url.hash.slice(1) }) }); break; }
      catch { await new Promise(resolve => setTimeout(resolve, 50)); }
    }
    assert.equal(response?.status, 200, stderr);
    assert.match(response!.headers.get("set-cookie")!, /HttpOnly; SameSite=Strict/);
    assert.equal((await fetch(`${url.origin}/connect/local/session`, { method: "POST", headers: { origin: url.origin, "content-type": "application/json" }, body: JSON.stringify({ token: url.hash.slice(1) }) })).status, 401);
    return response!.headers.get("set-cookie")!.split(";")[0]!;
  };
  let websocket: WebSocket | undefined;
  let subscription: SocketSubscription | undefined;
  try {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline && !socketNames.every((name) => existsSync(join(stateDir, "sockets", `${name}.sock`)))) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`serve exited early\n${stderr}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    for (const name of socketNames) assert.ok(existsSync(join(stateDir, "sockets", `${name}.sock`)), `${name}.sock missing`);

    let status = (await socketCall(serverSock, "tools/call", { name: "serve_status", arguments: {} })) as {
      pid: number;
      children: Array<{ name: string; pid: number | null; running: boolean }>;
    };
    assert.equal(status.pid, child.pid);
    assert.deepEqual(status.children.map((entry) => entry.name).sort(), ["access", "api", "auth", "bots", "brain", "browse", "content", "hud", "infer", "inspector", "notify", "proc", "roles", "scrape", "signal", "ui", "usage", "websocket", "worker", "xcom"]);
    for (let i = 0; i < 200 && status.children.some((entry) => !entry.running); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      status = (await socketCall(serverSock, "tools/call", { name: "serve_status", arguments: {} })) as typeof status;
    }
    assert.ok(status.children.every((entry) => entry.running));
    const inventory = await socketCall(serverSock, "tools/call", { name: "serve_state_list", arguments: { limit: 100 } }) as StatePage & { owners: Array<{ package: string; available: boolean }> };
    assert.deepEqual(inventory.owners.filter(owner => owner.available).map(owner => owner.package).sort(), [...socketNames].sort());
    assert.equal(inventory.nextOffset, null);
    for (const owner of inventory.owners) {
      const catalog = await socketCall(join(stateDir, "sockets", `${owner.package}.sock`), "tools/list", {}) as { tools: Array<{ name: string }> };
      const names = new Set(catalog.tools.map(tool => tool.name));
      const entries = inventory.entries.filter(entry => entry.ownerPackage === owner.package);
      assert.ok(entries.length, `${owner.package} inventory is empty`);
      for (const entry of entries) for (const link of [...entry.reads, ...entry.actions]) assert.ok(names.has(link.operation), `${owner.package}: broken state link ${link.operation}`);
    }
    let resourceSubscription: Awaited<ReturnType<typeof socketSubscribe>> | undefined;
    const nextResourceSample = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("resource sampler did not publish")), 10_000);
      void socketSubscribe(serverSock, ["resources_changed"], () => {
        clearTimeout(timeout); resolve(); void resourceSubscription?.close();
      }).then((subscription) => { resourceSubscription = subscription; }, (error) => { clearTimeout(timeout); reject(error); });
    });
    try { await nextResourceSample; } finally { await resourceSubscription?.close(); }
    const resourceSnapshot = serverResourcesOutput.parse(await socketCall(serverSock, "tools/call", { name: "serve_resources", arguments: { view: "processes", limit: 100 } }));
    assert.equal(resourceSnapshot.observation.coverage?.mode, "server_tree");
    assert.equal(resourceSnapshot.observation.freshness, "fresh");
    assert.equal(resourceSnapshot.runtime?.pid, child.pid);
    assert.ok(resourceSnapshot.host?.hostname);
    assert.ok(resourceSnapshot.processes.some((entry) => entry.pid === child.pid));
    for (const entry of status.children) assert.ok(resourceSnapshot.processes.some((process) => process.pid === entry.pid && process.component === entry.name), `${entry.name} absent from resource snapshot`);
    const usage = await socketCall(join(stateDir, "sockets", "usage.sock"), "tools/call", { name: "usage_snapshot", arguments: {} }) as { accounts: unknown[]; grokBot: { fresh: boolean } };
    assert.deepEqual(usage.accounts, []);
    assert.equal(usage.grokBot, null); // No signed-in Grok Worker account to reference.

    for (let i = 0; i < 200 && !/serve MCP: (http:\/\/\S+)/.test(stderr); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const url = /serve MCP: (http:\/\/\S+)/.exec(stderr)?.[1];
    assert.ok(url, stderr);
    assert.notDeepEqual(operatorHeaders(env), previousHeaders, "startup rotates persisted operator authority");
    assert.throws(() => withLocalAuth(env, auth => auth.session(previousSession.token, `http://127.0.0.1:${uiPort}`, "ui")));
    const client = new Client({ name: "server-test", version: "1.0.0" });
    assert.equal((await fetch(url, { method: "POST" })).status, 401);
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: operatorHeaders(env) } }));
    try {
      assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name), ["serve_status", "serve_codex_tools", "serve_resources", "serve_resource_history", "events_catalog", "events_subscribe", "events_status", "events_unsubscribe"]);
      const result = await client.callTool({ name: "serve_status", arguments: {} });
      assert.equal((result.structuredContent as { pid?: number } | undefined)?.pid, child.pid);
      const resources = await client.callTool({ name: "serve_resources", arguments: {} });
      assert.ok(serverResourcesOutput.parse(resources.structuredContent).scope!.metrics.rssBytes! > 0);
    } finally {
      await client.close();
    }

    for (let i = 0; i < 200 && !/WebSocket: (ws:\/\/\S+)/.test(stderr); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const wsUrl = /WebSocket: (ws:\/\/\S+)/.exec(stderr)?.[1];
    assert.ok(wsUrl, stderr);
    assert.match(wsUrl, /^ws:\/\/127\.0\.0\.1:\d+\/websocket$/);
    const ws = websocket = new WebSocket(wsUrl, { headers: operatorHeaders(env) });
    await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = () => reject(new Error("WebSocket did not open")); });
    const frame = () => new Promise<any>((resolve) => { ws.onmessage = (event) => resolve(JSON.parse(String(event.data))); });
    const call = frame();
    ws.send(JSON.stringify({ id: 1, method: "tools/call", params: { package: "serve", name: "serve_status", arguments: {} } }));
    assert.equal((await call).result.pid, child.pid);
    const subscribed = frame();
    ws.send(JSON.stringify({ id: 2, method: "events/subscribe", params: { package: "serve", subscription: "status", topics: ["pids_changed"] } }));
    assert.deepEqual(await subscribed, { id: 2, result: { package: "serve", subscription: "status", topics: ["pids_changed"] } });
    const historyCall = frame();
    ws.send(JSON.stringify({ id: 3, method: "tools/call", params: { package: "serve", name: "serve_resource_history", arguments: {} } }));
    assert.ok(serverResourceHistoryOutput.parse((await historyCall).result).points.length > 0);
    const crossPackage = frame();
    ws.send(JSON.stringify({ id: 4, method: "tools/list", params: { package: "api" } }));
    assert.ok((await crossPackage).result.tools.some((tool: { name: string }) => tool.name === "docs_snapshot"));
    const procList = frame();
    ws.send(JSON.stringify({ id: 5, method: "tools/list", params: { package: "proc" } }));
    assert.ok((await procList).result.tools.some((tool: { name: string }) => tool.name === "proc_run_start"));
    const procRead = frame();
    ws.send(JSON.stringify({ id: 6, method: "tools/call", params: { package: "proc", name: "proc_schedule_list", arguments: {} } }));
    assert.ok((await procRead).result.schedules.some((schedule: { system: boolean }) => schedule.system));

    const procUrl = url.replace(/\/mcp\/serve(?:\?.*)?$/, "/mcp/proc");
    const procClient = new Client({ name: "proc-test", version: "1.0.0" });
    await procClient.connect(new StreamableHTTPClientTransport(new URL(procUrl), { requestInit: { headers: operatorHeaders(env) } }));
    try {
      const tools = (await procClient.listTools()).tools.map((tool) => tool.name);
      assert.ok(tools.includes("proc_schedule_create") && tools.includes("proc_run_start") && tools.includes("events_subscribe"));
      const schedules = await procClient.callTool({ name: "proc_schedule_list", arguments: {} });
      assert.ok((schedules.structuredContent as { schedules: Array<{ system: boolean }> }).schedules.some((schedule) => schedule.system));
    } finally { await procClient.close(); }

    const inspectorCookie = await authenticate("inspector");
    const inspectorHeaders = { cookie: inspectorCookie, "x-mcp-remote-auth": "Bearer test-token" };
    let servers: Response | undefined;
    for (let i = 0; i < 200; i += 1) {
      try {
        servers = await fetch(`http://127.0.0.1:${inspectorPort}/api/servers`, {
          headers: inspectorHeaders,
        });
        if (servers.ok) break;
      } catch {
        // The Inspector child may still be starting.
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(servers?.status, 200, stderr);
    assert.deepEqual(Object.keys((await servers.json() as { mcpServers: Record<string, unknown> }).mcpServers).sort(), ["api", "auth", "bots", "brain", "browse", "chrome", "computer-history", "computer-use", "content", "hud", "messages", "notify", "openai-developer-docs", "proc", "roles", "scrape", "serve", "usage", "worker", "xcom"]);
    const inspectorUrl = `http://127.0.0.1:${inspectorPort}/`;
    assert.equal((await fetch(inspectorUrl, { redirect: "manual" })).status, 303);
    assert.equal((await fetch(`${inspectorUrl}api/servers`, { headers: { "x-mcp-remote-auth": "Bearer test-token" } })).status, 401);
    assert.ok(!(await (await fetch(inspectorUrl)).text()).includes("test-token"));
    assert.equal((await fetch(inspectorUrl, { headers: inspectorHeaders })).status, 200);
    const catalogDir = (await readdir(stateDir)).find((entry) => entry.startsWith("inspector-"));
    assert.ok(catalogDir);
    const catalogPath = join(stateDir, catalogDir, "mcp.json");
    const config = JSON.parse(await readFile(catalogPath, "utf8")) as { mcpServers: Record<string, unknown> };
    config.mcpServers.sample = { type: "http", url };
    await writeFile(catalogPath, JSON.stringify(config));
    let refreshed = false;
    for (let i = 0; i < 100 && !refreshed; i += 1) {
      const response = await fetch(`${inspectorUrl}api/servers`, { headers: inspectorHeaders });
      const current = await response.json() as { mcpServers: Record<string, unknown> };
      refreshed = current.mcpServers.sample !== undefined;
      if (!refreshed) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(refreshed, true, "Inspector did not reload its server list");

    subscription = await socketSubscribe(serverSock, ["pids_changed"], () => undefined);

    assert.doesNotMatch(stderr, /Stack reference:/);
    await assert.rejects(fetch(`http://127.0.0.1:${retiredDocsPort}/docs`));
    const indexUrl = `http://127.0.0.1:${uiPort}/`;
    const uiUrl = `http://127.0.0.1:${uiPort}/`;
    const referenceUrl = `http://127.0.0.1:${uiPort}/?reference=overview`;
    const uiCookie = await authenticate("ui");
    const uiFetch = (url: string | URL, init: RequestInit = {}) => fetch(url, { ...init, headers: { cookie: uiCookie } });
    assert.equal((await fetch(uiUrl)).status, 401);
    assert.equal((await fetch(uiUrl, { headers: { "x-stack-remote-ui": "1", "x-stack-ui-origin": "https://evil.example", "x-stack-ui-scope": "control" } })).status, 401);
    assert.ok(stderr.includes(`Stack UI entry: ${indexUrl}`), stderr);
    assert.ok(stderr.includes(`Stack UI canvas: ${uiUrl}`), stderr);
    const serverStatus = await socketCall(serverSock, "tools/call", { name: "serve_status", arguments: {} }) as {
      indexUrl: string; uiUrl: string; inspectorUrl: string; mcpUrls: Record<string, string>;
    };
    assert.equal(serverStatus.indexUrl, indexUrl);
    assert.equal(serverStatus.uiUrl, uiUrl);
    assert.equal(serverStatus.inspectorUrl, inspectorUrl);
    assert.equal(serverStatus.mcpUrls.serve, url);
    assert.equal(Object.hasOwn(serverStatus, "docsUrl"), false);
    const duplicate = spawn(process.execPath, [cli, "serve"], {
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, ...brainEnv, STACK_STATE_DIR: stateDir, STACK_MCP_PORT: "0", STACK_WEBSOCKET_PORT: "0" },
    });
    let duplicateError = "";
    duplicate.stderr?.on("data", (chunk: Buffer) => { duplicateError += chunk.toString(); });
    assert.equal(await new Promise<number | null>((resolve) => duplicate.once("exit", resolve)), 0);
    assert.match(duplicateError, /Stack is already running/);
    assert.doesNotMatch(duplicateError, /Reference:/);
    assert.ok(duplicateError.includes(indexUrl), duplicateError);
    assert.ok(duplicateError.includes(uiUrl), duplicateError);
    assert.doesNotMatch(duplicateError, /a required child stopped|EADDRINUSE/);
    assert.equal((await socketCall(serverSock, "tools/call", { name: "serve_status", arguments: {} }) as { pid: number }).pid, child.pid);
    let entry: Response | undefined;
    for (let i = 0; i < 200; i += 1) {
      try {
        entry = await uiFetch(indexUrl, { redirect: "manual" });
        if (entry.status === 200) break;
      } catch {
        // Next.js may still be starting.
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(entry?.status, 200, stderr);
    assert.equal(entry.headers.get("location"), null);
    const system = await uiFetch(new URL("/system", uiUrl));
    assert.equal(system.status, 200);
    const systemHtml = await system.text();
    assert.match(systemHtml, /MCP Inspector/);
    assert.match(systemHtml, /Packages/);
    assert.ok(!systemHtml.includes(referenceUrl), "System links only MCP Inspector as a surface");
    assert.ok(systemHtml.includes(serverStatus.inspectorUrl));
    assert.ok(systemHtml.includes(serverStatus.mcpUrls.serve));
    const canvas = await uiFetch(uiUrl);
    assert.equal(canvas.status, 200);
    const canvasHtml = await canvas.text();
    assert.match(canvasHtml, /<main[^>]*data-canvas="workbench"/);
    assert.match(canvasHtml, /<h1[^>]*>Stack open bench<\/h1>/);
    // The root lands on HUD; Fleet lives at /fleet.
    assert.match(canvasHtml, /<main[^>]*data-space="hud"/);
    const fleet = await uiFetch(new URL("/fleet", uiUrl));
    assert.equal(fleet.status, 200);
    assert.match(await fleet.text(), /No bots</);
    const accounts = await uiFetch(new URL("/accounts", uiUrl));
    assert.equal(accounts.status, 200);
    assert.match(await accounts.text(), /No accounts</);
    // The integrated discovery reader retains the retired reference's coverage of concurrent APIs.
    for (const [pkg, names] of [
      ["serve", ["serve_resources", "serve_resource_history", "resources_changed"]],
      ["bots", ["chat_tree", "chat_tree_detail"]],
      ["brain", ["@stack/brain", "brain_status", "search", "submit"]],
      ["xcom", ["@stack/xcom", "xcom_status", "xcom_search", "xcom_users"]],
      ["worker", ["worker_record_list", "worker_tool_list", "worker_progress"]],
    ] as const) {
      const response = await uiFetch(new URL(`/?reference=package%3A${pkg}`, uiUrl));
      assert.equal(response.status, 200);
      const html = await response.text();
      const reference = html.match(/<aside\b[^>]*data-dock="right"[^>]*>[\s\S]*?<\/aside>/)?.[0];
      assert.ok(reference, `Missing integrated ${pkg} reference`);
      assert.match(reference, /data-reference/);
      const rendered = reference.replace(/<!--.*?-->/g, "");
      assert.match(rendered, /Worker disclosure \(catalog snapshot\):/);
      if (["serve", "bots", "xcom"].includes(pkg)) assert.match(rendered, /Worker disclosure \(catalog snapshot\): none/);
      if (pkg === "worker") assert.match(rendered, /Worker disclosure \(catalog snapshot\): worker_list, worker_status, worker_read/);
      for (const name of names) assert.ok(reference.includes(name), `Reference is missing ${name}`);
    }
    assert.doesNotMatch(canvasHtml, /Local links and Server processes/);
    const stylesheets = [...new Set([...canvasHtml.matchAll(/href="(\/_next\/static\/[^"]+\.css)"/g)].map((match) => match[1]))];
    assert.ok(stylesheets.length > 0);
    const css = await Promise.all(stylesheets.map(async (stylesheet) => {
      const response = await uiFetch(new URL(stylesheet, uiUrl));
      assert.equal(response.status, 200);
      return response.text();
    }));
    assert.match(css.join("\n"), /prefers-color-scheme:\s*dark/);

    assert.ok(!stderr.includes("https://"), stderr);
    assert.ok(!stderr.includes("token="), stderr);
    assert.ok(stderr.includes("serve.sock"), stderr);

    const staleHeaders = operatorHeaders(env);
    await socketCall(serverSock, "tools/call", { name: "serve_local_revoke", arguments: {} });
    assert.equal((await fetch(url, { method: "POST", headers: staleHeaders, body: "{}" })).status, 401);
    assert.equal((await uiFetch(uiUrl)).status, 401);
    assert.equal((await fetch(`${inspectorUrl}api/servers`, { headers: inspectorHeaders })).status, 401);
    const reconnectedCookie = await authenticate("ui");
    assert.equal((await fetch(uiUrl, { headers: { cookie: reconnectedCookie } })).status, 200);
    const reconnectedInspector = await authenticate("inspector");
    assert.equal((await fetch(`${inspectorUrl}api/servers`, { headers: { ...inspectorHeaders, cookie: reconnectedInspector } })).status, 200);
    const reconnected = new Client({ name: "rotated-operator", version: "1" });
    await reconnected.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: operatorHeaders(env) } }));
    await reconnected.listTools(); await reconnected.close();

    child.kill("SIGTERM");
    const code = await new Promise<number | null>((resolve) => child.once("exit", (exitCode) => resolve(exitCode)));
    assert.equal(code, 0, stderr);
    await assert.rejects(fetch(inspectorUrl));
    await assert.rejects(fetch(uiUrl));
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
    websocket?.close();
    await subscription?.close();
    if (child.exitCode === null && child.signalCode === null) {
      // Let the server reap its detached children even when an assertion fails.
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
      try { await exited; } finally { clearTimeout(timer); }
    }
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("the retired docs command is rejected before startup", { timeout: 30_000 }, async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "stack-retired-docs-"));
  try {
    const child = spawn(process.execPath, [cli, "docs"], {
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, STACK_STATE_DIR: stateDir },
      timeout: 5_000,
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    assert.equal(await new Promise<number | null>((resolve) => child.once("exit", resolve)), 1);
    assert.match(stderr, /usage: stack serve/);
    assert.doesNotMatch(stderr, /usage: stack docs|Stack reference:/);
    assert.equal(existsSync(join(stateDir, "sockets", "serve.sock")), false);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("a claimed MCP port refuses startup before the server creates a socket", { timeout: 30_000 }, async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "stack-occupied-"));
  const listener = createServer();
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address();
  assert.ok(address && typeof address !== "string");
  try {
    const child = spawn(process.execPath, [cli, "serve"], {
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, ...brainEnv, STACK_STATE_DIR: stateDir, STACK_MCP_PORT: String(address.port) },
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    assert.equal(await new Promise<number | null>((resolve) => child.once("exit", resolve)), 1);
    assert.match(stderr, new RegExp(`MCP port ${address.port} is already in use`));
    assert.equal(existsSync(join(stateDir, "sockets", "serve.sock")), false);
  } finally {
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("a claimed WebSocket port refuses startup before the server creates a socket", { timeout: 30_000 }, async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "stack-ws-occupied-"));
  const listener = createServer();
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address();
  assert.ok(address && typeof address !== "string");
  try {
    const child = spawn(process.execPath, [cli, "serve"], {
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, ...brainEnv, STACK_STATE_DIR: stateDir, STACK_MCP_PORT: "0", STACK_WEBSOCKET_PORT: String(address.port) },
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    assert.equal(await new Promise<number | null>((resolve) => child.once("exit", resolve)), 1);
    assert.match(stderr, new RegExp(`WebSocket port ${address.port} is already in use`));
    assert.equal(existsSync(join(stateDir, "sockets", "serve.sock")), false);
  } finally {
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("a claimed Inspector port refuses startup before the server creates a socket", { timeout: 30_000 }, async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "stack-inspector-occupied-"));
  const listener = createServer();
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address();
  assert.ok(address && typeof address !== "string");
  try {
    const child = spawn(process.execPath, [cli, "serve"], {
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, ...brainEnv, STACK_STATE_DIR: stateDir, STACK_MCP_PORT: "0", STACK_WEBSOCKET_PORT: "0", STACK_INSPECTOR_PORT: String(address.port) },
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    assert.equal(await new Promise<number | null>((resolve) => child.once("exit", resolve)), 1);
    assert.match(stderr, new RegExp(`Inspector port ${address.port} is already in use`));
    assert.equal(existsSync(join(stateDir, "sockets", "serve.sock")), false);
  } finally {
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("a claimed UI canvas port refuses startup before the server creates a socket", { timeout: 30_000 }, async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "stack-ui-occupied-"));
  const inspectorPort = await availablePort();
  const listener = createServer();
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address();
  assert.ok(address && typeof address !== "string");
  try {
    const child = spawn(process.execPath, [cli, "serve"], {
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, ...brainEnv, STACK_STATE_DIR: stateDir, STACK_MCP_PORT: "0", STACK_WEBSOCKET_PORT: "0", STACK_INSPECTOR_PORT: String(inspectorPort), STACK_UI_PORT: String(address.port) },
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    assert.equal(await new Promise<number | null>((resolve) => child.once("exit", resolve)), 1);
    assert.match(stderr, new RegExp(`UI canvas port ${address.port} is already in use`));
    assert.equal(existsSync(join(stateDir, "sockets", "serve.sock")), false);
  } finally {
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("a claimed content document port refuses startup before the server creates a socket", { timeout: 30_000 }, async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "stack-wiki-occupied-"));
  const inspectorPort = await availablePort();
  const uiPort = await availablePort();
  const listener = createServer();
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address();
  assert.ok(address && typeof address !== "string");
  try {
    const child = spawn(process.execPath, [cli, "serve"], {
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, ...brainEnv, STACK_STATE_DIR: stateDir, STACK_MCP_PORT: "0", STACK_WEBSOCKET_PORT: "0", STACK_INSPECTOR_PORT: String(inspectorPort), STACK_UI_PORT: String(uiPort), STACK_CONTENT_PORT: String(address.port), STACK_CONTENT_ARTIFACT_PORT: "0" },
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    assert.equal(await new Promise<number | null>((resolve) => child.once("exit", resolve)), 1);
    assert.match(stderr, new RegExp(`Content documents port ${address.port} is already in use`));
    assert.equal(existsSync(join(stateDir, "sockets", "serve.sock")), false);
  } finally {
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("a claimed Brain share port on its configured host refuses startup before creating sockets", { timeout: 30_000 }, async () => {
  const listener = createServer();
  await new Promise<void>((resolve, reject) => { listener.once("error", reject); listener.listen(0, "::1", resolve); });
  const address = listener.address();
  assert.ok(address && typeof address !== "string");
  try {
    const stderr = await refusedStartup({ STACK_BRAIN_SHARE_HOST: "::1", STACK_BRAIN_SHARE_PORT: String(address.port) });
    assert.match(stderr, /Brain backend must bind 127/);
  } finally {
    await new Promise<void>((resolve) => listener.close(() => resolve()));
  }
});

test("Brain share rejects invalid ports before creating sockets", { timeout: 30_000 }, async () => {
  for (const value of ["", "not-a-port", "-1", "65536", "1.5"]) {
    assert.match(await refusedStartup({ STACK_BRAIN_SHARE_PORT: value }), /STACK_BRAIN_SHARE_PORT must be a port from 0 to 65535/);
  }
  assert.match(await refusedStartup({ STACK_BRAIN_SHARE_HOST: "" }), /Brain backend must bind 127/);
});

test("remote content listeners require two distinct public origins before creating sockets", { timeout: 30_000 }, async () => {
  assert.match(await refusedStartup({ STACK_CONTENT_HOST: "0.0.0.0" }), /Content backend must bind 127/);
  assert.match(await refusedStartup({ STACK_CONTENT_DOCUMENT_ORIGIN: "https:\/\/same.example", STACK_CONTENT_ARTIFACT_ORIGIN: "https:\/\/same.example" }), /origins must differ/);
});

test("remote UI requires an exact HTTPS certificate origin and three distinct Access ports before creating sockets", { timeout: 30_000 }, async () => {
  const base = { STACK_ACCESS_HOST: "100.80.0.1", STACK_ACCESS_TLS_KEY: "/operator/key", STACK_ACCESS_TLS_CERT: "/operator/cert" };
  assert.match(await refusedStartup({ ...base, STACK_ACCESS_UI_PORT: "8945" }), /STACK_ACCESS_UI_ORIGIN/);
  assert.match(await refusedStartup({ ...base, STACK_ACCESS_UI_ORIGIN: "http://machine.ts.net:8945" }), /STACK_ACCESS_UI_ORIGIN/);
  assert.match(await refusedStartup({ ...base, STACK_ACCESS_UI_ORIGIN: "https://machine.ts.net:8945/path" }), /STACK_ACCESS_UI_ORIGIN/);
  assert.match(await refusedStartup({ ...base, STACK_ACCESS_UI_ORIGIN: "https://machine.ts.net:8945", STACK_ACCESS_UI_PORT: "8943" }), /distinct valid ports/);
});

test("Brain share rejects collisions with server listeners before creating sockets", { timeout: 30_000 }, async () => {
  for (const setting of ["STACK_MCP_PORT", "STACK_WEBSOCKET_PORT", "STACK_INSPECTOR_PORT", "STACK_UI_PORT", "STACK_CONTENT_PORT", "STACK_CONTENT_ARTIFACT_PORT"]) {
    const port = String(await availablePort());
    const stderr = await refusedStartup({ [setting]: port, STACK_BRAIN_SHARE_PORT: port });
    assert.match(stderr, new RegExp(`STACK_BRAIN_SHARE_PORT and ${setting} must use different ports`));
  }
});

async function refusedStartup(settings: NodeJS.ProcessEnv): Promise<string> {
  const stateDir = await mkdtemp(join(tmpdir(), "stack-brain-preflight-"));
  const inspectorPort = await availablePort();
  const uiPort = await availablePort();
  const child = spawn(process.execPath, [cli, "serve"], {
    stdio: ["ignore", "ignore", "pipe"],
    env: { ...process.env, ...brainEnv, STACK_STATE_DIR: stateDir, STACK_MCP_PORT: "0", STACK_WEBSOCKET_PORT: "0",
      STACK_INSPECTOR_PORT: String(inspectorPort), STACK_UI_PORT: String(uiPort), STACK_CONTENT_PORT: "0", STACK_CONTENT_ARTIFACT_PORT: "0", ...settings },
  });
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  try {
    assert.equal(await new Promise<number | null>((resolve) => child.once("exit", resolve)), 1, stderr);
    assert.equal(existsSync(join(stateDir, "sockets")), false, stderr);
    assert.equal(existsSync(join(stateDir, "brain")), false, stderr);
    return stderr;
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await rm(stateDir, { recursive: true, force: true });
  }
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}
