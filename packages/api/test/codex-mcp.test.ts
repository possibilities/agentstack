import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema, ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { serveMcp } from "../src/mcp.js";
import { CodexToolsDiagnostics } from "../src/codex-mcp/diagnostics.js";
import { operatorHeaders } from "../src/local-auth.js";
import { botMcpUrl, workerMcpUrl } from "../src/bot-mcp-identity.js";
import { serveSocket } from "../src/socket.js";
import { socketPath } from "../src/workspace.js";
import { operation } from "../src/operation.js";
import { internalMcpLaunches } from "../src/mcp-launch.js";
import { codexMcpDefinition } from "../src/codex-mcp/catalog.js";

// A real subprocess protocol peer, selected through the operator runtime setting.
// No desktop installation, credentials, or user data is read by this test.
const runtime = `
import {createInterface} from 'node:readline';
import {appendFileSync} from 'node:fs';
const send = value => process.stdout.write(JSON.stringify(value)+'\\n');
let waiting;
const tool = {name:'inspect', description:'Read fixture state', inputSchema:{type:'object',properties:{approve:{type:'boolean'},mode:{type:'string'}},additionalProperties:false},annotations:{readOnlyHint:true}};
createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if(m.method==='initialize') { appendFileSync(process.env.CODEX_HOME+'/starts',process.pid+'\\n'); send({id:m.id,result:{}}); }
 else if(m.method==='thread/start') send({id:m.id,result:{thread:{id:'thread-'+process.pid}}});
  else if(m.method==='mcpServerStatus/list') send({id:m.id,result:{data:process.env.FIXTURE_ALL_BRIDGES ? ['messages','computer-history','openaiDeveloperDocs','node_repl'].map(name=>({name,runtimeStatus:'ready',tools:name==='node_repl'?{js:{...tool,name:'js'}}:{inspect:tool}})) : [{name:'messages',runtimeStatus:'ready',tools:{inspect:tool}}],nextCursor:null}});
 else if(m.method==='mcpServer/tool/call') {
  if(m.params.arguments.approve) {waiting=m;send({id:900,method:'mcpServer/elicitation/request',params:{mode:m.params.arguments.mode??'form',threadId:m.params.threadId,turnId:m.params._meta['x-codex-turn-metadata'].turn_id,serverName:'messages',message:'Allow fixture read?',requestedSchema:{type:'object',properties:{},required:[]},_meta:{scope:'fixture'}}});}
  else send({id:m.id,result:{content:[{type:'image',data:'aGVsbG8=',mimeType:'image/png'}],structuredContent:{pid:process.pid,meta:m.params._meta},isError:false,_meta:{source:'fixture'}}});
 } else if(m.id===900 && waiting) {send({id:waiting.id,result:{content:[{type:'text',text:JSON.stringify(m.result)}],isError:false,structuredContent:null}});waiting=null;}
});
`;

