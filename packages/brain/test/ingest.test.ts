import { afterEach, test } from "node:test";
import { expect } from "expect";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import {
  decodeHtmlEntities,
  extractDocxBytes,
  extractEpubBytes,
  extractFile,
} from "../src/extract.js";
import { ingestSource } from "../src/ingest.js";
import { ResearchStore } from "../src/store.js";

const dirs: string[] = [];
const originalPath = process.env.PATH;
afterEach(() => {
  process.env.PATH = originalPath;
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "agentstack-brain-ingest-"));
  dirs.push(dir);
  return dir;
}

test("generic text, HTML file, and directory ingestion preserve statuses and secret skips", async () => {
  const dir = tempDir();
  const store = new ResearchStore(join(dir, "research.db"));
  const created = await ingestSource(store, {
    source: "A pasted 🧠 note",
    sourceType: "text",
    tags: "Notes, Brain",
  });
  expect(created).toMatchObject({ status: "created", source_type: "text" });
  const unchanged = await ingestSource(store, {
    source: "A pasted 🧠 note",
    sourceType: "text",
    tags: "Notes, Brain",
  });
  expect(unchanged).toMatchObject({ status: "unchanged" });

  const htmlPath = join(dir, "page.html");
  writeFileSync(
    htmlPath,
    "<html><title>Fixture &amp; Title</title><script>secret noise</script><body><h1>Hello</h1><p>Useful body</p></body></html>",
  );
  const html = await ingestSource(store, {
    source: htmlPath,
    sourceType: "file",
  });
  expect(html).toMatchObject({ title: "Fixture & Title", source_type: "file" });

  const root = join(dir, "files");
  mkdirSync(root);
  writeFileSync(join(root, "one.md"), "one document");
  writeFileSync(join(root, ".env"), "PASSWORD=nope");
  writeFileSync(join(root, "ignored.bin"), new Uint8Array([0, 1, 2]));
  const directory = await ingestSource(store, {
    source: root,
    sourceType: "directory",
    tags: ["collection"],
  });
  expect(directory).toMatchObject({
    status: "directory_ingested",
    scanned_candidate_files: 1,
    ingested_count: 1,
    errors_count: 0,
  });
  store.close();
});

test("DOCX and EPUB ZIP containers extract bounded text", () => {
  const docx = zipSync({
    "word/document.xml": strToU8(
      "<w:document><w:body><w:p><w:r><w:t>Hello 🧠</w:t></w:r></w:p><w:p><w:r><w:t>World</w:t></w:r></w:p></w:body></w:document>",
    ),
  });
  expect(extractDocxBytes(docx, 100_000)).toContain("Hello 🧠\nWorld");

  const epub = zipSync({
    "OEBPS/02.xhtml": strToU8(
      "<html><body><p>Second chapter</p></body></html>",
    ),
    "OEBPS/01.xhtml": strToU8("<html><body><p>First chapter</p></body></html>"),
  });
  expect(extractEpubBytes(epub, 100_000)).toBe(
    "First chapter\n\nSecond chapter",
  );
  expect(() => extractEpubBytes(epub, 5)).toThrow("larger than max_bytes");

  const underreportedAggregate = zipSync(
    {
      "OEBPS/a.xhtml": strToU8("aaaa"),
      "OEBPS/b.xhtml": strToU8("bbbb"),
    },
    { level: 0 },
  );
  const view = new DataView(
    underreportedAggregate.buffer,
    underreportedAggregate.byteOffset,
    underreportedAggregate.byteLength,
  );
  let centralEntries = 0;
  for (let index = 0; index < underreportedAggregate.length - 28; index += 1) {
    if (view.getUint32(index, true) !== 0x02014b50) continue;
    view.setUint32(index + 24, 1, true);
    centralEntries += 1;
  }
  expect(centralEntries).toBe(2);
  expect(() => extractEpubBytes(underreportedAggregate, 5)).toThrow(
    "larger than max_bytes",
  );
});

