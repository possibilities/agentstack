import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { api, type ContentContext } from "../api.js";
import type { StatePlan } from "@stack/api";

const apply = (plan: StatePlan) => ({ planId: plan.id, expectedRevision: plan.revision, requestId: randomUUID() });
const call = async (ctx: ContentContext, name: string, input: object): Promise<any> => { const op = api.operations.find(row => row.name === name)!; return op.output.parse(await op.call(ctx, op.input.parse(input))); };

test("Vault history discloses every retained exact-slug path/commit/blob without writes, including unchanged and deleted paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "stack-vault-history-")), env = { ...process.env, STACK_STATE_DIR: root, STACK_CONTENT_PORT: "0", STACK_CONTENT_ARTIFACT_PORT: "0" }, ctx = await api.createContext!(env);
  const vault = ctx.command.vaultRoot;
  const git = (...args: string[]) => { const result = spawnSync("git", args, { cwd: vault, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" } }); assert.equal(result.status, 0, result.stderr); return result.stdout.trim(); };
  try {
    git("init"); writeFileSync(join(vault, "retained.md"), "# Retained\nprivate body v1"); git("add", "retained.md"); git("commit", "-m", "first"); const first = git("rev-parse", "HEAD"), blob1 = git("rev-parse", "HEAD:retained.md");
    writeFileSync(join(vault, "sibling.md"), "sibling private bytes"); git("add", "sibling.md"); git("commit", "-m", "sibling"); const second = git("rev-parse", "HEAD");
    writeFileSync(join(vault, "retained.md"), "# Retained\nprivate body v2"); git("add", "retained.md"); git("commit", "-m", "updated"); const third = git("rev-parse", "HEAD"), blob2 = git("rev-parse", "HEAD:retained.md");
    git("rm", "retained.md"); git("commit", "-m", "deleted"); git("remote", "add", "backup-origin", "https://user:secret@example.invalid/private?token=secret");
    writeFileSync(join(vault, "untracked.md"), "uncommitted private bytes");
    const before = git("status", "--porcelain=v1"), head = git("rev-parse", "HEAD"), indexBytes = readFileSync(join(vault, ".git", "index"));
    const page = await call(ctx, "content_vault_history_plan", { slugs: ["retained"], limit: 2 }); assert.equal(page.nextOffset, 2);
    const rest = await call(ctx, "content_vault_history_plan", { slugs: ["retained"], offset: 2, revision: page.revision });
    const entries = [...page.entries, ...rest.entries]; assert.equal(entries.length, 3);
    assert.deepEqual(new Set(entries.map(row => row.commit)), new Set([first, second, third])); assert.deepEqual(new Set(entries.map(row => row.blob)), new Set([blob1, blob2]));
    assert.deepEqual(page.paths, [{ slug: "retained", path: "retained.md", current: false }]); assert.deepEqual(page.remotes, [{ name: "backup-origin", fetch: true, push: true }]);
    assert.equal(JSON.stringify(page).includes("secret"), false); assert.equal(JSON.stringify(page).includes("private body"), false);
    assert.equal(git("status", "--porcelain=v1"), before); assert.equal(git("rev-parse", "HEAD"), head); assert.deepEqual(readFileSync(join(vault, ".git", "index")), indexBytes);
    const op = api.operations.find(row => row.name === "content_vault_history_plan")!;
    await assert.rejects(op.call(ctx, op.input.parse({ slugs: ["retained"] }), { transport: "mcp", botId: null, instance: null, threadId: null, sessionId: null }), /operator authority/);
    git("add", "untracked.md"); git("commit", "-m", "later");
    // A new commit that no longer contains the selected path doesn't alter its
    // retention rows, but the paging revision still binds the observed ref set.
    await assert.rejects(call(ctx, "content_vault_history_plan", { slugs: ["retained"], offset: 2, revision: page.revision }), /changed/);
  } finally { await api.closeContext!(ctx); await rm(root, { recursive: true, force: true }); }
});

test("publication cleanup is exact, dead-writer fenced, retry-safe and restart-unknown; published/source/sibling/legacy bytes remain", async () => {
  const root = await mkdtemp(join(tmpdir(), "stack-publication-state-")), env = { ...process.env, STACK_STATE_DIR: root, STACK_CONTENT_PORT: "0", STACK_CONTENT_ARTIFACT_PORT: "0" };
  let ctx = await api.createContext!(env);
  const abandoned = (scope: "bundle" | "artifact") => {
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import { ArtifactStore } from ${JSON.stringify(new URL("../src/artifacts.js", import.meta.url).href)};
      import { writeFileSync } from 'node:fs'; import { join } from 'node:path';
      const store = ArtifactStore.open(process.env, process.env.HOME);
      const claim = store.publications.begin(${JSON.stringify(scope)});
      writeFileSync(join(claim.directory, 'payload'), 'interrupted temporary bytes');
      console.log(JSON.stringify(claim)); store.close();
    `], { env, encoding: "utf8" }); assert.equal(child.status, 0, child.stderr); return JSON.parse(child.stdout) as { id: string; directory: string };
  };
  try {
    const live = ctx.store.publications!.begin("bundle"); writeFileSync(join(live.directory, "payload"), "live publication");
    const blocked = await call(ctx, "content_publication_plan", { ids: [live.id] }); assert.ok(blocked.blockedBy.some((text: string) => text.includes("alive"))); await assert.rejects(call(ctx, "content_publication_clear", apply(blocked)), /alive/);
    const one = abandoned("bundle"), two = abandoned("artifact"), sibling = abandoned("bundle"), interrupted = abandoned("artifact");
    const source = Buffer.from("permanent source"), digest = createHash("sha256").update(source).digest("hex");
    const stage = ctx.collections.startStage(source.length, digest, "retained-stage"); ctx.collections.appendStage(stage.id, 0, source); ctx.collections.finishStage(stage.id);
    const published = await call(ctx, "artifact_publish", { name: "retained-artifact", files: [{ name: "source.txt", blob: digest }] }); assert.equal(published.status, "created");
    const casBefore = ctx.store.versions("retained-artifact")[0]!;
    const legacy = join(ctx.collections.root, "publish", "legacy-no-claim"); mkdirSync(legacy); writeFileSync(join(legacy, "payload"), "unknown legacy");
    const stale = await call(ctx, "content_publication_plan", { ids: [one.id] }); writeFileSync(join(one.directory, "payload"), "changed after plan"); await assert.rejects(call(ctx, "content_publication_clear", apply(stale)), /changed/);
    let notices = 0; ctx.changed = () => { notices++; };
    const input = apply(await call(ctx, "content_publication_plan", { ids: [one.id, two.id] })), receipt = await call(ctx, "content_publication_clear", input); assert.equal(receipt.status, "completed"); assert.deepEqual(await call(ctx, "content_publication_clear", input), receipt); assert.ok(notices);
    assert.equal(readFileSync(join(sibling.directory, "payload"), "utf8"), "interrupted temporary bytes"); assert.equal(readFileSync(join(legacy, "payload"), "utf8"), "unknown legacy"); assert.equal(readFileSync(join(live.directory, "payload"), "utf8"), "live publication");
    assert.deepEqual(ctx.collections.blob(digest), source); assert.deepEqual(ctx.store.versions("retained-artifact")[0], casBefore);
    const listing = await call(ctx, "content_publication_list", {}); assert.equal(listing.entries.some((row: any) => [one.id, two.id].includes(row.id)), false); assert.ok(listing.retained.some((text: string) => text.includes("legacy-no-claim")));
    mkdirSync(one.directory); writeFileSync(join(one.directory, "payload"), "same-path foreign recreation");
    const recreated = await call(ctx, "content_publication_plan", { ids: [one.id] }); assert.ok(recreated.blockedBy.some((text: string) => text.includes("already collected")));
    await assert.rejects(call(ctx, "content_publication_clear", apply(recreated)), /already collected/);
    const pending = await call(ctx, "content_publication_plan", { ids: [interrupted.id] }), pendingInput = apply(pending); ctx.collections.maintenance.begin(pendingInput, pending);
    await api.closeContext!(ctx); ctx = await api.createContext!(env);
    const unknown = await call(ctx, "content_publication_clear", pendingInput); assert.equal(unknown.status, "unknown"); assert.deepEqual(await call(ctx, "content_publication_clear", pendingInput), unknown);
    assert.equal(readFileSync(join(interrupted.directory, "payload"), "utf8"), "interrupted temporary bytes");
    assert.equal((await call(ctx, "content_state_receipt_get", { requestId: input.requestId })).receipt.status, "completed");
  } finally { await api.closeContext!(ctx); await rm(root, { recursive: true, force: true }); }
});