test("Codex stdio MCP retains a private session, forwards media/elicitation, and reaps its backend on cancellation and pipe/signal closure", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "stack-codex-stdio-"));
  const binary = join(root, "codex");
  await mkdir(join(root, "packages"));
  await writeFile(binary, `#!${process.execPath}\n${runtime}`); await chmod(binary, 0o700);
  const env = { ...process.env, STACK_STATE_DIR: join(root, "state"), STACK_CODEX_TOOLS_HOME: root, STACK_CODEX_TOOLS_BIN: binary, STACK_MCP_PORT: "not-an-http-port" };
  const launch = (await internalMcpLaunches(root, { kind: "operator" }, env)).messages!;
  const clients: Client[] = [];
  try {
    for (const ending of ["EOF", "SIGTERM", "cancel"] as const) {
      const transport = new StdioClientTransport({ ...launch, cwd: root, stderr: "pipe" });
      const client = new Client({ name: "stdio-fixture", version: "1" }, { capabilities: { elicitation: { form: {} } } }); clients.push(client);
      let hold = false, asked!: () => void, release!: () => void;
      const asking = new Promise<void>(resolve => { asked = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
      client.setRequestHandler(ElicitRequestSchema, async request => {
        assert.equal(request.params._meta?.scope, "fixture");
        if (hold) { asked(); await held; }
        return { action: "accept", content: {}, _meta: { grant: "stdio" } };
      });
      await client.connect(transport);
      assert.equal((await client.listTools()).tools[0]?.name, "inspect");
      const first = CallToolResultSchema.parse(await client.callTool({ name: "inspect", _meta: { trace: "stdio" } }));
      const again = CallToolResultSchema.parse(await client.callTool({ name: "inspect" }));
      assert.equal(first.structuredContent?.pid, again.structuredContent?.pid, "one pipe preserves the native session");
      assert.deepEqual(first.content, [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }]);
      assert.equal((first.structuredContent?.meta as { trace: string }).trace, "stdio");
      assert.deepEqual(first._meta, { source: "fixture" });
      const approved = await client.callTool({ name: "inspect", arguments: { approve: true, mode: "openaiForm" } });
      assert.deepEqual(JSON.parse((approved.content as Array<{ text: string }>)[0]!.text), { action: "accept", content: {}, _meta: { grant: "stdio" } });
      if (ending === "cancel") {
        hold = true;
        const abort = new AbortController();
        const pending = client.callTool({ name: "inspect", arguments: { approve: true } }, undefined, { signal: abort.signal });
        await asking; abort.abort(); await assert.rejects(pending); release();
        await assert.rejects(client.listTools(), /closed|reconnect/i);
        await client.close();
      } else if (ending === "SIGTERM") {
        const closed = new Promise<void>(resolve => { client.onclose = resolve; });
        process.kill(transport.pid!, "SIGTERM"); await closed;
      } else await client.close();
      assert.throws(() => process.kill(Number(first.structuredContent?.pid), 0), { code: "ESRCH" });
    }
    assert.equal((await readFile(join(root, "starts"), "utf8")).trim().split("\n").length, 3, "interrupted calls never restart or replay a backend");
    const module = join(root, "plugins", "cache", "openai-bundled", "chrome", "latest", "scripts");
    await mkdir(module, { recursive: true }); await writeFile(join(module, "browser-client.mjs"), "export const fixture = true;");
    for (const [name, launch] of Object.entries(await internalMcpLaunches(root, { kind: "operator" }, env)).filter(([name]) => codexMcpDefinition(name))) {
      const client = new Client({ name: "offline-all-bridges", version: "1" }); clients.push(client);
      await client.connect(new StdioClientTransport({ ...launch, env: { ...launch.env, FIXTURE_ALL_BRIDGES: "1" }, stderr: "pipe" }));
      assert.ok((await client.listTools()).tools.length, `${name} lists native tools without a Stack server`);
      await client.close();
    }
  } finally { await Promise.all(clients.map(client => client.close())); await rm(root, { recursive: true, force: true }); }
});

