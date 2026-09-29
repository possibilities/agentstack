import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test("owned scrape-to-file queue processes direct Markdown only in disposable Stack state", () => {
  const state = mkdtempSync(join(tmpdir(), "stack-scrape-queue-"));
  try {
    const destination = join(state, "result.md");
    const apiPath = fileURLToPath(new URL("../api.js", import.meta.url));
    const script = `
      import { api } from ${JSON.stringify(apiPath)};
      import { createServer } from "node:http";
      const server = createServer((request, response) => {
        response.writeHead(200, { "content-type": "text/markdown" });
        response.end("# Queued result\\n\\nBounded body");
      });
      await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
      const ctx = await api.createContext();
      try {
        const url = "http://127.0.0.1:" + server.address().port + "/entry.md";
        const submit = api.operations.find(item => item.name === "scrape_queue_submit");
        const process = api.operations.find(item => item.name === "scrape_queue_process");
        const queued = await submit.call(ctx, { url, destination: ${JSON.stringify(destination)}, allowPrivateNetwork: true });
        const result = await process.call(ctx, {});
        console.log(JSON.stringify({ queued, result }));
      } finally {
        await api.prepareCloseContext(ctx);
        await api.closeContext(ctx);
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
      }
    `;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      env: { ...process.env, STACK_STATE_DIR: state }, encoding: "utf8", timeout: 10_000,
    });
    assert.equal(child.status, 0, child.stderr);
    const result = JSON.parse(child.stdout) as { queued: { path: string }; result: { processed: number; failed: number } };
    assert.ok(result.queued.path.startsWith(join(state, "scrape", "queue")));
    assert.deepEqual({ processed: result.result.processed, failed: result.result.failed }, { processed: 1, failed: 0 });
    assert.equal(readFileSync(destination, "utf8"), "# Queued result\n\nBounded body");
  } finally { rmSync(state, { recursive: true, force: true }); }
});

test("queue list reports pending, retrying and failed jobs read-only and omits frontmatter values", () => {
  const state = mkdtempSync(join(tmpdir(), "stack-scrape-list-"));
  try {
    const apiPath = fileURLToPath(new URL("../api.js", import.meta.url));
    const script = `
      import { api } from ${JSON.stringify(apiPath)};
      import { createHash } from "node:crypto";
      import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
      import { createServer } from "node:http";
      import { join } from "node:path";
      const server = createServer((request, response) => { response.writeHead(404); response.end("gone"); });
      await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
      const ctx = await api.createContext();
      const call = (name, args = {}) => api.operations.find(item => item.name === name).call(ctx, args);
      try {
        const empty = await call("scrape_queue_list", { limit: 200 });
        const base = "http://127.0.0.1:" + server.address().port;
        const scrapeRoot = join(${JSON.stringify(state)}, "scrape");
        // Missing state directories are reported empty, never created by a read.
        const created = readdirSync(${JSON.stringify(state)});
        await call("scrape_queue_submit", { url: base + "/gone", destination: join(scrapeRoot, "gone.md"), allowPrivateNetwork: true });
        // An unreadable job fails permanently; the 404 above schedules a retry.
        writeFileSync(join(scrapeRoot, "queue", "1767225500000-bad00000.yaml"), "url: not-a-url\\ndestination: /tmp/x.md\\n", { mode: 0o600 });
        await call("scrape_queue_process");
        await call("scrape_queue_submit", { url: base + "/later", destination: "~/later.md", summarize: true, frontmatter: { secret: "value" }, allowPrivateNetwork: true });
        // A retry envelope exactly as processing publishes one after an upstream outage.
        const name = "1767225600000-abcdef12.yaml";
        const raw = Buffer.from("url: https://example.com/retry\\ndestination: /tmp/retry.md\\n");
        const sha = value => createHash("sha256").update(value).digest("hex");
        const generationId = sha(Buffer.concat([Buffer.from("pending\\0" + name + "\\0"), raw]));
        const envelope = { version: 1, state: "retry", generationId, logicalArea: "pending", originalFilename: name, rawByteSize: raw.byteLength,
          rawSha256: sha(raw), rawBase64: raw.toString("base64"), completedFailures: 2, nextAttemptAtMs: 1767229200000,
          policy: { initialDelaySeconds: 1, maxDelaySeconds: 60, maxAttempts: 5 } };
        mkdirSync(join(scrapeRoot, "retry"), { recursive: true, mode: 0o700 });
        writeFileSync(join(scrapeRoot, "retry", generationId + "--attempt-2.json"), JSON.stringify(envelope) + "\\n", { mode: 0o600 });
        writeFileSync(join(scrapeRoot, "retry", "unexpected.json"), "{}\\n", { mode: 0o600 });
        const listed = await call("scrape_queue_list", { limit: 200 });
        const limited = await call("scrape_queue_list", { limit: 1 });
         console.log(JSON.stringify({ empty, created, listed, limited, generationId }));
      } finally {
        await api.prepareCloseContext(ctx);
        await api.closeContext(ctx);
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
      }
    `;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      env: { ...process.env, STACK_STATE_DIR: state }, encoding: "utf8", timeout: 10_000,
    });
    assert.equal(child.status, 0, child.stderr);
    const out = JSON.parse(child.stdout);
    assert.deepEqual(out.empty, { jobs: [], counts: { pending: 0, retrying: 0, failed: 0 }, truncated: false });
    assert.deepEqual(out.created, []);
    const jobs = out.listed.jobs as Array<Record<string, unknown>>;
    assert.deepEqual(out.listed.counts, { pending: 1, retrying: 3, failed: 1 });
    assert.deepEqual(jobs.map((job) => job.state), ["failed", "retrying", "retrying", "retrying", "pending"]);
    const failed = jobs[0]!;
    assert.deepEqual({ file: failed.file, url: failed.url, submitted: failed.submitted_at }, { file: "1767225500000-bad00000.yaml", url: null, submitted: "2025-12-31T23:58:20.000Z" });
    assert.match(String(failed.problem), /invalid standalone queue job/);
    assert.match(String(failed.id), /^[0-9a-f]{64}$/);
    const gone = jobs.find((job) => String(job.url).endsWith("/gone"))!;
    assert.deepEqual({ state: gone.state, completed: gone.completed_failures, problem: gone.problem }, { state: "retrying", completed: 1, problem: null });
    const retry = jobs.find((job) => job.id === out.generationId)!;
    assert.deepEqual({ url: retry.url, completed: retry.completed_failures, max: retry.max_attempts, next: retry.next_attempt_at, submitted: retry.submitted_at },
       { url: "https://example.com/retry", completed: 2, max: 5, next: "2026-01-01T01:00:00.000Z", submitted: "2026-01-01T00:00:00.000Z" });
    const broken = jobs.find((job) => job.file === "unexpected.json")!;
    assert.equal(broken.state, "retrying");
    assert.ok(broken.problem);
    const pending = jobs.at(-1)!;
    assert.deepEqual({ destination: pending.destination, summarize: pending.summarize, keys: pending.frontmatter_keys, allow: pending.allow_private_network },
      { destination: "~/later.md", summarize: true, keys: ["secret"], allow: true });
    assert.ok(!child.stdout.includes("\"value\""));
    assert.equal(out.limited.jobs.length, 1);
    assert.equal(out.limited.truncated, true);
    assert.deepEqual(out.limited.counts, out.listed.counts);
  } finally { rmSync(state, { recursive: true, force: true }); }
});
