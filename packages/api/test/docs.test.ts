import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { docsSnapshot, serveApi, socketCall } from "../src/index.js";

type TransportDoc = { type: string; description: string; supported: boolean; subscriptions: boolean; endpoint: string | null;
  operations: string[]; routes: Array<{ surface: string; surfaceDescription: string; kind: "json" | "static"; authentication: "bearer" | "none";
    method: string; path: string; description: string; format: string; operation: string | null;
    inputSchema: Record<string, unknown> | null; querySchema: Record<string, unknown> | null;
    outputSchema: Record<string, unknown> | null; errorSchema: Record<string, unknown> | null }> };
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
       ["api", "attention", "auth", "bots", "brain", "browser", "content", "infer", "notify", "owner", "roles", "usage", "workers"],
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

    const brainHttp = found.get("brain")!.transports.find((transport) => transport.type === "http")!;
    assert.deepEqual(brainHttp.operations, []);
    assert.deepEqual(brainHttp.routes.map(({ surface, kind, method, path, operation }) => [surface, kind, method, path, operation]), [
      ["share", "json", "GET", "/v1/health", "share_health"], ["share", "json", "GET", "/v1/shares", "share_states"],
      ["share", "json", "POST", "/v1/share", "share_admit"],
    ]);
    assert.ok(brainHttp.routes.every((route) => route.authentication === "bearer" && route.format === "application/json" && route.outputSchema && route.errorSchema));
    const admitRoute = brainHttp.routes.find((route) => route.operation === "share_admit")!;
    assert.deepEqual(admitRoute.inputSchema?.required, ["client"]);
    assert.ok(admitRoute.inputSchema?.properties && "idempotency_key" in (admitRoute.inputSchema.properties as object));
    assert.ok(!("idempotencyKey" in (admitRoute.inputSchema?.properties as object)));
    assert.ok(admitRoute.outputSchema?.properties && "meta" in (admitRoute.outputSchema.properties as object));
    assert.ok(admitRoute.outputSchema?.properties && "data" in (admitRoute.outputSchema.properties as object));
    assert.ok(admitRoute.errorSchema?.properties && "error" in (admitRoute.errorSchema.properties as object));
    const statesRoute = brainHttp.routes.find((route) => route.operation === "share_states")!;
    assert.ok(statesRoute.querySchema?.properties && "job_ids" in (statesRoute.querySchema.properties as object));
    assert.equal(statesRoute.inputSchema, null, "GET has no JSON request body");
    assert.equal(brainHttp.routes.find((route) => route.operation === "share_health")!.inputSchema, null);
    assert.ok(!found.get("brain")!.operations.some((operation) => operation.name === "share_admit"));
    const contentHttp = found.get("content")!.transports.find((transport) => transport.type === "http")!;
    assert.ok(contentHttp.routes.some((route) => route.surface === "artifacts" && route.path === "/a/*" && route.operation === null && route.format === "artifact media type" && route.authentication === "none" && route.outputSchema === null));
    const browser = found.get("browser") as PackageDoc;
    assert.deepEqual(browser.transports.map((transport) => transport.type), ["socket", "websocket"]);
    assert.deepEqual(browser.operations.map((operation) => operation.name).sort(),
      ["browser_status", "browser_session_launch", "browser_session_get", "browser_session_list", "browser_session_close", "browser_session_reconcile",
        "agent_browser_status", "agent_browser_detect", "agent_browser_check_updates", "agent_browser_update_policy_set",
        "agent_browser_install", "agent_browser_update_accept", "agent_browser_uninstall",
        "hypeman_detect", "hypeman_location_set", "hypeman_enable", "hypeman_install", "hypeman_uninstall"].sort());
    assert.deepEqual(Object.keys(browser.events), ["browser_system_changed", "browser_sessions_changed"]);
    assert.deepEqual(Object.keys(browser.operations.find((operation) => operation.name === "browser_session_launch")?.inputSchema.properties ?? {}), ["session"]);

    const bots = found.get("bots") as PackageDoc;
    assert.deepEqual(Object.keys(bots.events).sort(), ["bots_changed", "chat_live_changed", "chat_queue_changed", "chats_changed", "defaults_changed", "threads_changed", "voice_changed"]);
    assert.equal(bots.eventScope?.required, false);
    assert.deepEqual(
      bots.operations.map((operation) => operation.name).sort(),
      ["bot_assign", "bot_defaults_get", "bot_defaults_set", "bot_list", "bot_remove", "bot_start", "bot_stop", "voice_dial", "voice_hangup", "voice_speak", "voice_status",
        "chat_list", "chat_tree", "chat_tree_detail", "chat_search", "chat_records", "chat_record_chunk", "chat_message_changes", "chat_thread_read", "chat_turns", "chat_items", "chat_main_live", "chat_main_items", "chat_occurrences", "chat_open", "chat_send", "chat_steer", "chat_interrupt", "chat_enqueue", "chat_queue_list", "chat_queue_resolve",
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
    assert.equal(botsWebSocket.endpoint, "ws://127.0.0.1:8744/websocket");
    assert.deepEqual(new Set([...found.values()].flatMap((server) => server.transports
      .filter((transport) => transport.type === "websocket")
      .map((transport) => transport.endpoint))), new Set([botsWebSocket.endpoint]));

    const auth = found.get("auth") as PackageDoc;
    const roles = found.get("roles") as PackageDoc;
    assert.deepEqual(Object.keys(roles.events), ["role_changed"]);
    assert.deepEqual(roles.operations.map((operation) => operation.name).sort(), [
      "role_preview", "role_snapshot", "category_create", "category_delete", "category_reorder", "category_update",
      "fragment_create", "fragment_delete", "fragment_move", "fragment_reorder", "fragment_update",
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
    assert.match(auth.operations.find((operation) => operation.name === "account_login_start")?.description ?? "", /already registered.*rejected/);
    const botAccount = auth.operations.find((operation) => operation.name === "account_list") as OperationDoc;
    const workerAccount = auth.operations.find((operation) => operation.name === "worker_account_list") as OperationDoc;
    assert.ok(JSON.stringify(botAccount.outputSchema).includes("linkedAccounts"));
    assert.ok(JSON.stringify(workerAccount.outputSchema).includes("linkedAccounts"));
    const prepareWorker = auth.operations.find((operation) => operation.name === "worker_account_prepare") as OperationDoc;
    const loginWorker = auth.operations.find((operation) => operation.name === "worker_account_login_start") as OperationDoc;
    assert.ok(JSON.stringify(prepareWorker.inputSchema).includes('"claude"'));
    assert.ok(JSON.stringify(loginWorker.inputSchema).includes('"claude"'));
    assert.ok(JSON.stringify(workerAccount.outputSchema).includes('"claude"'));
    const workers = found.get("workers") as PackageDoc;
    const content = found.get("content") as PackageDoc;
    assert.ok(content.operations.some((op) => op.name === "artifact_publish"));
    assert.ok(content.operations.some((op) => op.name === "content_status"));
    for (const name of ["collection_create", "collection_list", "collection_get", "collection_update", "collection_delete", "item_put", "item_list", "item_get", "item_move", "item_delete", "item_read", "document_update", "blob_stage_start", "blob_stage_chunk", "blob_stage_status", "blob_stage_finish"])
      assert.ok(content.operations.some((op) => op.name === name), name);
    for (const name of ["path", "publish", "doctor", "reindex", "commit"]) assert.equal(content.operations.some((op) => op.name === name), false);
    assert.deepEqual(Object.keys(content.operations.find((op) => op.name === "content_status")?.outputSchema.properties ?? {}).sort(), ["artifactPath", "documentPath", "itemPath"]);
    assert.equal(JSON.stringify(content.operations.find((op) => op.name === "item_put")?.inputSchema).includes('"path"'), false);
    assert.equal(content.transports.find((transport) => transport.type === "mcp")?.supported, true);
    const brain = found.get("brain") as PackageDoc;
    assert.ok(brain.operations.length > 0);
    assert.ok(brain.operations.every((operation) => operation.description && operation.inputSchema.type === "object" && operation.outputSchema.type === "object"));
    assert.deepEqual(brain.transports.map((transport) => transport.type).sort(), ["http", "mcp", "socket", "websocket"]);
    assert.ok(brain.transports.every((transport) => transport.supported));
    assert.equal(brain.transports.find((transport) => transport.type === "socket")?.endpoint, join(stateDir, "sockets", "brain.sock"));
    assert.equal(brain.transports.find((transport) => transport.type === "mcp")?.endpoint, "http://127.0.0.1:8743/mcp/brain");
    assert.equal(brain.transports.find((transport) => transport.type === "websocket")?.endpoint, "ws://127.0.0.1:8744/websocket");
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
    const workerRecord = (workerDetail.outputSchema.properties as Record<string, { properties: Record<string, unknown> }>).worker;
    assert.ok(workerRecord.properties.sessionId, "Worker session identity is native-runtime neutral");
    assert.equal(workerRecord.properties.acpSessionId, undefined);
    assert.ok(JSON.stringify(workerRecord).includes('"claude"'));
    for (const name of ["worker_catalog", "worker_runtime_list"]) {
      assert.ok(JSON.stringify(workers.operations.find((operation) => operation.name === name)?.outputSchema).includes('"claude"'));
    }
    const workerTurns = workers.operations.find((operation) => operation.name === "worker_turn_list") as OperationDoc;
    for (const field of ["prompt", "requestedModel", "observedSettings", "dispatchedPromptSeq"]) assert.ok(JSON.stringify(workerTurns.outputSchema).includes(`"${field}"`));
    assert.ok(JSON.stringify(workers.operations.find((operation) => operation.name === "worker_tool_list")?.outputSchema).includes('"hierarchyVerified"'));

    const usage = found.get("usage") as PackageDoc;
    assert.deepEqual(Object.keys(usage.events), ["usage_changed"]);
    assert.deepEqual(usage.operations.map((operation) => operation.name), ["usage_snapshot"]);
    assert.equal(usage.operations[0]?.annotations.readOnlyHint, true);
    assert.deepEqual(Object.keys(usage.operations[0]?.outputSchema.properties ?? {}).sort(), ["accounts", "atMs", "grokBot", "inventoryAtMs", "inventoryError"]);
    assert.ok(JSON.stringify(usage.operations[0]?.outputSchema).includes("allocatedUsd"));
    assert.ok(JSON.stringify(usage.operations[0]?.outputSchema).includes('"claude"'));
    assert.ok(JSON.stringify(usage.operations[0]?.outputSchema).includes('"extraUsage"'));
    assert.equal(usage.transports.find((transport) => transport.type === "socket")?.endpoint, join(stateDir, "sockets", "usage.sock"));
    assert.equal(usage.transports.find((transport) => transport.type === "websocket")?.subscriptions, true);

    const infer = found.get("infer") as PackageDoc;
    const inferOperation = (name: string) => infer.operations.find((operation) => operation.name === name)!;
    assert.deepEqual(infer.operations.map((operation) => operation.name),
      ["infer_models", "infer_model_list", "infer_discover", "infer_complete", "infer_start", "infer_request_list", "infer_request_get", "infer_trace_read"]);
    assert.deepEqual(Object.keys(infer.events), ["infer_changed"]);
    assert.deepEqual(Object.keys(inferOperation("infer_models").outputSchema.properties ?? {}).sort(), ["models", "observedAt"]);
    assert.deepEqual(Object.keys(inferOperation("infer_complete").inputSchema.properties ?? {}).sort(), ["accountId", "effort", "input", "instructions", "maxOutputTokens", "model", "requestId"]);
    assert.equal(inferOperation("infer_complete").annotations.readOnlyHint, false);
    // infer_start takes the same input with a required request ID and returns the ledger record while it runs.
    assert.ok((inferOperation("infer_start").inputSchema.required as string[] | undefined)?.includes("requestId"));
    assert.equal(inferOperation("infer_start").annotations.idempotentHint, true);
    assert.ok(Object.keys(inferOperation("infer_start").outputSchema.properties ?? {}).includes("state"));
    for (const name of ["infer_model_list", "infer_request_list", "infer_request_get"]) assert.equal(inferOperation(name).annotations.readOnlyHint, true);
    // The UIX Lab reaches inference over the loopback WebSocket; agents get no MCP route to spend allowance.
    assert.deepEqual(infer.transports.map((transport) => transport.type), ["socket", "websocket"]);
    assert.equal(infer.transports.find((transport) => transport.type === "websocket")?.subscriptions, true);
    assert.equal(infer.transports[0]?.endpoint, join(stateDir, "sockets", "infer.sock"));
    const attention = found.get("attention") as PackageDoc;
    assert.deepEqual(attention.transports.map((transport) => transport.type), ["socket", "websocket"]);
    assert.deepEqual(Object.keys(attention.events), ["attention_changed"]);
    assert.ok(attention.operations.some((operation) => operation.name === "attention_replay"));
    assert.deepEqual(Object.keys(attention.operations.find((operation) => operation.name === "attention_defaults_get")!.outputSchema.properties ?? {}).sort(), ["accountId", "model", "reasoningEffort", "revision"]);

    const notify = found.get("notify") as PackageDoc;
    assert.deepEqual(notify.operations.map((operation) => operation.name),
      ["notification_send", "notification_get", "notification_list", "notification_update", "notification_acknowledge", "notification_dismiss", "notification_dismiss_all"]);
    assert.deepEqual(Object.keys(notify.events), ["notify_changed"]);
    assert.deepEqual(notify.transports.map((transport) => transport.type), ["socket", "mcp", "websocket"]);
    assert.equal(notify.transports.find((transport) => transport.type === "socket")?.endpoint, join(stateDir, "sockets", "notify.sock"));
    assert.equal(notify.transports.find((transport) => transport.type === "mcp")?.endpoint, "http://127.0.0.1:8743/mcp/notify");
    assert.equal(notify.transports.find((transport) => transport.type === "websocket")?.endpoint, "ws://127.0.0.1:8744/websocket/notify");
    assert.ok((notify.operations.find((operation) => operation.name === "notification_update")!.inputSchema.required as string[]).includes("expectedRevision"));
    assert.ok(JSON.stringify(notify.operations.find((operation) => operation.name === "notification_list")!.outputSchema).includes("acknowledgedAt"));
    assert.ok(JSON.stringify(notify.operations.find((operation) => operation.name === "notification_list")!.outputSchema).includes("dismissedAt"));

    assert.deepEqual(bots.eventScope, {
      description: "Optional bot ID. Scoped subscriptions receive changes only for that bot; omit scope to receive global voice, defaults, and bot notices.",
      example: "bot-1",
      required: false,
    });

    const owner = found.get("owner") as PackageDoc;
    assert.deepEqual(Object.keys(owner.operations[0]?.outputSchema.properties ?? {}).sort(), ["children", "indexUrl", "inspectorUrl", "mcpUrls", "nodeVersion", "pid", "startedAt", "uixUrl"]);
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
