import assert from "node:assert/strict";
import { statSync } from "node:fs";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { api } from "../api.js";
import { discoverModels } from "../src/catalog.js";
import { startInput } from "../src/schema.js";
import { InferService } from "../src/service.js";
import { InferTraces } from "../src/traces.js";

const accountId = "123e4567-e89b-42d3-a456-426614174000";
const auth = JSON.stringify({ auth_mode: "chatgpt", tokens: { account_id: "native_account", access_token: "test-secret" } });
const credentials = async () => ({ access: "test-secret", nativeId: "native_account", auth });
const model = { id: "gpt-6-luna", defaultEffort: "low" as const, supportedEfforts: ["low" as const, "medium" as const] };
let ids = 0;
const nextId = () => `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`;
const input = (extra: object = {}) => startInput.parse({ requestId: nextId(), accountId, model: model.id, effort: "low", instructions: "Classify", input: "example", ...extra });
const event = (value: object) => `data: ${JSON.stringify(value)}\n\n`;
const completed = (text = "OK") => new Response(event({ type: "response.output_text.delta", delta: text }) +
  event({ type: "response.completed", response: { status: "completed", model: "reported-luna", usage: { input_tokens: 23, output_tokens: 5, total_tokens: 28, output_tokens_details: { reasoning_tokens: 0 } } } }));
const tick = () => new Promise((resolve) => setTimeout(resolve, 2));

type Discover = ConstructorParameters<typeof InferService>[1];
async function withService(options: { discover?: Discover; fetcher?: typeof fetch; credentials?: typeof credentials }, run: (service: InferService, dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "infer-ledger-"));
  const service = new InferService(dir, options.discover ?? (async () => [model]), options.fetcher ?? ((async () => completed()) as typeof fetch),
    options.credentials ?? credentials, new InferTraces(dir));
  try { await run(service, dir); } finally { await service.close().catch(() => {}); await rm(dir, { recursive: true, force: true }); }
}
async function settled(service: InferService, requestId: string) {
  for (let i = 0; i < 500; i++) {
    const record = service.get(requestId);
    if (record.state !== "running") return record;
    await tick();
  }
  throw new Error("request did not finish");
}
async function until(condition: () => boolean) {
  for (let i = 0; i < 500 && !condition(); i++) await tick();
  assert.ok(condition(), "condition not reached");
}
/** A fetch that waits for release() and honors abort, like the real request. */
function gatedFetch() {
  const gate = { calls: 0, release: (_response: Response) => {} };
  const fetcher = ((_url: string, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
    gate.calls++;
    gate.release = resolve;
    init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  })) as typeof fetch;
  return { gate, fetcher };
}
const outcome = ({ state, error }: { state: string; error: string | null }) => ({ state, error });

test("the Package API loads with its operations and change event", () => {
  assert.deepEqual(api.operations.map((operation) => operation.name),
    ["infer_models", "infer_model_list", "infer_discover", "infer_complete", "infer_start", "infer_request_list", "infer_request_get", "infer_trace_read"]);
  assert.deepEqual(Object.keys(api.events!.topics), ["infer_changed"]);
});

test("start admits a running ledger record at once, then one checked request completes in the background", async () => {
  let requests = 0, changes = 0;
  await withService({ fetcher: (async () => { requests++; return completed(); }) as typeof fetch }, async (service, dir) => {
    service.onChange = () => changes++;
    const request = input();
    const admitted = await service.start(request);
    assert.deepEqual({ state: admitted.state, text: admitted.text, finishedAt: admitted.finishedAt }, { state: "running", text: null, finishedAt: null });
    const record = await settled(service, request.requestId);
    assert.deepEqual({ state: record.state, text: record.text, reportedModel: record.reportedModel }, { state: "completed", text: "OK", reportedModel: "reported-luna" });
    assert.deepEqual(record.usage, { inputTokens: 23, outputTokens: 5, totalTokens: 28, reasoningTokens: 0 });
    assert.ok(record.finishedAt);
    assert.equal(requests, 1);
    assert.ok(changes >= 2);
    // The request's own fresh discovery refreshes the cached observation.
    assert.deepEqual(service.modelList(accountId).map((row) => row.models), [[model]]);
    const [summary] = service.list(20).requests;
    assert.deepEqual({ textPreview: summary?.textPreview, inputPreview: summary?.inputPreview, textChars: summary?.textChars }, { textPreview: "OK", inputPreview: "example", textChars: 2 });
    assert.equal("input" in summary!, false);
    assert.equal(statSync(join(dir, "infer", "traces.sqlite")).mode & 0o777, 0o600);
  });
});

