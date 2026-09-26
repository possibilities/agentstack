import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { docsSnapshot, serveApi, socketCall } from "../src/index.js";

type TransportDoc = { type: string; description: string; supported: boolean; subscriptions: boolean; endpoint: string | null };
type OperationDoc = { name: string; title: string | null; description: string; annotations: Record<string, unknown>; inputSchema: Record<string, unknown>; outputSchema: Record<string, unknown> };
type PackageDoc = { name: string; description: string; packageName: string; operations: OperationDoc[]; events: Record<string, string>; eventScope: { description: string; example: string; required: boolean } | null; transports: TransportDoc[] };

test("the api package serves structured documents for every workspace package", { timeout: 60_000 }, async () => {
  assert.equal(docsSnapshot.name, "docs_snapshot");
  const stateDir = await mkdtemp(join(tmpdir(), "agentstack-docs-"));
  const env = { ...process.env, AGENTSTACK_STATE_DIR: stateDir, AGENTSTACK_MCP_PORT: "8743", AGENTSTACK_WEBSOCKET_PORT: "8744" };
  const served = await serveApi({ name: "api", transport: "socket", env });
  try {
    assert.equal(served.socketPath, join(stateDir, "sockets", "api.sock"));
    const listed = (await socketCall(served.socketPath, "tools/list")) as {
      server: { name: string };
      events: unknown;
      tools: Array<{ name: string }>;
    };
    assert.equal(listed.server.name, "api");
    assert.equal(listed.events, null);
    assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), ["docs_get", "docs_list", "docs_snapshot"]);

    const docs = (await socketCall(served.socketPath, "tools/call", { name: "docs_list", arguments: {} })) as {
      packages: Array<{ name: string; description: string; packageName: string }>;
    };
    assert.deepEqual(
      docs.packages.map((item) => item.name),
      ["api", "auth", "bots", "brain", "infer", "owner", "roles", "usage", "wiki", "workers"],
    );
    assert.ok(docs.packages.every((item) => item.description.length > 0 && item.packageName === `@agentstack/${item.name}`));

    const found = new Map<string, PackageDoc>();
    for (const item of docs.packages) {
      const doc = (await socketCall(served.socketPath, "tools/call", {
        name: "docs_get",
        arguments: { package: item.name },
      })) as PackageDoc;
      assert.equal(doc.name, item.name);
      found.set(doc.name, doc);
    }
    const snapshot = (await socketCall(served.socketPath, "tools/call", { name: "docs_snapshot", arguments: {} })) as { packages: PackageDoc[] };
    assert.deepEqual(snapshot.packages, [...found.values()]);
    const responseLength = JSON.stringify({ id: 1, result: snapshot }).length + 1;
    assert.ok(responseLength < 750_000, `discovery snapshot exceeds the socket response budget: ${responseLength} characters`);

    const bots = found.get("bots") as PackageDoc;
    assert.deepEqual(Object.keys(bots.events).sort(), ["bots_changed", "chat_queue_changed", "chats_changed", "defaults_changed", "threads_changed", "voice_changed"]);
    assert.equal(bots.eventScope?.required, false);
    assert.deepEqual(
      bots.operations.map((operation) => operation.name).sort(),
      ["bot_assign", "bot_defaults_get", "bot_defaults_set", "bot_list", "bot_remove", "bot_start", "bot_stop", "voice_dial", "voice_hangup", "voice_speak", "voice_status",
        "chat_list", "chat_tree", "chat_tree_detail", "chat_search", "chat_records", "chat_record_chunk", "chat_thread_read", "chat_turns", "chat_items", "chat_main_live", "chat_main_items", "chat_occurrences", "chat_open", "chat_send", "chat_steer", "chat_interrupt", "chat_enqueue", "chat_queue_list", "chat_queue_resolve",
        "chat_codex_queue_add", "chat_codex_queue_list", "chat_codex_queue_update", "chat_codex_queue_delete", "chat_codex_queue_reorder", "chat_codex_queue_start", "chat_upload_start", "chat_upload_status", "chat_upload_chunk", "chat_upload_finish", "chat_attachment_add", "chat_attachment_list", "chat_attachment_remove"].sort(),
    );
    const start = bots.operations.find((operation) => operation.name === "bot_start") as OperationDoc;
    assert.ok(start.description.length > 0);
    assert.deepEqual(Object.keys((start.inputSchema.properties ?? {}) as object).sort(), ["account", "args", "cwd", "id", "settings"]);
    assert.deepEqual(start.inputSchema.required, ["account"]);
    assert.ok((start.outputSchema.properties as Record<string, unknown>).recoveryIssue);
    assert.ok((start.outputSchema.properties as Record<string, unknown>).roleRevision);
    assert.ok((start.outputSchema.properties as Record<string, unknown>).settings);
    assert.deepEqual(Object.keys(bots.operations.find((operation) => operation.name === "bot_defaults_get")?.outputSchema.properties ?? {}).sort(), ["approvalPolicy", "model", "reasoningEffort", "sandboxMode"]);
    const speech = bots.operations.find((operation) => operation.name === "voice_speak") as OperationDoc;
    assert.deepEqual(Object.keys(speech.inputSchema.properties ?? {}).sort(), ["sessionId", "text"]);
    assert.deepEqual(Object.keys(speech.outputSchema.properties ?? {}).sort(), ["sessionId", "status"]);
    assert.equal(speech.annotations.idempotentHint, undefined);
    assert.deepEqual(Object.keys(bots.operations.find((operation) => operation.name === "chat_search")?.inputSchema.properties ?? {}).sort(), ["botId", "limit", "offset", "query"]);
    assert.deepEqual(Object.keys(bots.operations.find((operation) => operation.name === "chat_records")?.outputSchema.properties ?? {}).sort(), ["nextLine", "records"]);
    const tree = bots.operations.find((operation) => operation.name === "chat_tree") as OperationDoc;
    assert.equal(tree.annotations.readOnlyHint, true);
    assert.deepEqual(Object.keys(tree.outputSchema.properties ?? {}).sort(), ["coverage", "nextOffset", "observedAt", "rootThreadId", "rows", "snapshot", "total"]);
    for (const field of ["parentThreadId", "depth", "reasoningEffort", "configurationSource", "metadataTruncated"]) assert.ok(JSON.stringify(tree.outputSchema).includes(`"${field}"`));
    const treeDetail = bots.operations.find((operation) => operation.name === "chat_tree_detail") as OperationDoc;
    assert.equal(treeDetail.annotations.readOnlyHint, true);
    assert.ok((treeDetail.inputSchema.properties as Record<string, unknown>).revision);
    const botsSocket = bots.transports.find((transport) => transport.type === "socket") as TransportDoc;
    assert.equal(botsSocket.supported, true);
    assert.equal(botsSocket.subscriptions, true);
    assert.equal(botsSocket.endpoint, join(stateDir, "sockets", "bots.sock"));
    const botsMcp = bots.transports.find((transport) => transport.type === "mcp") as TransportDoc;
    assert.equal(botsMcp.supported, true);
    assert.equal(botsMcp.subscriptions, false);
    assert.equal(botsMcp.endpoint, "http://127.0.0.1:8743/mcp/bots");
    const botsWebSocket = bots.transports.find((transport) => transport.type === "websocket") as TransportDoc;
    assert.equal(botsWebSocket.subscriptions, true);
    assert.equal(botsWebSocket.endpoint, "ws://127.0.0.1:8744/websocket/bots");

    const auth = found.get("auth") as PackageDoc;
    const roles = found.get("roles") as PackageDoc;
    assert.deepEqual(Object.keys(roles.events), ["role_changed"]);
    assert.deepEqual(roles.operations.map((operation) => operation.name).sort(), [
      "role_preview", "role_snapshot", "category_create", "category_delete", "category_reorder", "category_update",
      "fragment_create", "fragment_delete", "fragment_reorder", "fragment_update",
      "skill_create", "skill_delete", "skill_reorder", "skill_update",
      "mcp_server_create", "mcp_server_delete", "mcp_server_reorder", "mcp_server_update",
      "project_create", "project_delete", "project_reorder", "project_update",
    ].sort());
    const roleView = roles.operations.find((operation) => operation.name === "role_snapshot") as OperationDoc;
    assert.deepEqual(Object.keys(roleView.outputSchema.properties as object).sort(), ["categories", "mcpServers", "revision", "skills", "trustedProjects"]);
    assert.equal(roles.transports.find((transport) => transport.type === "websocket")?.subscriptions, true);
    assert.deepEqual(Object.keys(auth.events).sort(), ["accounts_changed", "login_changed", "worker_accounts_changed", "worker_login_changed"]);
    assert.deepEqual(
      auth.operations.map((operation) => operation.name).sort(),
      ["account_set_enabled", "account_list", "account_login_cancel", "account_login_current", "account_login_replace", "account_login_start", "account_login_status", "account_remove",
        "worker_account_list", "worker_account_prepare", "worker_account_confirm", "worker_account_set_enabled", "worker_account_remove",
        "worker_account_login_start", "worker_account_login_status", "worker_account_login_current", "worker_account_login_submit", "worker_account_login_cancel"].sort(),
    );
    assert.deepEqual((auth.operations.find((operation) => operation.name === "account_login_start")?.inputSchema.properties ?? {}), {});
    const botAccount = auth.operations.find((operation) => operation.name === "account_list") as OperationDoc;
    const workerAccount = auth.operations.find((operation) => operation.name === "worker_account_list") as OperationDoc;
    assert.ok(JSON.stringify(botAccount.outputSchema).includes("linkedAccounts"));
    assert.ok(JSON.stringify(workerAccount.outputSchema).includes("linkedAccounts"));
    const workers = found.get("workers") as PackageDoc;
    const wiki = found.get("wiki") as PackageDoc;
    assert.ok(wiki.operations.some((op) => op.name === "publish"));
    assert.ok(wiki.operations.some((op) => op.name === "wiki_status"));
    assert.equal(wiki.transports.find((transport) => transport.type === "mcp")?.supported, true);
    const brain = found.get("brain") as PackageDoc;
    assert.ok(brain.operations.length > 0);
    assert.ok(brain.operations.every((operation) => operation.description && operation.inputSchema.type === "object" && operation.outputSchema.type === "object"));
    assert.deepEqual(brain.transports.map((transport) => transport.type).sort(), ["mcp", "socket", "websocket"]);
    assert.ok(brain.transports.every((transport) => transport.supported));
    assert.equal(brain.transports.find((transport) => transport.type === "socket")?.endpoint, join(stateDir, "sockets", "brain.sock"));
    assert.equal(brain.transports.find((transport) => transport.type === "mcp")?.endpoint, "http://127.0.0.1:8743/mcp/brain");
    assert.equal(brain.transports.find((transport) => transport.type === "websocket")?.endpoint, "ws://127.0.0.1:8744/websocket/brain");
    assert.equal(existsSync(join(stateDir, "brain")), false, "read-only discovery must not initialize Brain storage");
    assert.deepEqual(Object.keys(workers.events).sort(), ["worker_changed", "worker_progress", "workers_changed"]);
    assert.equal(workers.eventScope?.required, false);
    assert.deepEqual(workers.operations.map((operation) => operation.name), ["worker_catalog", "worker_runtime_list", "worker_account_drain",
      "worker_start", "worker_list", "worker_status", "worker_read", "worker_detail", "worker_turn_list", "worker_record_list", "worker_record_read", "worker_tool_list",
      "worker_send", "worker_respond", "worker_cancel", "worker_resume", "worker_close", "worker_remove"]);
    for (const name of ["worker_detail", "worker_turn_list", "worker_record_list", "worker_record_read", "worker_tool_list"]) {
      assert.equal(workers.operations.find((operation) => operation.name === name)?.annotations.readOnlyHint, true);
    }
    const workerDetail = workers.operations.find((operation) => operation.name === "worker_detail") as OperationDoc;
    assert.deepEqual(Object.keys(workerDetail.outputSchema.properties ?? {}).sort(), ["capture", "freshness", "metadata", "observedSettings", "subagents", "worker"]);
    const workerTurns = workers.operations.find((operation) => operation.name === "worker_turn_list") as OperationDoc;
    for (const field of ["prompt", "requestedModel", "observedSettings", "dispatchedPromptSeq"]) assert.ok(JSON.stringify(workerTurns.outputSchema).includes(`"${field}"`));
    assert.ok(JSON.stringify(workers.operations.find((operation) => operation.name === "worker_tool_list")?.outputSchema).includes('"hierarchyVerified"'));

    const usage = found.get("usage") as PackageDoc;
    assert.deepEqual(Object.keys(usage.events), ["usage_changed"]);
    assert.deepEqual(usage.operations.map((operation) => operation.name), ["usage_snapshot"]);
    assert.equal(usage.operations[0]?.annotations.readOnlyHint, true);
    assert.deepEqual(Object.keys(usage.operations[0]?.outputSchema.properties ?? {}).sort(), ["accounts", "atMs", "grokBot", "inventoryAtMs", "inventoryError"]);
    assert.ok(JSON.stringify(usage.operations[0]?.outputSchema).includes("allocatedUsd"));
    assert.equal(usage.transports.find((transport) => transport.type === "socket")?.endpoint, join(stateDir, "sockets", "usage.sock"));
    assert.equal(usage.transports.find((transport) => transport.type === "websocket")?.subscriptions, true);

    const infer = found.get("infer") as PackageDoc;
    assert.deepEqual(infer.operations.map((operation) => operation.name), ["infer_models", "infer_complete"]);
    assert.deepEqual(Object.keys(infer.operations[0]?.outputSchema.properties ?? {}).sort(), ["models", "observedAt"]);
    assert.deepEqual(Object.keys(infer.operations[1]?.inputSchema.properties ?? {}).sort(), ["accountId", "effort", "input", "instructions", "maxOutputTokens", "model"]);
    assert.equal(infer.operations[1]?.annotations.readOnlyHint, false);
    assert.deepEqual(infer.transports.map((transport) => transport.type), ["socket"]);
    assert.equal(infer.transports[0]?.endpoint, join(stateDir, "sockets", "infer.sock"));

    assert.deepEqual(bots.eventScope, {
      description: "Optional bot ID. Scoped subscriptions receive changes only for that bot; omit scope to receive global voice, defaults, and bot notices.",
      example: "bot-1",
      required: false,
    });

    const owner = found.get("owner") as PackageDoc;
    assert.deepEqual(Object.keys(owner.operations[0]?.outputSchema.properties ?? {}).sort(), ["children", "indexUrl", "inspectorUrl", "mcpUrls", "pid", "uixUrl"]);
    assert.deepEqual(Object.keys(owner.events), ["pids_changed", "resources_changed"]);
    assert.deepEqual(owner.operations.map((operation) => operation.name), ["owner_status", "owner_resources", "owner_resource_history"]);
    assert.equal(owner.operations[1].annotations.readOnlyHint, true);
    assert.equal(owner.operations[2].annotations.readOnlyHint, true);
    assert.ok(JSON.stringify(owner.operations[1].outputSchema).includes("cpuMeasuredProcessCount"));
    assert.ok(JSON.stringify(owner.operations[2].outputSchema).includes("retention"));
    const ownerSocket = owner.transports.find((transport) => transport.type === "socket") as TransportDoc;
    assert.equal(ownerSocket.subscriptions, true);
    assert.equal(ownerSocket.endpoint, join(stateDir, "sockets", "owner.sock"));

    const api = found.get("api") as PackageDoc;
    assert.deepEqual(api.events, {});
    assert.deepEqual(api.operations.map((operation) => operation.name).sort(), ["docs_get", "docs_list", "docs_snapshot"]);
    assert.equal(api.transports.find((transport) => transport.type === "socket")?.endpoint, join(stateDir, "sockets", "api.sock"));
    assert.equal(api.transports.find((transport) => transport.type === "websocket")?.subscriptions, false);

    const whole = JSON.stringify([...found.values()]);
    assert.ok(!whole.includes("auth_json"));
    assert.ok(!whole.includes("refresh_token"));
    assert.ok(!whole.includes("access_token"));

    await assert.rejects(
      socketCall(served.socketPath, "tools/call", { name: "docs_get", arguments: { package: "missing" } }),
      /unknown package API: missing/,
    );
    await assert.rejects(
      socketCall(served.socketPath, "tools/call", { name: "docs_get", arguments: { package: "NOPE" } }),
      /package/,
    );
  } finally {
    await served.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});
