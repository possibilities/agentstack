import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { registerHooks } from "node:module";
import { extname } from "node:path";
import test from "node:test";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.includes("/lib/stack/") && specifier.startsWith("./") && !extname(specifier)) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});

const content = await import("../lib/stack/content.ts");
const { stageBytes, StageStalled, stageKey } = await import("../lib/stack/content-upload.ts");

test("local files map to item kinds and media types the Content API accepts", () => {
  assert.deepEqual(content.itemKindFor("photo.png", "image/png"), { kind: "image", mediaType: "image/png" });
  assert.deepEqual(content.itemKindFor("vector.svg", "image/svg+xml"), { kind: "file", mediaType: "image/svg+xml" });
  assert.deepEqual(content.itemKindFor("notes.md", ""), { kind: "document", mediaType: "text/markdown" });
  assert.deepEqual(content.itemKindFor("notes.txt", "text/plain; charset=utf-8"), { kind: "document", mediaType: "text/plain" });
  assert.deepEqual(content.itemKindFor("data.bin", ""), { kind: "file", mediaType: "application/octet-stream" });
  assert.deepEqual(content.itemKindFor("report.pdf", "application/pdf"), { kind: "file", mediaType: "application/pdf" });
});

test("collection slugs follow the API's shape", () => {
  assert.equal(content.slugify("  Research Notes: 2026! "), "research-notes-2026");
  assert.equal(content.slugify("Café crème"), "cafe-creme");
  assert.equal(content.validSlug("research-notes"), true);
  assert.equal(content.validSlug("Research"), false);
  assert.equal(content.validSlug("a--b"), false);
  assert.equal(content.slugify("x".repeat(100)).length, 80);
});

test("wikilink completion finds the open reference and closes it", () => {
  assert.deepEqual(content.wikilinkQuery("See [[blue", 10), { start: 6, query: "blue" });
  assert.equal(content.wikilinkQuery("See [[done]] and", 16), null);
  assert.equal(content.wikilinkQuery("no link", 7), null);
  assert.deepEqual(content.completeWikilink("See [[blu", 9, "bluetooth-trap"), { text: "See [[bluetooth-trap]]", caret: 22 });
  assert.deepEqual(content.completeWikilink("See [[blu]] now", 9, "bluetooth-trap"), { text: "See [[bluetooth-trap]] now", caret: 22 });
});

