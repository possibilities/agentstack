import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { codexChild } from "../src/codex.js";
import { startOwner } from "../src/owner.js";

const childBin = fileURLToPath(new URL("../../test/fixtures/child.mjs", import.meta.url));

test("the owner stops a child it started", async () => {
  const owner = startOwner([{ name: "fixture", command: process.execPath, args: [childBin] }]);
  await owner.close();
});

test("the codex child serves the codex socket", () => {
  const child = codexChild();
  assert.equal(child.name, "codex");
  assert.equal(child.command, process.execPath);
  assert.deepEqual(child.args.slice(1), ["codex", "socket"]);
  assert.equal(existsSync(child.args[0] ?? ""), true);
});
