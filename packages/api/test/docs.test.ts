import assert from "node:assert/strict";
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
      ["api", "auth", "bots", "owner", "roles", "workers"],
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
    assert.deepEqual(Object.keys(bots.events).sort(), ["bots_changed", "threads_changed", "voice_changed"]);
    assert.equal(bots.eventScope?.required, false);
    assert.deepEqual(
      bots.operations.map((operation) => operation.name).sort(),
      ["bot_assign", "bot_list", "bot_remove", "bot_start", "bot_stop", "voice_dial", "voice_hangup", "voice_status"],
    );
    const start = bots.operations.find((operation) => operation.name === "bot_start") as OperationDoc;
    assert.ok(start.description.length > 0);
    assert.deepEqual(Object.keys((start.inputSchema.properties ?? {}) as object).sort(), ["args", "cwd", "id"]);
    assert.ok((start.outputSchema.properties as Record<string, unknown>).recoveryIssue);
    assert.ok((start.outputSchema.properties as Record<string, unknown>).roleRevision);
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
    assert.deepEqual(Object.keys(auth.events).sort(), ["accounts_changed", "login_changed", "worker_accounts_changed"]);
    assert.deepEqual(
      auth.operations.map((operation) => operation.name).sort(),
      ["account_activate", "account_list", "account_login_cancel", "account_login_current", "account_login_replace", "account_login_start", "account_login_status", "account_remove",
        "worker_account_list", "worker_account_prepare", "worker_account_confirm", "worker_account_set_enabled", "worker_account_remove"].sort(),
    );
    assert.deepEqual((auth.operations.find((operation) => operation.name === "account_login_start")?.inputSchema.properties ?? {}), {});
    const workers = found.get("workers") as PackageDoc;
    assert.deepEqual(Object.keys(workers.events), ["workers_changed"]);
    assert.deepEqual(workers.operations.map((operation) => operation.name), ["worker_catalog", "worker_runtime_list", "worker_account_drain"]);

    assert.deepEqual(bots.eventScope, {
      description: "Optional bot ID. Scoped subscriptions receive changes only for that bot; omit scope to receive global voice and bot notices.",
      example: "bot-1",
      required: false,
    });

    const owner = found.get("owner") as PackageDoc;
    assert.deepEqual(Object.keys(owner.events), ["pids_changed"]);
    assert.deepEqual(owner.operations.map((operation) => operation.name), ["owner_status"]);
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
