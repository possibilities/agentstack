import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { accessServerId, readServerId } from "../src/identity.js";
import { StatusSource } from "../src/status.js";

function root() {
  const directory = mkdtempSync(join(tmpdir(), "stack-identity-"));
  return { directory, env: { STACK_STATE_DIR: directory } as NodeJS.ProcessEnv, done: () => rmSync(directory, { recursive: true, force: true }) };
}
function accessStore(directory: string, value: string | null) {
  mkdirSync(join(directory, "access"), { recursive: true });
  const db = new DatabaseSync(join(directory, "access", "access.db"));
  db.exec("CREATE TABLE IF NOT EXISTS instance(id INTEGER PRIMARY KEY CHECK(id=1),uuid TEXT NOT NULL)");
  if (value !== null) db.prepare("INSERT INTO instance VALUES(1,?)").run(value);
  db.close();
}

test("the installation identity is the Access instance UUID, read without creating anything", () => {
  const fixture = root();
  try {
    assert.equal(readServerId(fixture.env), null, "no Access store yet");
    assert.deepEqual(readdirSync(fixture.directory), [], "reading never creates the store or its directory");
    const id = randomUUID();
    accessStore(fixture.directory, id);
    assert.equal(readServerId(fixture.env), id);
    assert.equal(accessServerId(fixture.directory), id);
  } finally { fixture.done(); }
});

test("an unreadable or malformed identity is null for status and an error where a value is required", () => {
  const fixture = root();
  try {
    accessStore(fixture.directory, null);
    assert.equal(readServerId(fixture.env), null, "a store with no instance row names nothing");
    assert.throws(() => accessServerId(fixture.directory), /identity is missing/);
    rmSync(join(fixture.directory, "access"), { recursive: true });
    accessStore(fixture.directory, "not-a-uuid");
    assert.equal(readServerId(fixture.env), null, "a value that is not a UUID is never reported");
    assert.throws(() => accessServerId(fixture.directory), /identity is missing/);
    assert.equal(existsSync(join(fixture.directory, "access", "access.db")), true);
  } finally { fixture.done(); }
});

test("serve status reports the identity its source reads, per snapshot, and null by default", () => {
  const source = new StatusSource();
  assert.equal(source.snapshot().serverId, null);
  const first = randomUUID(), second = randomUUID();
  let current: string | null = null;
  source.serverId = () => current;
  assert.equal(source.snapshot().serverId, null, "unknown until the owner has created it");
  current = first;
  assert.equal(source.snapshot().serverId, first);
  current = second;
  assert.equal(source.snapshot().serverId, second, "a replaced installation is reported, not remembered");
});
