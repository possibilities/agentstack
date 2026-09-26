import { afterEach, test } from "node:test";
import { expect } from "expect";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ingestSource } from "../src/ingest.js";
import { ResearchStore } from "../src/store.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

test("directory traversal streams, skips sensitive components, and reports hard truncation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agentstack-brain-directory-"));
  dirs.push(dir);
  const root = join(dir, "root");
  mkdirSync(root);
  for (const name of ["one.md", "two.md", "three.md"]) {
    writeFileSync(join(root, name), `content ${name}`);
  }
  for (const sensitive of [".ssh", ".aws", ".gnupg", "credentials"]) {
    const path = join(root, sensitive);
    mkdirSync(path);
    writeFileSync(join(path, "hidden.md"), "must never ingest");
  }

  const store = new ResearchStore(join(dir, "research.db"));
  const result = await ingestSource(store, {
    source: root,
    sourceType: "directory",
    maxFiles: 20,
    directoryCandidateLimit: 2,
    skipSecrets: true,
  });
  expect(result).toMatchObject({
    status: "directory_ingested",
    ingested_count: 2,
    scanned_candidate_files: 2,
    discovered_candidate_files: 2,
    truncated: true,
  });
  if (!("truncation_reasons" in result))
    throw new Error("expected directory result");
  expect(result.truncation_reasons).toContain("candidate_limit");
  expect(
    store.db.query("SELECT content FROM documents ORDER BY id").all(),
  ).not.toEqual(expect.arrayContaining([{ content: "must never ingest" }]));
  store.close();
});

test("selected directory root rejects sensitive resolved path components", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agentstack-brain-directory-root-"));
  dirs.push(dir);
  const sensitiveParent = join(dir, ".ssh");
  const root = join(sensitiveParent, "research");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "notes.md"), "must not ingest");
  const store = new ResearchStore(join(dir, "research.db"));

  await expect(
    ingestSource(store, {
      source: root,
      sourceType: "directory",
      skipSecrets: true,
    }),
  ).rejects.toThrow("likely secret directory");
  expect(
    store.db.query("SELECT COUNT(*) AS count FROM documents").get(),
  ).toEqual({ count: 0 });
  store.close();
});

test("max-files reports truncation only when another candidate exists", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agentstack-brain-directory-max-"));
  dirs.push(dir);
  const root = join(dir, "root");
  mkdirSync(root);
  writeFileSync(join(root, "one.md"), "one");
  writeFileSync(join(root, "two.md"), "two");
  const store = new ResearchStore(join(dir, "research.db"));
  const result = await ingestSource(store, {
    source: root,
    sourceType: "directory",
    maxFiles: 1,
  });
  expect(result).toMatchObject({ ingested_count: 1, truncated: true });
  if (!("truncation_reasons" in result))
    throw new Error("expected directory result");
  expect(result.truncation_reasons).toContain("max_files");
  store.close();
});
