import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { serveInspectorCatalog } from "../src/inspector-catalog.js";

test("Inspector's read-only server file follows Package API configuration", { timeout: 15_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "agentstack-inspector-catalog-"));
  const alpha = join(root, "packages", "alpha");
  await mkdir(alpha, { recursive: true });
  await writeFile(join(alpha, "api.yaml"), "name: alpha\ndescription: Alpha.\nmcp:\n  description: Alpha HTTP.\n");
  const catalog = await serveInspectorCatalog({ root, env: { AGENTSTACK_STATE_DIR: join(root, "state") }, mcpPort: 7823 });
  const names = async () => Object.keys((JSON.parse(await readFile(catalog.path, "utf8")) as { mcpServers: Record<string, unknown> }).mcpServers);
  try {
    assert.deepEqual(await names(), ["alpha"]);
    const beta = join(root, "packages", "beta");
    await mkdir(beta);
    await writeFile(join(beta, "api.yaml"), "name: beta\ndescription: Beta.\nmcp:\n  description: Beta HTTP.\n");
    await waitFor(async () => (await names()).join() === "alpha,beta");
    const config = JSON.parse(await readFile(catalog.path, "utf8")) as { mcpServers: Record<string, { url: string; suppressNotificationStream: boolean }> };
    assert.equal(config.mcpServers.beta?.url, "http://127.0.0.1:7823/mcp/beta");
    assert.equal(config.mcpServers.beta?.suppressNotificationStream, true);
    await writeFile(join(alpha, "api.yaml"), "name: alpha\ndescription: Alpha.\nsocket:\n  description: Alpha socket.\n");
    await waitFor(async () => (await names()).join() === "beta");
  } finally {
    await catalog.close();
    assert.equal(existsSync(catalog.path), false);
    await rm(root, { recursive: true, force: true });
  }
});

async function waitFor(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(await check(), true, "Inspector catalog did not refresh");
}
