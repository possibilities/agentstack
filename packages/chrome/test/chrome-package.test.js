import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);

test("MV3 ships every required icon size and a named AgentStack action", async () => {
  const manifest = JSON.parse(await readFile(new URL("manifest.json", root), "utf8"));
  assert.equal(manifest.name, "AgentStack");
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.background.type, "module");
  assert.equal(manifest.action.default_popup, "popup.html");
  assert.ok(manifest.commands["agentstack.share-current-page"]);
  assert.equal(manifest.host_permissions, undefined);
  for (const size of [16, 32, 48, 128]) {
    const png = await readFile(new URL(manifest.icons[size], root));
    assert.equal(png.readUInt32BE(16), size);
    assert.equal(png.readUInt32BE(20), size);
  }
});