test("wikilinks become in-page document links outside code fences", () => {
  const linked = content.linkWikilinks("A [[first-note]] and [[second|the second]].\n```\n[[kept]]\n```");
  assert.match(linked, /\[first-note\]\(#content-document:first-note\)/);
  assert.match(linked, /\[the second\]\(#content-document:second\)/);
  assert.match(linked, /\n\[\[kept\]\]\n/);
});

test("peeks show text when bytes are UTF-8 and hex otherwise", () => {
  assert.equal(content.asText(new TextEncoder().encode("hello\nworld")), "hello\nworld");
  assert.equal(content.asText(new Uint8Array([0, 1, 2, 3, 255])), null);
  // A multi-byte character cut by the peek is still text.
  assert.equal(content.asText(new TextEncoder().encode("naïve café").subarray(0, 11)), "naïve caf");
  assert.match(content.hexDump(new Uint8Array([0x41, 0x42, 0x00])), /^00000000  41 42 00 +AB\.$/);
});

test("Content origin links are offered only to loopback pages", () => {
  const origins = { document: "http://127.0.0.1:8777", artifact: "http://127.0.0.1:8778" };
  assert.equal(content.contentHref(origins, "artifact", "/c/abc", "127.0.0.1"), "http://127.0.0.1:8778/c/abc");
  assert.equal(content.contentHref(origins, "document", "/d/x", "localhost"), "http://127.0.0.1:8777/d/x");
  assert.equal(content.contentHref(origins, "artifact", "/c/abc", "host.tailnet.ts.net"), null);
  assert.equal(content.contentHref(null, "artifact", "/c/abc", "127.0.0.1"), null);
  assert.equal(content.fillRoute("/d/{slug}", { slug: "a b" }), "/d/a%20b");
});

/** A fake stage store that can drop chosen responses after applying them, like a lost acknowledgement. */
function fakeStages({ loseChunkAt = new Set(), refuseStatus = false } = {}) {
  const stages = new Map();
  const calls = [];
  const call = async (name, args) => {
    calls.push([name, args.offset ?? null]);
    if (name === "blob_stage_start") {
      const existing = [...stages.values()].find((stage) => stage.clientKey === args.clientKey);
      if (existing) return view(existing);
      const stage = { id: `s${stages.size + 1}`, clientKey: args.clientKey, bytes: args.bytes, digest: args.digest, data: [], blob: null };
      stages.set(stage.id, stage);
      return view(stage);
    }
    const stage = stages.get(args.id);
    if (name === "blob_stage_status") {
      if (refuseStatus) throw new Error("connection closed");
      return view(stage);
    }
    if (name === "blob_stage_chunk") {
      const received = stage.data.length;
      if (args.offset !== received) throw new Error(`expected chunk offset ${received}`);
      for (const byte of Buffer.from(args.base64, "base64")) stage.data.push(byte);
      if (loseChunkAt.delete(args.offset)) throw new Error("response lost");
      return view(stage);
    }
    if (name === "blob_stage_finish") {
      const digest = createHash("sha256").update(Buffer.from(stage.data)).digest("hex");
      if (digest !== stage.digest) throw new Error("staged content digest mismatch");
      stage.blob = digest;
      return view(stage);
    }
    throw new Error(`unexpected ${name}`);
  };
  const view = (stage) => ({ id: stage.id, bytes: stage.bytes, received: stage.data.length, digest: stage.digest, blob: stage.blob });
  return { call, calls, stages };
}

test("staged uploads recover lost chunk responses from blob_stage_status instead of guessing offsets", async () => {
  const bytes = new Uint8Array(600 * 1024).map((_, index) => index % 251);
  const digest = createHash("sha256").update(bytes).digest("hex");
  const fake = fakeStages({ loseChunkAt: new Set([262_144]) });
  const progress = [];
  const blob = await stageBytes(fake.call, bytes, digest, (received) => progress.push(received));
  assert.equal(blob, digest);
  const names = fake.calls.map(([name]) => name);
  assert.ok(names.includes("blob_stage_status"), "a lost response is resolved by reading status");
  // No chunk is ever sent at an offset the server had not acknowledged.
  assert.deepEqual(fake.calls.filter(([name]) => name === "blob_stage_chunk").map(([, offset]) => offset), [0, 262_144, 524_288]);
  assert.equal(progress.at(-1), bytes.length);
});

test("an unreachable status leaves a resumable stall, and resuming continues from the server's offset", async () => {
  const bytes = new Uint8Array(300 * 1024).fill(7);
  const digest = createHash("sha256").update(bytes).digest("hex");
  const fake = fakeStages({ loseChunkAt: new Set([0]), refuseStatus: true });
  await assert.rejects(stageBytes(fake.call, bytes, digest), (error) => error instanceof StageStalled && error.stageId === "s1");
  const resumed = fakeStages();
  resumed.stages.set("s1", { ...fake.stages.get("s1") });
  resumed.calls.length = 0;
  assert.equal(await stageBytes(resumed.call, bytes, digest), digest);
  assert.equal(stageKey(digest, bytes.length), `ui:${bytes.length}:${digest}`);
  // The same key reopened the existing stage and sent only the missing tail.
  assert.deepEqual(resumed.calls.filter(([name]) => name === "blob_stage_chunk").map(([, offset]) => offset), [262_144]);
});

test("empty files finish without chunks", async () => {
  const bytes = new Uint8Array(0);
  const digest = createHash("sha256").update(bytes).digest("hex");
  const fake = fakeStages();
  assert.equal(await stageBytes(fake.call, bytes, digest), digest);
  assert.deepEqual(fake.calls.map(([name]) => name), ["blob_stage_start", "blob_stage_finish"]);
});
