import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { serveApi, socketCall } from "../src/index.js";

type TransportDoc = { type: string; description: string; supported: boolean; subscriptions: boolean; endpoint: string | null };
type OperationDoc = { name: string; title: string | null; description: string; annotations: Record<string, unknown>; inputSchema: Record<string, unknown>; outputSchema: Record<string, unknown> };
type PackageDoc = { name: string; description: string; packageName: string; operations: OperationDoc[]; events: Record<string, string>; transports: TransportDoc[] };

test("the api package serves structured documents for every workspace package", { timeout: 60_000 }, async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "agentstack-docs-"));
  const env = { ...process.env, AGENTSTACK_STATE_DIR: stateDir, AGENTSTACK_MCP_PORT: "8743" };
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
    assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), ["docs_get", "docs_list"]);

    const docs = (await socketCall(served.socketPath, "tools/call", { name: "docs_list", arguments: {} })) as {
      packages: Array<{ name: string; description: string; packageName: string }>;
    };
    assert.deepEqual(
      docs.packages.map((item) => item.name),
      ["api", "auth", "bots", "codex", "owner"],
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

    const codex = found.get("codex") as PackageDoc;
    assert.deepEqual(Object.keys(codex.events).sort(), ["inputs_changed", "servers_changed", "threads_changed"]);
    assert.deepEqual(
      codex.operations.map((operation) => operation.name).sort(),
      ["input_observe_list", "input_observe_start", "input_observe_stop", "server_list", "server_start", "server_stop"],
    );
    const start = codex.operations.find((operation) => operation.name === "server_start") as OperationDoc;
    assert.ok(start.description.length > 0);
    assert.deepEqual(Object.keys((start.inputSchema.properties ?? {}) as object).sort(), ["args", "cwd", "id"]);
    const codexSocket = codex.transports.find((transport) => transport.type === "socket") as TransportDoc;
    assert.equal(codexSocket.supported, true);
    assert.equal(codexSocket.subscriptions, true);
    assert.equal(codexSocket.endpoint, join(stateDir, "sockets", "codex.sock"));
    const codexMcp = codex.transports.find((transport) => transport.type === "mcp") as TransportDoc;
    assert.equal(codexMcp.supported, true);
    assert.equal(codexMcp.subscriptions, false);
    assert.equal(codexMcp.endpoint, "http://127.0.0.1:8743/mcp/codex");

    const auth = found.get("auth") as PackageDoc;
    assert.deepEqual(Object.keys(auth.events).sort(), ["accounts_changed", "login_changed"]);
    assert.deepEqual(
      auth.operations.map((operation) => operation.name).sort(),
      ["account_activate", "account_list", "account_login_cancel", "account_login_current", "account_login_start", "account_login_status", "account_remove"],
    );

    const bots = found.get("bots") as PackageDoc;
    assert.deepEqual(bots.events, {});
    assert.deepEqual(bots.operations.map((operation) => operation.name).sort(), ["bot_list", "bot_start", "bot_stop"]);
    assert.equal(bots.transports.find((transport) => transport.type === "socket")?.subscriptions, false);

    const owner = found.get("owner") as PackageDoc;
    assert.deepEqual(Object.keys(owner.events), ["pids_changed"]);
    assert.deepEqual(owner.operations.map((operation) => operation.name), ["owner_status"]);
    const ownerSocket = owner.transports.find((transport) => transport.type === "socket") as TransportDoc;
    assert.equal(ownerSocket.subscriptions, true);
    assert.equal(ownerSocket.endpoint, join(stateDir, "sockets", "owner.sock"));

    const api = found.get("api") as PackageDoc;
    assert.deepEqual(api.events, {});
    assert.deepEqual(api.operations.map((operation) => operation.name).sort(), ["docs_get", "docs_list"]);
    assert.equal(api.transports.find((transport) => transport.type === "socket")?.endpoint, join(stateDir, "sockets", "api.sock"));

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
