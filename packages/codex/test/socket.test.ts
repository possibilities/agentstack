import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { serveApi, socketCall } from "@agentstack/api";

const fakeBin = fileURLToPath(new URL("../../test/fixtures/fake-app-server.mjs", import.meta.url));

test("codex lifecycle is served on the namespaced unix socket", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "agentstack-codex-api-"));
  const cwd = await mkdtemp(join(tmpdir(), "agentstack-codex-cwd-"));
  const served = await serveApi({
    name: "codex",
    transport: "socket",
    env: { ...process.env, AGENTSTACK_STATE_DIR: stateDir },
  });
  try {
    assert.equal(served.socketPath, join(stateDir, "sockets", "codex.sock"));
    const listedTools = (await socketCall(served.socketPath, "tools/list")) as {
      server: { name: string; description: string };
      transport: { type: string; path: string };
      tools: Array<{ name: string; description: string }>;
    };
    assert.equal(listedTools.server.name, "codex");
    assert.match(listedTools.server.description, /Start, stop, and list/);
    assert.equal(listedTools.transport.type, "socket");
    assert.equal(listedTools.transport.path, served.socketPath);
    assert.deepEqual(
      listedTools.tools.map((tool) => tool.name),
      ["server_start", "server_stop", "server_list"],
    );
    assert.ok(listedTools.tools.every((tool) => tool.description.length > 0));

    const started = (await socketCall(served.socketPath, "tools/call", {
      name: "server_start",
      arguments: { cwd, id: "remote", codexBin: fakeBin },
    })) as { id: string; state: string; url: string };
    assert.equal(started.id, "remote");
    assert.equal(started.state, "running");
    assert.match(started.url, /^ws:\/\/127\.0\.0\.1:\d+$/);

    const listed = (await socketCall(served.socketPath, "tools/call", {
      name: "server_list",
      arguments: {},
    })) as { servers: Array<{ id: string }> };
    assert.equal(listed.servers.some((server) => server.id === "remote"), true);

    const stopped = (await socketCall(served.socketPath, "tools/call", {
      name: "server_stop",
      arguments: { id: "remote" },
    })) as { state: string };
    assert.equal(stopped.state, "stopped");

    await assert.rejects(
      socketCall(served.socketPath, "tools/call", { name: "server_start", arguments: {} }),
      /cwd/,
    );
  } finally {
    await served.close();
    await rm(stateDir, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});
