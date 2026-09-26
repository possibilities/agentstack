import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { fetchShareStates, normalizeServerUrl, postShare, isRetryable } from "../shared.js";

let server;
let config;
let answer;
let received;

before(async () => {
  server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received = { url: request.url, headers: request.headers, body: Buffer.concat(chunks).toString() };
    response.writeHead(answer.status, { "content-type": "application/json" });
    response.end(typeof answer.body === "string" ? answer.body : JSON.stringify(answer.body));
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  config = { serverUrl: `http://127.0.0.1:${server.address().port}`, token: "synthetic-test-token" };
});
after(() => new Promise((resolve) => server.close(resolve)));

test("share requests preserve the v1 payload and authorization", async () => {
  answer = { status: 200, body: { ok: true, data: { status: "queued", job_id: 7 } } };
  const result = await postShare(config, { url: "https://example.com/article", title: "An article" });
  assert.equal(result.ok, true);
  assert.equal(received.url, "/v1/share");
  assert.equal(received.headers.authorization, "Bearer synthetic-test-token");
  assert.deepEqual(JSON.parse(received.body), { version: 1, client: "chrome-extension", url: "https://example.com/article", title: "An article" });
});

test("duplicates and indexed documents are distinct successful receipts", async () => {
  for (const data of [{ status: "duplicate", job_id: 7 }, { status: "already_indexed", document_id: 9 }]) {
    answer = { status: 200, body: { ok: true, data } };
    assert.deepEqual((await postShare(config, { text: "A note" })).data, data);
  }
});

test("unconfirmed 2xx replies remain safely retryable", async () => {
  for (const body of ["not JSON", { ok: true }, { ok: true, data: { status: "queued", job_id: 0 } }, { ok: true, data: { status: "invented", job_id: 7 } }]) {
    answer = { status: 200, body };
    const result = await postShare(config, { text: "Keep this" });
    assert.equal(result.ok, false);
    assert.equal(result.code, "invalid_receipt");
    assert.equal(isRetryable(result), true);
  }
});

test("HTTP failures preserve retry policy and share-state reads preserve wire shape", async () => {
  for (const [status, retry] of [[400, false], [401, true], [408, true], [429, true], [500, true]]) {
    answer = { status, body: { ok: false, error: { code: "test_failure", message: "Synthetic failure" } } };
    assert.equal(isRetryable(await postShare(config, { text: "A note" })), retry);
  }
  const states = [{ job_id: 7, state: "completed", document_id: 9, failure_class: null }];
  answer = { status: 200, body: { ok: true, data: { shares: states } } };
  assert.deepEqual(await fetchShareStates(config, [7]), { ok: true, states });
  assert.equal(received.url, "/v1/shares?job_ids=7");
  answer = { status: 200, body: { ok: true, data: {} } };
  assert.deepEqual(await fetchShareStates(config, [7]), { ok: false, states: [] });
});

test("server URLs normalize harmless variation and reject hidden routing data", () => {
  assert.equal(normalizeServerUrl(" HTTP://LOCALHOST:8877/ "), "http://localhost:8877");
  for (const url of ["file:///etc/hosts", "https://user:secret@example.com", "https://example.com?token=secret", "https://example.com#fragment"]) {
    assert.throws(() => normalizeServerUrl(url));
  }
});