test("start and complete share one ledger and one request ID never dispatches twice", async () => {
  let requests = 0;
  await withService({ fetcher: (async () => { requests++; return completed(); }) as typeof fetch }, async (service) => {
    const started = input();
    await service.start(started);
    await settled(service, started.requestId);
    assert.equal((await service.start(started)).state, "completed");
    assert.equal((await service.complete(started)).text, "OK", "complete replays a started request's recorded result");
    await assert.rejects(service.start({ ...started, input: "other" }), /infer_request_conflict/);
    const direct = input();
    await service.complete(direct);
    assert.equal((await service.start(direct)).state, "completed", "start returns a completed request's record");
    assert.equal(requests, 2);
    assert.deepEqual(service.list(20).requests.map((row) => row.requestId), [direct.requestId, started.requestId]);
  });
});

test("definite failures are recorded as failed, and nothing is sent before a checked model", async () => {
  let discover: Discover = async () => [model], status = 200, requests = 0;
  await withService({ discover: (...args) => discover!(...args), fetcher: (async () => { requests++; return status === 200 ? completed() : new Response("", { status }); }) as typeof fetch }, async (service) => {
    const run = async (request = input()) => { await service.start(request); return outcome(await settled(service, request.requestId)); };
    assert.deepEqual(await run(input({ model: "gpt-6-other" })), { state: "failed", error: "model_unavailable" });
    discover = async () => { throw new Error("secret detail"); };
    assert.deepEqual(await run(), { state: "failed", error: "catalog_unavailable" });
    assert.equal(requests, 0);
    discover = async () => [model];
    status = 429;
    assert.deepEqual(await run(), { state: "failed", error: "codex_rate_limited" });
    status = 502;
    assert.deepEqual(await run(), { state: "failed", error: "infer_http_error:502" });
    assert.equal(requests, 2);
  });
});

test("an ambiguous network result is unknown and never retried", async () => {
  let attempts = 0;
  await withService({ fetcher: (async () => { attempts++; throw new Error("secret upstream detail"); }) as typeof fetch }, async (service) => {
    const request = input();
    await service.start(request);
    assert.deepEqual(outcome(await settled(service, request.requestId)), { state: "unknown", error: `infer_outcome_unknown:${request.requestId}` });
    assert.equal(attempts, 1);
    assert.ok(!JSON.stringify(service.list(20)).includes("secret"));
  });
});

test("one running request per account refuses concurrent spend without recording it", async () => {
  const { gate, fetcher } = gatedFetch();
  await withService({ fetcher }, async (service) => {
    const first = input();
    await service.start(first);
    await assert.rejects(service.start(input()), /infer_busy/);
    await assert.rejects(service.complete(input()), /infer_busy/);
    assert.equal(service.list(20).requests.length, 1);
    await until(() => gate.calls === 1);
    gate.release(completed());
    assert.equal((await settled(service, first.requestId)).state, "completed");
    const second = input();
    for (let i = 0; ; i++) {
      try { await service.start(second); break; }
      catch (error) { if (i > 100 || !/infer_busy/.test((error as Error).message)) throw error; await tick(); }
    }
    await until(() => gate.calls === 2);
    gate.release(completed());
    assert.equal((await settled(service, second.requestId)).state, "completed");
  });
});