test("PDF uses a PATH-resolved pdftotext executable with explicit argv", () => {
  const dir = tempDir();
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const log = join(dir, "args.txt");
  const executable = join(bin, "pdftotext");
  writeFileSync(
    executable,
    `#!/bin/sh\nprintf '%s\\n' "$@" > "${log}"\nprintf 'Extracted PDF text\\n'\n`,
  );
  chmodSync(executable, 0o755);
  process.env.PATH = `${bin}:${originalPath}`;
  const pdf = join(dir, "paper.pdf");
  writeFileSync(pdf, "%PDF fixture");
  expect(extractFile(pdf).content).toBe("Extracted PDF text");
  expect(readFileSync(log, "utf8")).toBe(`-layout\n${realpathSync(pdf)}\n-\n`);
});

test("pdftotext failures redact secrets and collapse the resolved input path", () => {
  const dir = tempDir();
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const executable = join(bin, "pdftotext");
  writeFileSync(
    executable,
    "#!/bin/sh\nprintf 'failed reading %s token=pdf-secret' \"$2\" >&2\nexit 9\n",
  );
  chmodSync(executable, 0o755);
  process.env.PATH = `${bin}:${originalPath}`;
  const pdf = join(dir, "private-paper.pdf");
  writeFileSync(pdf, "%PDF fixture");
  const resolvedPdf = realpathSync(pdf);

  expect(() => extractFile(pdf)).toThrow("private-paper.pdf");
  try {
    extractFile(pdf);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    expect(message).not.toContain(resolvedPdf);
    expect(message).not.toContain("pdf-secret");
    expect(message).toContain("token=[REDACTED]");
  }
});

test("generic URL ingestion uses the Agentscrape scrape seam and preserves markdown caps", async () => {
  const dir = tempDir();
  const store = new ResearchStore(join(dir, "research.db"));
  const calls: Array<{ url: string; maxBytes?: number; maxPoints?: number }> =
    [];
  const result = await ingestSource(store, {
    source: "https://Example.com/report.pdf#fragment",
    sourceType: "url",
    title: "Override title",
    maxBytes: 64,
    tags: "web",
    notes: "provider-backed",
    scrape: async (url, options) => {
      calls.push({
        url,
        maxBytes: options?.maxMarkdownBytes,
        maxPoints: options?.maxMarkdownCodePoints,
      });
      return {
        success: true,
        url: "https://cdn.example/final.pdf",
        requested_url: url,
        markdown: "Extracted markdown from Agentscrape",
        content: "Extracted markdown from Agentscrape",
        size_chars: 33,
      };
    },
  });

  expect(calls).toEqual([
    { url: "https://example.com/report.pdf", maxBytes: 64, maxPoints: 64 },
  ]);
  expect(result).toMatchObject({
    source_type: "url_pdf",
    source_uri: "https://example.com/report.pdf",
    title: "Override title",
  });
  expect(
    store.db.query("SELECT content, tags, notes FROM documents").get(),
  ).toEqual({
    content: "Extracted markdown from Agentscrape",
    tags: JSON.stringify(["web"]),
    notes: "provider-backed",
  });
  store.close();
});

test("URL ingestion keeps requested identity and infers title from final Markdown", async () => {
  const dir = tempDir();
  const store = new ResearchStore(join(dir, "research.db"));
  const result = await ingestSource(store, {
    source: "https://Example.com/original#fragment",
    sourceType: "url",
    scrape: async (url) => ({
      success: true,
      url: "https://provider.example/internal-result",
      requested_url: url,
      markdown: "# Final provider title\n\nBody",
      content: "# Final provider title\n\nBody",
      size_chars: 28,
    }),
  });
  expect(result).toMatchObject({
    source_type: "url",
    source_uri: "https://example.com/original",
    title: "Final provider title",
  });
  store.close();
});

test("URL scrape failure does not write a document", async () => {
  const dir = tempDir();
  const store = new ResearchStore(join(dir, "research.db"));
  await expect(
    ingestSource(store, {
      source: "https://example.com/down",
      sourceType: "url",
      scrape: async () => {
        throw new Error("agentscrape provider unavailable");
      },
    }),
  ).rejects.toThrow("agentscrape provider unavailable");
  expect(
    store.db.query("SELECT COUNT(*) AS count FROM documents").get(),
  ).toEqual({ count: 0 });
  store.close();
});

test("numeric HTML entities are bounds checked", () => {
  expect(decodeHtmlEntities("ok &#x1F9E0;")).toBe("ok 🧠");
  expect(decodeHtmlEntities("bad &#x110000; and &#999999999999;")).toBe(
    "bad &#x110000; and &#999999999999;",
  );
});
