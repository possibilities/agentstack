import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startUiServer, uiListenPort, uiPageUrl } from "../src/ui.js";

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

test("the UI uses a developer port", () => {
  assert.equal(uiListenPort({}), 3000);
  assert.equal(uiListenPort({ PORT: "" }), 3000);
  assert.equal(uiListenPort({ PORT: "4321" }), 4321);
  assert.equal(uiPageUrl(3000, "owner"), "http://127.0.0.1:3000/_ui/owner");
  assert.throws(() => uiListenPort({ PORT: "nope" }), /invalid PORT: nope/);
});
