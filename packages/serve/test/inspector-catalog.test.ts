import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { serveInspectorCatalog } from "../src/inspector-catalog.js";
import { withLocalAuth, operatorHeaders } from "@stack/api";

test("Inspector's read-only server file follows Package API configuration", { timeout: 15_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "stack-inspector-catalog-"));
  const alpha = join(root, "packages", "alpha");
  await mkdir(alpha, { recursive: true });
  await writeFile(join(alpha, "api.yaml"), "name: alpha\ndescription: Alpha.\nmcp:\n  description: Alpha HTTP.\n  operations: all\n  events: all\n");
  const catalog = await serveInspectorCatalog({ root, env: { STACK_STATE_DIR: join(root, "state") }, mcpPort: 7823 });
  const names = async () => Object.keys((JSON.parse(await readFile(catalog.path, "utf8")) as { mcpServers: Record<string, unknown> }).mcpServers);
  try {
    const bridges = ["computer-use", "chrome", "messages", "computer-history", "openai-developer-docs"];
    assert.deepEqual(await names(), ["alpha", ...bridges]);
    const beta = join(root, "packages", "beta");
    await mkdir(beta);
    await writeFile(join(beta, "api.yaml"), "name: beta\ndescription: Beta.\nmcp:\n  description: Beta HTTP.\n  operations: all\n  events: all\n");
    await waitFor(async () => (await names()).join() === ["alpha", "beta", ...bridges].join());
    const config = JSON.parse(await readFile(catalog.path, "utf8")) as { mcpServers: Record<string, { url: string; suppressNotificationStream: boolean; headers: Record<string, string> }> };
    assert.equal(config.mcpServers.beta?.url, "http://127.0.0.1:7823/mcp/beta");
    assert.equal(config.mcpServers.beta?.suppressNotificationStream, true);
    const env = { STACK_STATE_DIR: join(root, "state") };
    assert.deepEqual(config.mcpServers.beta?.headers, operatorHeaders(env));
    withLocalAuth(env, auth => auth.rotate());
    await waitFor(async () => JSON.parse(await readFile(catalog.path, "utf8")).mcpServers.beta.headers.authorization === operatorHeaders(env).authorization);
    await writeFile(join(alpha, "api.yaml"), "name: alpha\ndescription: Alpha.\nsocket:\n  description: Alpha socket.\n");
    await waitFor(async () => (await names()).join() === ["beta", ...bridges].join());
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
