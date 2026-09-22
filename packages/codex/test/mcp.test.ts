import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { startDaemon } from "../src/daemon.js";

const fakeBin = fileURLToPath(new URL("../../test/fixtures/fake-app-server.mjs", import.meta.url));

test("serve exposes MCP over loopback HTTP", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "agentstack-mcp-"));
  const cwd = await mkdtemp(join(tmpdir(), "agentstack-mcp-cwd-"));
  const daemon = await startDaemon(stateDir, { port: 0 });
  assert.match(daemon.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
  const client = new Client({ name: "agentstack-test", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(daemon.url));
  try {
    await client.connect(transport);
    const started = await client.callTool({
      name: "server_start",
      arguments: { cwd, id: "remote", codexBin: fakeBin },
    });
    assert.equal(started.isError, undefined, textOf(started));
    const body = JSON.parse(textOf(started)) as { url: string; state: string; id: string };
    assert.equal(body.id, "remote");
    assert.equal(body.state, "running");
    const listed = await client.callTool({ name: "server_list", arguments: {} });
    assert.match(textOf(listed), /"id":"remote"/);
    const stopped = await client.callTool({ name: "server_stop", arguments: { id: "remote" } });
    assert.match(textOf(stopped), /"state":"stopped"/);
  } finally {
    await client.close().catch(() => undefined);
    await daemon.close();
    await rm(stateDir, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});

function textOf(result: { content?: Array<{ type: string; text?: string }> }): string {
  const text = result.content?.find((item) => item.type === "text")?.text;
  assert.equal(typeof text, "string");
  return text ?? "";
}
