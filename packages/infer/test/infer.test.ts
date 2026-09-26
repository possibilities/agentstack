import assert from "node:assert/strict";
import { chmodSync } from "node:fs";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { discoverModels } from "../src/catalog.js";
import { completeInput } from "../src/schema.js";
import { InferService, readCompletion, readCredentials } from "../src/service.js";

const accountId = "123e4567-e89b-42d3-a456-426614174000";
const auth = JSON.stringify({ auth_mode: "chatgpt", tokens: { account_id: "native_account", access_token: "test-secret" } });
const model = { id: "gpt-6-luna", defaultEffort: "low" as const, supportedEfforts: ["low" as const, "medium" as const] };
const input = () => completeInput.parse({ accountId, model: model.id, effort: "low", instructions: "Classify", input: "example" });
const event = (value: object) => `data: ${JSON.stringify(value)}\n\n`;
const completion = (body: string) => new Response(body, { headers: { "content-type": "text/event-stream" } });

test("selects an enabled Bot account without exposing credentials or falling back to another account", async () => {
  const dir = await mkdtemp(join(tmpdir(), "infer-auth-"));
  try {
    const config = join(dir, "configuration.sqlite"), secrets = join(dir, "secrets.sqlite");
    const db = new DatabaseSync(config);
    db.exec("CREATE TABLE accounts (name TEXT PRIMARY KEY, enabled INTEGER, removing INTEGER)");
    db.prepare("INSERT INTO accounts VALUES (?, 1, 0)").run(accountId);
    db.close();
    const secretDb = new DatabaseSync(secrets);
    secretDb.exec("CREATE TABLE credentials (name TEXT PRIMARY KEY, auth_json TEXT)");
    secretDb.prepare("INSERT INTO credentials VALUES (?, ?)").run(accountId, auth);
    secretDb.close();
    chmodSync(config, 0o600); chmodSync(secrets, 0o600);
    assert.deepEqual(await readCredentials(dir, accountId), { access: "test-secret", nativeId: "native_account", auth });
    const locked = new DatabaseSync(config);
    locked.prepare("UPDATE accounts SET enabled = 0 WHERE name = ?").run(accountId);
    locked.close();
    await assert.rejects(readCredentials(dir, accountId), /account_unavailable/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("one-shot inference checks a fresh model/effort and returns only completed text and usage", async () => {
  let discoveries = 0, requests = 0;
  const service = new InferService("unused", async () => { discoveries++; return [model]; },
    (async (_url, init) => {
      requests++;
      const headers = init?.headers as Record<string, string>;
      assert.equal(headers.Authorization, "Bearer test-secret");
      const body = JSON.parse(String(init?.body));
      assert.equal(body.max_output_tokens, 256);
      assert.equal(body.store, false);
      assert.equal(body.stream, true);
      assert.equal(body.tools, undefined);
      return completion(event({ type: "response.output_text.delta", delta: "OK" }) +
        event({ type: "response.completed", response: { status: "completed", usage: {
          input_tokens: 23, output_tokens: 5, total_tokens: 28, output_tokens_details: { reasoning_tokens: 0 },
        } } }));
    }) as typeof fetch, async () => ({ access: "test-secret", nativeId: "native_account", auth }));
  assert.deepEqual((await service.models(accountId)).models, [model]);
  const result = await service.complete(input());
  assert.equal(result.text, "OK");
  assert.equal(result.model, model.id);
  assert.deepEqual(result.usage, { inputTokens: 23, outputTokens: 5, totalTokens: 28, reasoningTokens: 0 });
  assert.equal(discoveries, 2);
  assert.equal(requests, 1);
  await assert.rejects(service.complete({ ...input(), effort: "high" }), /model_unavailable/);
  assert.equal(requests, 1);
});

test("partial SSE and an ambiguous network result never count as success or retry", async () => {
  await assert.rejects(readCompletion(completion(event({ type: "response.output_text.delta", delta: "partial" })), accountId, model.id),
    new RegExp(`infer_outcome_unknown:${accountId}`));
  await assert.rejects(readCompletion(completion(event({ type: "response.failed" })), accountId, model.id), /infer_outcome_unknown/);
  let attempts = 0;
  const service = new InferService("unused", async () => [model],
    (async () => { attempts++; throw new Error("secret upstream detail"); }) as typeof fetch,
    async () => ({ access: "test-secret", nativeId: "native_account", auth }));
  await assert.rejects(service.complete(input()), (error: Error) => error.message.startsWith("infer_outcome_unknown:") && !error.message.includes("secret"));
  assert.equal(attempts, 1);
});

test("bounds input and refuses a catalog failure before sending", async () => {
  assert.equal(completeInput.safeParse({ ...input(), input: "x".repeat(16_001) }).success, false);
  const service = new InferService("unused", async () => { throw new Error("secret detail"); },
    (async () => { throw new Error("should not send"); }) as typeof fetch,
    async () => ({ access: "test-secret", nativeId: "native_account", auth }));
  await assert.rejects(service.complete(input()), /^Error: catalog_unavailable$/);
});

test("one active request per account refuses concurrent allowance spend", async () => {
  let release: (() => void) | undefined, calls = 0;
  const service = new InferService("unused", async () => [model],
    (async () => { calls++; await new Promise<void>((resolve) => { release = resolve; });
      return completion(event({ type: "response.completed", response: { status: "completed" } })); }) as typeof fetch,
    async () => ({ access: "test-secret", nativeId: "native_account", auth }));
  const first = service.complete(input());
  await assert.rejects(service.complete(input()), /infer_busy/);
  for (let i = 0; i < 20 && !release; i++) await new Promise((resolve) => setTimeout(resolve, 1));
  assert.ok(release);
  assert.equal(calls, 1);
  release();
  await first;
});

test("isolated app-server discovery handshakes, paginates and leaves no credential copy", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "infer-catalog-test-"));
  try {
    const bin = join(stateDir, "fake-codex");
    await writeFile(bin, `#!${process.execPath}\n` + `
const fs = require("node:fs");
const readline = require("node:readline");
const at = process.argv.indexOf("--identity");
if (!process.argv.includes("--stdio") || at < 0 || !fs.readFileSync(process.argv[at+1] + "/auth.json", "utf8").includes("test-secret")) process.exit(1);
let initialized = false;
readline.createInterface({input: process.stdin}).on("line", line => {
  const req = JSON.parse(line);
  if (req.method === "initialize") console.log(JSON.stringify({id:req.id,result:{userAgent:"test"}}));
  else if (req.method === "initialized") initialized = true;
  else if (req.method === "model/list" && initialized && req.params.includeHidden === false) {
    const second = req.params.cursor === "next";
    console.log(JSON.stringify({id:req.id,result:{data:[{
      id:second?"gpt-6-sol":"gpt-6-luna",defaultReasoningEffort:"low",
      supportedReasoningEfforts:[{reasoningEffort:"low"}]
    }],nextCursor:second?null:"next"}}));
  }
});
`, { mode: 0o700 });
    const models = await discoverModels(stateDir, auth, bin);
    assert.deepEqual(models.map((row) => row.id), ["gpt-6-luna", "gpt-6-sol"]);
    assert.deepEqual(await readdir(stateDir), ["fake-codex"]);
  } finally { await rm(stateDir, { recursive: true, force: true }); }
});
