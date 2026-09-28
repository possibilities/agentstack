import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test("owned scrape-to-file queue processes direct Markdown only in disposable AgentStack state", () => {
  const state = mkdtempSync(join(tmpdir(), "agentstack-scrape-queue-"));
  try {
    const destination = join(state, "result.md");
    const apiPath = fileURLToPath(new URL("../api.js", import.meta.url));
    const script = `
      import { api } from ${JSON.stringify(apiPath)};
      import { createServer } from "node:http";
      const server = createServer((request, response) => {
        response.writeHead(200, { "content-type": "text/markdown" });
        response.end("# Queued result\\n\\nBounded body");
      });
      await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
      const ctx = await api.createContext();
      try {
        const url = "http://127.0.0.1:" + server.address().port + "/entry.md";
        const submit = api.operations.find(item => item.name === "scrape_queue_submit");
        const process = api.operations.find(item => item.name === "scrape_queue_process");
        const queued = await submit.call(ctx, { url, destination: ${JSON.stringify(destination)}, allowPrivateNetwork: true });
        const result = await process.call(ctx, {});
        console.log(JSON.stringify({ queued, result }));
      } finally {
        await api.prepareCloseContext(ctx);
        await api.closeContext(ctx);
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
      }
    `;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      env: { ...process.env, AGENTSTACK_STATE_DIR: state }, encoding: "utf8", timeout: 10_000,
    });
    assert.equal(child.status, 0, child.stderr);
    const result = JSON.parse(child.stdout) as { queued: { path: string }; result: { processed: number; failed: number } };
    assert.ok(result.queued.path.startsWith(join(state, "scrape", "queue")));
    assert.deepEqual({ processed: result.result.processed, failed: result.result.failed }, { processed: 1, failed: 0 });
    assert.equal(readFileSync(destination, "utf8"), "# Queued result\n\nBounded body");
  } finally { rmSync(state, { recursive: true, force: true }); }
});