test("Codex HTTP MCP isolates sessions, preserves upstream tools/media/approvals, and reaps children", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "stack-codex-mcp-"));
  const binary = join(root, "codex");
  await mkdir(join(root, "packages"));
  await writeFile(binary, `#!${process.execPath}\n${runtime}`);
  await chmod(binary, 0o700);
  const env = { ...process.env, STACK_STATE_DIR: join(root, "state"), STACK_CODEX_TOOLS_HOME: root, STACK_CODEX_TOOLS_BIN: binary };
  let botLive = true, workerLive = true;
  const workerId = randomUUID(), instance = randomUUID(), endpoint = "unix:///fixture/bot.sock";
  const socket = async (name: string, responses: Record<string, () => unknown>) => serveSocket({
    info: { name, description: "Fixture", transportDescription: "Fixture", path: socketPath(name, env) }, context: {},
    operations: Object.entries(responses).map(([name, call]) => operation({ name, description: "Fixture", input: z.any(), output: z.any(), async call() { return call(); } })),
  });
  const bots = await socket("bots", { bot_list: () => ({ bots: [{ id: "bot-1", url: endpoint, state: botLive ? "running" : "stopped", recoveryIssue: null }] }) });
  const workers = await socket("worker", {
    worker_status: () => ({ worker: { accountId: "account", phase: workerLive ? "running" : "completed", runtimeInstance: instance } }),
    worker_runtime_list: () => ({ runtimes: [{ id: "account", state: "running", instance }] }),
  });
  const listener = await serveMcp({ root, env, port: 0 });
  const clients: Client[] = [];
  let waitForApproval: (() => Promise<void>) | undefined;
  const connect = async (elicitation = false, url = listener.urls.messages!, headers: Record<string, string> = operatorHeaders(env)) => {
    const client = new Client({ name: "fixture", version: "1" }, { capabilities: elicitation ? { elicitation: { form: {} } } : {} });
    const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } });
    clients.push(client);
    if (elicitation) client.setRequestHandler(ElicitRequestSchema, async request => {
      assert.equal(request.params._meta?.scope, "fixture");
      await waitForApproval?.();
      return { action: "accept", content: {}, _meta: { grant: "once" } };
    });
    await client.connect(transport);
    return { client, transport };
  };
  try {
    assert.deepEqual(Object.keys(listener.urls).sort(), ["chrome", "computer-history", "computer-use", "messages", "openai-developer-docs"]);
    assert.equal((await fetch(listener.urls.messages!, { method: "POST" })).status, 401);
    const first = await connect(true);
    const second = await connect();
    const listed = await first.client.listTools();
    assert.equal(listed.tools[0]?.name, "inspect");
    assert.deepEqual(listed.tools[0]?.inputSchema.properties, { approve: { type: "boolean" }, mode: { type: "string" } });
    const result = CallToolResultSchema.parse(await first.client.callTool({ name: "inspect", arguments: {}, _meta: { trace: "caller", "x-codex-turn-metadata": { session_id: "forged" } } }));
    const other = CallToolResultSchema.parse(await second.client.callTool({ name: "inspect", arguments: {} }));
    assert.deepEqual(result.content, [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }]);
    assert.deepEqual(result._meta, { source: "fixture" });
    assert.notEqual(result.structuredContent?.pid, other.structuredContent?.pid);
    const identity = result.structuredContent?.meta as Record<string, { session_id: string; turn_id: string }>;
    assert.equal(identity["x-codex-turn-metadata"]?.session_id, `thread-${result.structuredContent?.pid}`);
    assert.equal(identity.trace, "caller");
    for (const mode of ["form", "openaiForm"]) {
      const approved = await first.client.callTool({ name: "inspect", arguments: { approve: true, mode } });
      assert.deepEqual(JSON.parse((approved.content as Array<{ text: string }>)[0]!.text), { action: "accept", content: {}, _meta: { grant: "once" } });
    }
    const cancelled = await second.client.callTool({ name: "inspect", arguments: { approve: true } });
    assert.deepEqual(JSON.parse((cancelled.content as Array<{ text: string }>)[0]!.text), { action: "cancel" });
    const wrongRoute = await fetch(listener.urls.chrome!, { method: "DELETE", headers: { ...operatorHeaders(env), "mcp-session-id": first.transport.sessionId! } });
    assert.equal(wrongRoute.status, 404);
    const botUrl = botMcpUrl(listener.urls.messages!, "bot-1", endpoint, env);
    const workerUrl = workerMcpUrl(listener.urls.messages!, workerId, instance, env);
    const bot = await connect(false, botUrl, {});
    const worker = await connect(false, workerUrl, {});
    assert.equal((await bot.client.listTools()).tools[0]?.name, "inspect");
    assert.equal((await worker.client.callTool({ name: "inspect" })).isError, false);
    for (const url of [listener.urls.messages!, workerUrl]) {
      const headers = url === workerUrl ? {} : operatorHeaders(env);
      assert.equal((await fetch(url, { method: "DELETE", headers: { ...headers, "mcp-session-id": bot.transport.sessionId! } })).status, 404);
    }
    botLive = false; workerLive = false;
    for (const [url, transport] of [[botUrl, bot.transport], [workerUrl, worker.transport]] as const)
      assert.equal((await fetch(url, { method: "DELETE", headers: { "mcp-session-id": transport.sessionId! } })).status, 401);
    let asked!: () => void, released!: () => void;
    const asking = new Promise<void>(resolve => { asked = resolve; }), release = new Promise<void>(resolve => { released = resolve; });
    waitForApproval = () => { asked(); return release; };
    const abort = new AbortController();
    const pending = first.client.callTool({ name: "inspect", arguments: { approve: true } }, undefined, { signal: abort.signal });
    await asking;
    abort.abort();
    await assert.rejects(pending);
    released();
    await assert.rejects(first.client.listTools(), /closed|reconnect/i);
    await first.transport.terminateSession();
    const stale = await fetch(listener.urls.messages!, { method: "DELETE", headers: { ...operatorHeaders(env), "mcp-session-id": first.transport.sessionId ?? "closed" } });
    assert.equal(stale.status, 404);
    await listener.close();
    for (const pid of (await readFile(join(root, "starts"), "utf8")).trim().split("\n").map(Number)) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  } finally { await Promise.all(clients.map(client => client.close())); await listener.close(); await bots.close(); await workers.close(); await rm(root, { recursive: true, force: true }); }
});

