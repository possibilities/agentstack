import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { z } from "zod";
import { operation } from "../src/operation.js";
import { serveSocket, socketCall } from "../src/socket.js";

test("socket advertises and calls a typed operation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentstack-socket-"));
  const path = join(dir, "demo.sock");
  const ping = operation({
    name: "ping",
    description: "Reply with the same name.",
    input: z.object({ name: z.string().describe("Name to echo.") }),
    output: z.object({ name: z.string() }),
    annotations: { title: "Ping", readOnlyHint: true },
    async call(_ctx: { seen: string[] }, input) {
      _ctx.seen.push(input.name);
      return { name: input.name };
    },
  });
  const served = await serveSocket({
    info: { name: "demo", description: "Demo operations.", transportDescription: "Demo socket.", path },
    context: { seen: [] as string[] },
    operations: [ping],
  });
  try {
    const listed = (await socketCall(path, "tools/list")) as {
      server: { name: string };
      tools: Array<{ name: string; inputSchema: { properties: { name: { description?: string } } } }>;
    };
    assert.equal(listed.server.name, "demo");
    assert.equal(listed.tools[0]?.name, "ping");
    assert.equal(listed.tools[0]?.inputSchema.properties.name.description, "Name to echo.");
    assert.deepEqual(await socketCall(path, "tools/call", { name: "ping", arguments: { name: "codex" } }), {
      name: "codex",
    });
    await assert.rejects(socketCall(path, "tools/call", { name: "missing", arguments: {} }), /unknown operation/);
    await assert.rejects(
      serveSocket({
        info: { name: "demo", description: "Demo operations.", transportDescription: "Demo socket.", path },
        context: { seen: [] },
        operations: [ping],
      }),
      /already listening/,
    );
  } finally {
    await served.close();
    await rm(dir, { recursive: true, force: true });
  }
});
