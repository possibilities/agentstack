import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { portlessCommandEnv, uiOrigin } from "../src/portless.js";
import { startUiServer } from "../src/ui.js";

test("package UIs are mounted at /_ui/<package>", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentstack-ui-"));
  const ownerDir = join(root, "owner");
  const codexDir = join(root, "codex");
  await mkdir(ownerDir);
  await mkdir(codexDir);
  await writeFile(join(ownerDir, "index.html"), "owner-page");
  await writeFile(join(codexDir, "index.html"), "codex-page");
  const ui = await startUiServer([
    { name: "owner", dir: ownerDir, data: () => ({ children: [{ name: "codex", pid: 4 }] }) },
    { name: "codex", dir: codexDir, data: async () => ({ servers: [] }) },
  ]);
  try {
    const page = await fetch(`http://127.0.0.1:${ui.port}/_ui/owner/`);
    assert.equal(await page.text(), "owner-page");
    const redirect = await fetch(`http://127.0.0.1:${ui.port}/_ui/codex`, { redirect: "manual" });
    assert.equal(redirect.status, 302);
    assert.equal(redirect.headers.get("location"), "/_ui/codex/");
    const codex = await fetch(`http://127.0.0.1:${ui.port}/_ui/codex/`);
    assert.equal(await codex.text(), "codex-page");
    const data = await fetch(`http://127.0.0.1:${ui.port}/_ui/owner/data`);
    assert.deepEqual(await data.json(), { children: [{ name: "codex", pid: 4 }] });
    const missing = await fetch(`http://127.0.0.1:${ui.port}/_ui/other/`);
    assert.equal(missing.status, 404);
  } finally {
    await ui.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("the UI hostname is agentstack.localhost", () => {
  assert.equal(uiOrigin, "https://agentstack.localhost");
  const env = portlessCommandEnv({ PATH: "/bin" });
  assert.equal(env.PORTLESS_HTTPS, "1");
  assert.equal(env.PORTLESS_PORT, "443");
  assert.equal(env.PORTLESS_TLD, "localhost");
  assert.equal(env.PORTLESS_TAILSCALE, "0");
  assert.equal(env.PATH, "/bin");
});