test("Codex tools diagnostics observe the installation only on an explicit, single-flight check", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "stack-codex-diagnostics-"));
  const binary = join(root, "codex");
  const log = join(root, "methods");
  // node_repl and messages are listed; computer-history and openaiDeveloperDocs are absent.
  await writeFile(binary, `#!${process.execPath}
import {createInterface} from 'node:readline';
import {appendFileSync} from 'node:fs';
const send = value => process.stdout.write(JSON.stringify(value)+'\\n');
createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if(m.method) appendFileSync(${JSON.stringify(log)}, process.pid+' '+m.method+'\\n');
 if(m.method==='initialize') send({id:m.id,result:{}});
 else if(m.method==='thread/start') send({id:m.id,result:{thread:{id:'probe'}}});
 else if(m.method==='mcpServerStatus/list') send({id:m.id,result:{data:[{name:'node_repl',runtimeStatus:'ready',tools:{js:{name:'js',inputSchema:{type:'object'}}}},{name:'messages',runtimeStatus:'ready',tools:{a:{},b:{}}},{name:'computer-history',runtimeStatus:'disabled',tools:{c:{}}}],nextCursor:null}});
 else if(m.method==='mcpServer/tool/call') send({id:m.id,result:{content:[{type:'text',text:JSON.stringify({chromeBrowsers:m.params.arguments.code.includes('browser-client.mjs')?2:-1})}],isError:false}});
});
`);
  await chmod(binary, 0o700);
  const plugin = join(root, "plugins", "cache", "openai-bundled", "chrome", "latest", "scripts");
  await mkdir(plugin, { recursive: true });
  await writeFile(join(plugin, "browser-client.mjs"), "");
  const env: NodeJS.ProcessEnv = { STACK_CODEX_TOOLS_HOME: root, STACK_CODEX_TOOLS_BIN: binary };
  const diagnostics = new CodexToolsDiagnostics(env);
  const catalog = (name: string) => diagnostics.snapshot().connections.find((item) => item.name === name)!;
  const methods = async () => (await readFile(log, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map((line) => line.split(" "));
  try {
    assert.equal(diagnostics.snapshot().runtime.state, "not_checked");
    assert.ok(diagnostics.snapshot().connections.every((item) => item.catalog.state === "not_checked"));
    assert.deepEqual(await methods(), [], "reading never starts a runtime");

    const first = diagnostics.check();
    const joined = diagnostics.check({ chromeBrowser: true });
    assert.equal(first.admitted, true);
    assert.equal(joined.admitted, false);
    assert.ok(joined.status.checking);
    await diagnostics.settled();
    const status = diagnostics.snapshot();
    assert.equal(status.checking, null);
    assert.deepEqual([status.runtime.state, status.runtime.source], ["found", "override"]);
    assert.deepEqual(Object.fromEntries(status.connections.map((item) => [item.name, item.catalog.state])), {
      "computer-use": "available", chrome: "available", messages: "available", "computer-history": "unavailable", "openai-developer-docs": "unavailable" });
    assert.equal(catalog("messages").catalog.tools, 2);
    assert.equal(catalog("computer-history").catalog.problem?.code, "plugin_unavailable");
    assert.equal(catalog("chrome").browser?.state, "not_checked", "catalog availability is not a connected browser");
    const firstRun = await methods();
    assert.equal(new Set(firstRun.map(([pid]) => pid)).size, 1, "joined checks share one runtime");
    assert.deepEqual(firstRun.map(([, method]) => method), ["initialize", "initialized", "thread/start", "mcpServerStatus/list"]);

    assert.equal(diagnostics.check({ chromeBrowser: true }).admitted, true);
    await diagnostics.settled();
    assert.deepEqual([catalog("chrome").browser?.state, catalog("chrome").browser?.problem?.code], ["multiple", "multiple_browsers"]);
    assert.ok(!(await methods()).some(([, method]) => method.startsWith("turn/")), "no model turn starts");
    for (const pid of new Set((await methods()).map(([pid]) => Number(pid)))) assert.throws(() => process.kill(pid, 0), /ESRCH/, "probe runtimes are reaped");

    // A failed refresh replaces earlier availability instead of leaving it current.
    const before = catalog("messages").catalog.checkedAt!;
    await writeFile(binary, `#!${process.execPath}\nprocess.exit(3);\n`);
    diagnostics.check();
    await diagnostics.settled();
    assert.ok(diagnostics.snapshot().connections.every((item) => item.catalog.state === "failed" && item.catalog.problem?.code === "probe_failed"));
    assert.ok(catalog("messages").catalog.checkedAt! >= before);
    assert.equal(catalog("chrome").browser?.state, "not_checked");

    env.STACK_CODEX_TOOLS_BIN = join(root, "missing");
    diagnostics.check();
    await diagnostics.settled();
    assert.equal(diagnostics.snapshot().runtime.state, "missing");
    assert.ok(diagnostics.snapshot().connections.every((item) => item.catalog.state === "unavailable" && item.catalog.problem?.code === "runtime_missing"));
    assert.doesNotMatch(JSON.stringify(diagnostics.snapshot()), new RegExp(root), "observations carry no local paths");
  } finally { await diagnostics.close(); await rm(root, { recursive: true, force: true }); }
});
