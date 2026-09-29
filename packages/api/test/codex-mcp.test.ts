import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema, ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { serveMcp } from "../src/mcp.js";
import { operatorHeaders } from "../src/local-auth.js";
import { botMcpUrl, workerMcpUrl } from "../src/bot-mcp-identity.js";
import { serveSocket } from "../src/socket.js";
import { socketPath } from "../src/workspace.js";
import { operation } from "../src/operation.js";

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
 else if(m.method==='mcpServerStatus/list') send({id:m.id,result:{data:[{name:'messages',runtimeStatus:'ready',tools:{inspect:tool}}],nextCursor:null}});
 else if(m.method==='mcpServer/tool/call') {
  if(m.params.arguments.approve) {waiting=m;send({id:900,method:'mcpServer/elicitation/request',params:{mode:m.params.arguments.mode??'form',threadId:m.params.threadId,turnId:m.params._meta['x-codex-turn-metadata'].turn_id,serverName:'messages',message:'Allow fixture read?',requestedSchema:{type:'object',properties:{},required:[]},_meta:{scope:'fixture'}}});}
  else send({id:m.id,result:{content:[{type:'image',data:'aGVsbG8=',mimeType:'image/png'}],structuredContent:{pid:process.pid,meta:m.params._meta},isError:false,_meta:{source:'fixture'}}});
 } else if(m.id===900 && waiting) {send({id:waiting.id,result:{content:[{type:'text',text:JSON.stringify(m.result)}],isError:false,structuredContent:null}});waiting=null;}
});
`;

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
