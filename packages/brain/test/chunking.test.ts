import { Database } from "../src/sqlite.js";
import { afterEach, test } from "node:test";
import { expect } from "expect";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ResearchStore } from "../src/store.js";
import {
  chunkMarkdown,
  codePointLength,
  MARKDOWN_CHUNKER_VERSION,
  sha256Text,
} from "../src/text.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Markdown chunks retain nested breadcrumbs and atomic structural blocks", () => {
  const markdown = `# Guide

Opening paragraph with Unicode 🧠.

## Recipes

- first item
  - nested item
- second item

\`\`\`ts
const answer = 42;
console.log(answer);
\`\`\`

| Name | Value |
| --- | ---: |
| alpha | 1 |
| beta | 2 |

> Quoted guidance
> continues here.`;
  const chunks = chunkMarkdown(markdown, 500);

  expect(chunks).toHaveLength(2);
  expect(chunks[1]?.content.startsWith("# Guide\n## Recipes\n\n")).toBe(true);
  expect(chunks[1]?.content).toContain(
    "```ts\nconst answer = 42;\nconsole.log(answer);\n```",
  );
  expect(chunks[1]?.content).toContain(
    "| Name | Value |\n| --- | ---: |\n| alpha | 1 |\n| beta | 2 |",
  );
  expect(chunks[1]?.content).toContain("> Quoted guidance\n> continues here");
  expect(chunks[1]?.headingPath).toEqual(["Guide", "Recipes"]);
  expect(chunks[1]?.blockTypes).toEqual([
    "heading",
    "list",
    "code",
    "table",
    "blockquote",
  ]);
  expect(chunks[1]?.structuralAnchor).toBe("#guide/recipes");
  expect(chunks[1]?.startLine).toBe(5);
  expect(chunks[1]?.endLine).toBe(22);
});

test("oversized code and tables split within bounds with repeated context", () => {
  const code = Array.from(
    { length: 20 },
    (_, index) => `const value${index} = "${"λ".repeat(20)}";`,
  ).join("\n");
  const rows = Array.from(
    { length: 18 },
    (_, index) => `| row ${index} | ${"資料".repeat(8)} |`,
  ).join("\n");
  const markdown = `# Manual

## Program

\`\`\`ts
${code}
\`\`\`

## Data

| Key | Value |
| --- | --- |
${rows}`;
  const chunks = chunkMarkdown(markdown, 180);
  const codeChunks = chunks.filter((chunk) =>
    chunk.blockTypes.includes("code"),
  );
  const tableChunks = chunks.filter((chunk) =>
    chunk.blockTypes.includes("table"),
  );

  expect(codeChunks.length).toBeGreaterThan(1);
  expect(tableChunks.length).toBeGreaterThan(1);
  for (const chunk of chunks) {
    expect(codePointLength(chunk.content)).toBeLessThanOrEqual(180);
  }
  for (const chunk of codeChunks) {
    expect(chunk.content.startsWith("# Manual\n## Program\n\n```ts\n")).toBe(true);
    expect(chunk.content.endsWith("\n```")).toBe(true);
  }
  for (const chunk of tableChunks) {
    expect(chunk.content.startsWith(
      "# Manual\n## Data\n\n| Key | Value |\n| --- | --- |\n",
    )).toBe(true);
  }
});

test("repeated sections have deterministic anchors, digests, and ordering", () => {
  const markdown = `# Notes

## Repeat

same paragraph

## Repeat

same paragraph`;
  const first = chunkMarkdown(markdown, 200);
  const second = chunkMarkdown(markdown, 200);

  expect(second).toEqual(first);
  expect(first.map((chunk) => chunk.structuralAnchor)).toEqual([
    "#notes",
    "#notes/repeat",
    "#notes/repeat~2",
  ]);
  expect(first[1]?.chunkDigest).toBe(first[2]?.chunkDigest);
  expect(first[1]?.duplicateOrdinal).toBe(0);
  expect(first[2]?.duplicateOrdinal).toBe(1);
  expect(first[1]?.chunkIdentity).not.toBe(first[2]?.chunkIdentity);
});

test("stored Markdown chunks retain stable provenance across explicit rebuilds", () => {
  const directory = mkdtempSync(join(tmpdir(), "agentstack-brain-chunking-"));
  directories.push(directory);
  const path = join(directory, "research.db");
  const revisionDigest = sha256Text("captured artifact bytes");
  const markdown = `# Root

## Details

A searchable paragraph.

- alpha
- beta`;
  const store = new ResearchStore(path);
  const created = store.upsertDocument({
    sourceType: "file",
    sourceUri: "/vault/stable.md",
    content: markdown,
    revisionDigest,
  });
  const select = () =>
    store.db
      .query(
        `SELECT chunk_index, structural_anchor, heading_path, start_line, end_line,
                block_types, revision_digest, chunker_version, chunk_digest,
                duplicate_ordinal, chunk_identity
         FROM chunks WHERE document_id=? ORDER BY chunk_index`,
      )
      .all(created.document_id);
  const first = select();

  const rebuilt = store.upsertDocument({
    sourceType: "file",
    sourceUri: "/vault/stable.md",
    content: markdown,
    revisionDigest,
    force: true,
  });
  const second = select();
  store.close();

  expect(rebuilt.status).toBe("updated");
  expect(second).toEqual(first);
  expect(
    second.every(
      (chunk) =>
        (chunk as { revision_digest: string }).revision_digest ===
          revisionDigest &&
        (chunk as { chunker_version: string }).chunker_version ===
          MARKDOWN_CHUNKER_VERSION,
    ),
  ).toBe(true);

  const db = new Database(path, { readonly: true });
  const document = db
    .query("SELECT revision_digest FROM documents WHERE id=?")
    .get(created.document_id);
  expect(document).toEqual({ revision_digest: revisionDigest });
  db.close();
});
