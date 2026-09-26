import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { serveMcp, serveSocket, socketPath } from "@agentstack/api";
import { api, createBrainContext, closeBrainContext } from "../api.js";

test("real MCP handshake, discovery and calls preserve Brain object outputs over its socket", { timeout: 15_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "brain-mcp-"));
  const env = { HOME: root, AGENTSTACK_STATE_DIR: root, AGENTSTACK_BRAIN_SHARE_PORT: "0", AGENTSTACK_MCP_PORT: "0" };
  const ctx = await createBrainContext(env, { pollMs: 60_000, extract: async () => { throw new Error("unexpected network extraction"); } });
  let socket: Awaited<ReturnType<typeof serveSocket>> | undefined;
  let mcp: Awaited<ReturnType<typeof serveMcp>> | undefined;
  try {
    socket = await serveSocket({ info: { name: "brain", description: "Brain", transportDescription: "Socket", path: socketPath("brain", env) }, context: ctx, operations: api.operations });
    mcp = await serveMcp({ env });
    let id = 0;
    let version: string | undefined;
    // Speak the actual Streamable HTTP wire format to the shared MCP server;
    // it forwards every operation through the live Brain Unix socket.
    const request = async (method: string, params: object = {}, notification = false): Promise<any> => {
      const requestId = notification ? undefined : ++id;
      const response = await fetch(mcp!.urls.brain, {
        method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(version ? { "mcp-protocol-version": version } : {}) },
        body: JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }),
      });
      if (notification) { assert.equal(response.status, 202); await response.text(); return; }
      assert.equal(response.status, 200);
      const message = await response.json() as any;
      assert.equal(message.jsonrpc, "2.0");
      assert.equal(message.id, requestId);
      assert.equal(message.error, undefined, JSON.stringify(message.error));
      return message.result;
    };
    const initialized = await request("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "brain-integration", version: "1.0.0" } });
    version = initialized.protocolVersion;
    assert.equal(initialized.serverInfo.name, "brain");
    assert.ok(initialized.capabilities.tools);
    await request("notifications/initialized", {}, true);
    const listed = await request("tools/list");
    assert.equal(listed.tools.length, api.operations.length);
    for (const tool of listed.tools) assert.equal(tool.outputSchema.type, "object", tool.name);
    const callTool = async (name: string, input: object = {}): Promise<any> => {
      const result = await request("tools/call", { name, arguments: input });
      assert.notEqual(result.isError, true, JSON.stringify(result.content));
      const data = result.structuredContent;
      assert.ok(data && typeof data === "object" && !Array.isArray(data), name);
      assert.deepEqual(JSON.parse(result.content[0].text), data);
      return data;
    };
    assert.deepEqual(await callTool("jobs_list"), { jobs: [] });
    assert.deepEqual(await callTool("sources_list"), { sources: [] });
    const source = "offline MCP admission fixture";
    const admitted = await callTool("submit", { source, kind: "text", "idempotency-key": "mcp-fixture" });
    assert.equal(admitted.status, "queued");
    const duplicate = await callTool("submit", { source, kind: "text", "idempotency-key": "mcp-fixture" });
    assert.equal(duplicate.status, "duplicate");
    assert.equal(duplicate.job_id, admitted.job_id);
    assert.equal((await callTool("jobs_list")).jobs[0].id, admitted.job_id);

    // Seed already-indexed evidence locally so both submit union alternatives
    // and both get alternatives are exercised without external extraction.
    const url = "https://example.test/already-indexed";
    const document = ctx.store.upsertDocument({ sourceType: "url", sourceUri: url, title: "MCP evidence", content: "Quasar evidence for both retrieval alternatives." });
    const timestamp = new Date().toISOString();
    ctx.store.db.query("INSERT INTO resources(key_type, key_value, kind, sensitivity, document_id, created_at, updated_at) VALUES ('url', ?, 'url', 'normal', ?, ?, ?)").run(url, document.document_id, timestamp, timestamp);
    const indexed = await callTool("submit", { source: url, kind: "url" });
    assert.equal(indexed.status, "already_indexed");
    assert.equal(indexed.document_id, document.document_id);
    const found = await callTool("search", { query: "Quasar" });
    const chunkId = found.results[0].chunk_id;
    assert.equal((await callTool("get", { "document-id": document.document_id })).document_id, document.document_id);
    assert.equal((await callTool("get", { "chunk-id": chunkId })).chunk_id, chunkId);

    const manifest = join(root, "sources.json");
    writeFileSync(manifest, JSON.stringify({ schema_version: 1, sources: [{ id: "mcp-source", version: 1, kind: "blog_feed", display_name: "MCP source", enabled: false, payload: { feed_url: "https://example.test/feed" }, schedule: { cadence_seconds: 3600 }, limits: { max_items_per_run: 10, max_pages_per_run: 1 }, collections: [], sensitivity: "public", credential_refs: [] }] }));
    assert.equal((await callTool("sources_apply", { manifest })).results[0].created, true);
    assert.equal((await callTool("sources_list")).sources[0].id, "mcp-source");
    assert.equal((await callTool("sources_status")).sources[0].enabled, false);
    assert.equal((await callTool("sources_sync", { "source-id": "mcp-source" })).results[0].status, "disabled");
  } finally {
    await mcp?.close();
    await socket?.close();
    await closeBrainContext(ctx);
    rmSync(root, { recursive: true, force: true });
  }
});