test("a restart marks running requests unknown, and a late outcome never overwrites it", async () => {
  const { gate, fetcher } = gatedFetch();
  const dir = await mkdtemp(join(tmpdir(), "infer-restart-"));
  const before = new InferService(dir, async () => [model], fetcher, credentials, new InferTraces(dir));
  try {
    const request = input();
    await before.start(request);
    await until(() => gate.calls === 1);
    const after = new InferService(dir, async () => [model], fetcher, credentials, new InferTraces(dir));
    assert.deepEqual(outcome(after.get(request.requestId)), { state: "unknown", error: "infer_interrupted" });
    await before.close();
    assert.deepEqual(outcome(after.get(request.requestId)), { state: "unknown", error: "infer_interrupted" });
    await after.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("shutdown refuses admission and marks a possibly sent request unknown", async () => {
  const { gate, fetcher } = gatedFetch();
  const dir = await mkdtemp(join(tmpdir(), "infer-shutdown-"));
  try {
    const service = new InferService(dir, async () => [model], fetcher, credentials, new InferTraces(dir));
    const request = input();
    await service.start(request);
    await until(() => gate.calls === 1);
    service.prepareClose();
    await assert.rejects(service.start(input()), /infer_closing/);
    await assert.rejects(service.complete(input()), /infer_closing/);
    await assert.rejects(service.refreshModels(accountId), /infer_closing/);
    await service.close();
    const reopened = new InferService(dir, async () => [model], fetcher, credentials, new InferTraces(dir));
    assert.deepEqual(outcome(reopened.get(request.requestId)), { state: "unknown", error: `infer_outcome_unknown:${request.requestId}` });
    await reopened.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("the ledger pages newest first", async () => {
  await withService({}, async (service) => {
    const requests = [input(), input(), input()];
    for (const request of requests) { await service.start(request); await settled(service, request.requestId); }
    const first = service.list(2);
    assert.deepEqual(first.requests.map((row) => row.requestId), [requests[2]!.requestId, requests[1]!.requestId]);
    assert.ok(first.nextBefore);
    const second = service.list(2, first.nextBefore!);
    assert.deepEqual(second.requests.map((row) => row.requestId), [requests[0]!.requestId]);
    assert.equal(second.nextBefore, null);
    assert.throws(() => service.get(nextId()), /unknown_request/);
  });
});

test("model discovery is cached, coalesced, and forgets an unusable account", async () => {
  let calls = 0, release = () => {}, fail = false, usable = true;
  const discover: Discover = () => new Promise((resolve, reject) => { calls++; release = () => fail ? reject(new Error("secret")) : resolve([model]); });
  await withService({ discover, credentials: async () => { if (!usable) throw new Error("account_unavailable"); return credentials(); } }, async (service) => {
    assert.deepEqual(service.modelList(), []);
    const first = await service.refreshModels(accountId);
    await service.refreshModels(accountId);
    assert.equal(calls, 1);
    assert.deepEqual(first, { accountId, models: null, observedAt: null, discovering: true, error: null });
    release();
    await until(() => !service.modelList(accountId)[0]?.discovering);
    assert.deepEqual(service.modelList(accountId)[0]?.models, [model]);
    fail = true;
    await service.refreshModels(accountId);
    release();
    await until(() => !service.modelList(accountId)[0]?.discovering);
    assert.deepEqual((({ models, error }) => ({ models, error }))(service.modelList(accountId)[0]!), { models: [model], error: "catalog_unavailable" });
    // A waiting infer_models discovery refreshes the same cache.
    fail = false;
    const waited = service.models(accountId);
    await until(() => calls === 3);
    release();
    assert.deepEqual((await waited).models, [model]);
    assert.equal(service.modelList(accountId)[0]?.error, null);
    usable = false;
    await assert.rejects(service.refreshModels(accountId), /account_unavailable/);
    assert.deepEqual(service.modelList(), []);
  });
});

test("an aborted app-server discovery stops before its own timeout and leaves nothing behind", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "infer-abort-"));
  try {
    const hang = join(stateDir, "hanging-codex");
    await writeFile(hang, `#!${process.execPath}\nsetInterval(() => {}, 1000);\n`, { mode: 0o700 });
    const controller = new AbortController();
    const started = Date.now();
    const aborted = discoverModels(stateDir, auth, hang, controller.signal);
    setTimeout(() => controller.abort(), 200);
    await assert.rejects(aborted, /catalog_unavailable/);
    assert.ok(Date.now() - started < 5_000);
    assert.deepEqual(await readdir(stateDir), ["hanging-codex"]);
  } finally { await rm(stateDir, { recursive: true, force: true }); }
});
