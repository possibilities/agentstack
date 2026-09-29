import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { SettingsStore } from "../src/store.js";
import { readFile } from "node:fs/promises";
import { botDefinitions, CODEX_REVISION } from "../src/catalog.js";
import source from "../src/codex-schema.json" with { type: "json" };

test("durable edits fence concurrent writers and retries, and preserve native null versus omission", async () => {
  const root = await mkdtemp(join(tmpdir(), "stack-settings-"));
  const path = join(root, "settings.db");
  const db = new DatabaseSync(path), otherDb = new DatabaseSync(path);
  try {
    const store = new SettingsStore(db), other = new SettingsStore(otherDb);
    store.seed("bot:one", { model: "original" }, "Copied defaults", 7);
    const edit = { expectedRevision: 0, requestId: randomUUID(), set: { "voice.includeStartupContext": false, "voice.prompt": "", "features.hooks": false } };
    const plan = store.preview("bot:one", "codex-app-server", edit);
    assert.equal(plan.changes.length, 3);
    assert.equal(other.get("bot:one")!.revision, 0, "preview does not write");
    const receipt = store.patch("bot:one", "codex-app-server", edit);
    assert.deepEqual(other.patch("bot:one", "codex-app-server", edit), { ...receipt, duplicate: true });
    assert.throws(() => other.patch("bot:one", "codex-app-server", { ...edit, requestId: randomUUID() }), /revision conflict/);
    assert.throws(() => other.patch("bot:one", "codex-app-server", { ...edit, set: { model: "other" } }), /requestId was reused/);
    assert.throws(() => store.patch("bot:one", "codex-app-server", { expectedRevision: 1, requestId: randomUUID(), set: { model: "new", "voice.clientManagedHandoffs": true } }), /Unsupported setting/);
    assert.equal(other.get("bot:one")!.values.model, "original", "invalid patches roll back as a unit");
    const reset = { expectedRevision: 1, requestId: randomUUID(), set: { "voice.prompt": null }, reset: ["model", "features.hooks"] };
    store.patch("bot:one", "codex-app-server", reset);
    assert.deepEqual(other.get("bot:one")!.values, { "voice.includeStartupContext": false, "voice.prompt": null });
    const omission = other.preview("bot:one", "codex-app-server", { expectedRevision: 2, requestId: randomUUID(), reset: ["voice.prompt"] });
    assert.deepEqual(omission.changes, [{ key: "voice.prompt", beforeSet: true, afterSet: false, before: null, after: null, apply: "voice-call" }]);
    const snapshot = other.get("bot:one")!;
    store.markLoaded("bot:one", "instance-1", snapshot);
    store.patch("bot:one", "codex-app-server", { expectedRevision: 2, requestId: randomUUID(), set: { model: "later" } });
    assert.deepEqual(other.loaded("bot:one", "instance-1")!.values, snapshot.values, "saved edits cannot rewrite loaded evidence");
    assert.equal(other.loaded("bot:one", "instance-2"), null);
    assert.equal(other.get("bot:one")!.sourceRevision, 7);
  } finally { db.close(); otherDb.close(); }
  const reopened = new DatabaseSync(path);
  try {
    const store = new SettingsStore(reopened);
    assert.equal(store.get("bot:one")!.revision, 3);
    assert.equal(store.loaded("bot:one", "instance-1")!.values.model, undefined);
  } finally { reopened.close(); await rm(root, { recursive: true, force: true }); }
});

test("managed configuration paths and published native schema stay on the consumer runtime pin", async () => {
  const installer = await readFile(new URL("../../../../scripts/install.sh", import.meta.url), "utf8");
  assert.equal(source.revision, installer.match(/^integration_sha=([a-f0-9]{40})$/m)?.[1]);
  assert.equal(CODEX_REVISION, source.revision);
  type Schema = boolean | { $ref?: string; properties?: Record<string, Schema>; anyOf?: Schema[]; allOf?: Schema[] };
  const definitions = source.schema.definitions as Record<string, Schema>;
  const property = (schema: Schema, name: string): Schema | undefined => typeof schema !== "object" ? undefined : schema.properties?.[name]
    ?? (schema.$ref ? property(definitions[schema.$ref.split("/").at(-1)!], name) : undefined)
    ?? [...schema.anyOf ?? [], ...schema.allOf ?? []].map((option) => property(option, name)).find(Boolean);
  for (const key of Object.keys(botDefinitions).filter((key) => !key.startsWith("voice."))) {
    let schema: Schema | undefined = source.schema as Schema;
    for (const part of key.split(".")) schema = schema && property(schema, part);
    assert.ok(schema, `${key} must exist in the pinned native schema`);
  }
});
