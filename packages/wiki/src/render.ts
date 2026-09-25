import MarkdownIt from "markdown-it";
import { stripCode } from "./links.js";
import { documentUrl, latestArtifactUrl } from "./urls.js";

export interface RenderedDocument {
  title: string;
  html: string;
}

/** Mirrors the [[target]] / [[target|alias]] grammar in links.ts — that
 * module keeps the regex private, so the shape is duplicated here rather
 * than exported for a single caller. */
const WIKILINK = /\[\[([^[\]|]+)(?:\|([^[\]]*))?\]\]/g;

/** markdown-it replaces NUL with U+FFFD during normalization, so it cannot
 * mark a placeholder; Private Use Area characters pass through untouched
 * and never occur in real prose, so they round-trip through rendering. */
const TOKEN_OPEN = "\uE000";
const TOKEN_CLOSE = "\uE001";

const md = new MarkdownIt({ html: false, linkify: true, typographer: false });

/** [[…]] is rewritten to plain markdown before markdown-it ever sees it, so
 * link resolution stays independent of the renderer. Dangling targets can't
 * become markdown themselves (html:false would escape a literal <span>), so
 * they're swapped in as opaque tokens and patched into the rendered HTML
 * afterward. */
export function renderMarkdown(
  body: string,
  resolveWikilink: (target: string) => string | null,
): string {
  // stripCode blanks fenced/inline code with spaces at the same offsets, so
  // matching against it — not body — is the mask: a [[…]] written inside
  // code no longer looks like one here and is left as prose.
  const masked = stripCode(body);
  const dangling = new Map<string, string>();
  let out = "";
  let cursor = 0;
  let index = 0;
  for (const match of masked.matchAll(WIKILINK)) {
    const start = match.index;
    const target = (match[1] ?? "").trim();
    out += body.slice(cursor, start);
    cursor = start + match[0].length;
    if (target === "") {
      // No target: not a link by links.ts's own grammar either, so it
      // passes through as the literal text the author wrote.
      out += match[0];
      continue;
    }
    const alias = (match[2] ?? "").trim();
    const display = alias === "" ? target : alias;
    const href = resolveWikilink(target);
    if (href === null) {
      const token = `${TOKEN_OPEN}${index++}${TOKEN_CLOSE}`;
      dangling.set(token, `<span class="dangling">${escapeHtml(display)}</span>`);
      out += token;
      continue;
    }
    out += `[${display}](${href})`;
  }
  out += body.slice(cursor);
  let html = md.render(out);
  for (const [token, replacement] of dangling) html = html.replaceAll(token, replacement);
  return html;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const STYLE = `
:root {
  color-scheme: light dark;
  --bg: #ffffff;
  --fg: #1a1a1a;
  --muted: #656b76;
  --border: #dde1e6;
  --link: #0b5fff;
  --code-bg: #f4f5f7;
  --tag-bg: #eef0f3;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #14161a;
    --fg: #e6e6e6;
    --muted: #9aa0aa;
    --border: #2c2f36;
    --link: #7db0ff;
    --code-bg: #1d2025;
    --tag-bg: #21242a;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  padding: 2.5rem 1.25rem;
  background: var(--bg);
  color: var(--fg);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
  line-height: 1.55;
}
main { max-width: 70ch; margin: 0 auto; }
a { color: var(--link); }
h1 { margin-top: 0; }
h1, h2, h3 { line-height: 1.25; }
pre {
  background: var(--code-bg);
  border-radius: 6px;
  padding: 0.85rem;
  overflow-x: auto;
}
code {
  background: var(--code-bg);
  border-radius: 4px;
  padding: 0.15em 0.4em;
  font-size: 0.9em;
}
pre code { padding: 0; background: none; }
.meta { color: var(--muted); font-size: 0.9rem; }
.tags { margin: 0.25rem 0 1rem; }
.tag {
  display: inline-block;
  background: var(--tag-bg);
  border-radius: 999px;
  padding: 0.1rem 0.65rem;
  margin: 0 0.35rem 0.35rem 0;
  font-size: 0.8rem;
}
.dangling { color: var(--muted); border-bottom: 1px dashed var(--muted); }
ul.doc-list, ul.artifact-list, ul.listing { list-style: none; padding: 0; }
ul.doc-list li, ul.artifact-list li, ul.listing li {
  padding: 0.5rem 0;
  border-bottom: 1px solid var(--border);
}
ul.doc-list li span, ul.artifact-list li span { display: block; }
footer.backlinks {
  margin-top: 2.5rem;
  padding-top: 1rem;
  border-top: 1px solid var(--border);
}
footer.backlinks ul { list-style: none; padding: 0; }
footer.backlinks li { padding: 0.3rem 0; color: var(--muted); }
`;

function page(title: string, bodyHtml: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
${bodyHtml}
</body>
</html>
`;
}

/** The heading a document declares in frontmatter or its title-cased slug is
 * already the page's <h1>; a leading "# Title" in the body would say it
 * twice. Only the very first block qualifies — a heading further down is
 * structure the author chose to keep. */
const LEADING_H1 = /^\s*<h1>([\s\S]*?)<\/h1>\s*/;

function stripLeadingH1(html: string, title: string): string {
  const match = LEADING_H1.exec(html);
  if (match === null) return html;
  const heading = (match[1] ?? "").replace(/<[^>]*>/g, "").trim();
  if (heading !== escapeHtml(title.trim())) return html;
  return html.slice(match[0].length);
}

export function documentPage(options: {
  title: string;
  slug: string;
  tags: string[];
  updated: string | null;
  bodyHtml: string;
  backlinks: { slug: string; title: string; kind: string }[];
}): string {
  const title = options.title.trim() === "" ? options.slug : options.title;
  const body = stripLeadingH1(options.bodyHtml, title);
  const tags =
    options.tags.length === 0
      ? ""
      : `<p class="tags">${options.tags
          .map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`)
          .join("")}</p>`;
  const updated =
    options.updated === null ? "" : `<p class="meta">Updated ${escapeHtml(options.updated)}</p>`;
  const backlinks =
    options.backlinks.length === 0
      ? ""
      : `<footer class="backlinks">
  <h2>Backlinks</h2>
  <ul>
    ${options.backlinks
      .map(
        (link) =>
          `<li><a href="${escapeHtml(documentUrl(link.slug))}">${escapeHtml(link.slug)} — ${escapeHtml(link.title)} (${escapeHtml(link.kind)})</a></li>`,
      )
      .join("\n    ")}
  </ul>
</footer>`;
  return page(
    title,
    `<main>
  <h1>${escapeHtml(title)}</h1>
  ${tags}
  ${updated}
  <article>${body}</article>
  ${backlinks}
</main>`,
  );
}

export function indexPage(options: {
  vaultRoot: string;
  documents: { slug: string; title: string; tags: string[]; updated: string | null }[];
  artifacts: { name: string; kind: string; version: string; title: string | null }[];
}): string {
  const documents =
    options.documents.length === 0
      ? "<p>No documents yet.</p>"
      : `<ul class="doc-list">
    ${options.documents
      .map((document) => {
        const details = [
          escapeHtml(document.slug),
          ...(document.tags.length > 0 ? [document.tags.map(escapeHtml).join(", ")] : []),
          ...(document.updated !== null ? [escapeHtml(document.updated)] : []),
        ].join(" · ");
        return `<li><a href="${escapeHtml(documentUrl(document.slug))}">${escapeHtml(document.title)}</a><span class="meta">${details}</span></li>`;
      })
      .join("\n    ")}
  </ul>`;
  const artifacts =
    options.artifacts.length === 0
      ? "<p>No artifacts yet.</p>"
      : `<ul class="artifact-list">
    ${options.artifacts
      .map((artifact) => {
        const details = `${escapeHtml(artifact.name)} · ${escapeHtml(artifact.kind)} · ${escapeHtml(artifact.version.slice(0, 12))}`;
        return `<li><a href="${escapeHtml(latestArtifactUrl(artifact.name))}">${escapeHtml(artifact.title ?? artifact.name)}</a><span class="meta">${details}</span></li>`;
      })
      .join("\n    ")}
  </ul>`;
  return page(
    "agentwiki",
    `<main>
  <h1>agentwiki</h1>
  <p class="meta">${escapeHtml(options.vaultRoot)}</p>
  <h2>Documents</h2>
  ${documents}
  <h2>Artifacts</h2>
  ${artifacts}
</main>`,
  );
}

/** A directory entry name; entries for subdirectories are expected to carry
 * a trailing "/" so the listing can tell them apart without a second stat. */
function hrefFor(base: string, entry: string): string {
  const isDirectory = entry.endsWith("/");
  const name = isDirectory ? entry.slice(0, -1) : entry;
  return `${base}${encodeURIComponent(name)}${isDirectory ? "/" : ""}`;
}

export function listingPage(options: { title: string; base: string; entries: string[] }): string {
  const entries =
    options.entries.length === 0
      ? "<p>Empty directory.</p>"
      : `<ul class="listing">
    ${options.entries
      .map(
        (entry) =>
          `<li><a href="${escapeHtml(hrefFor(options.base, entry))}">${escapeHtml(entry)}</a></li>`,
      )
      .join("\n    ")}
  </ul>`;
  return page(
    options.title,
    `<main>\n  <h1>${escapeHtml(options.title)}</h1>\n  ${entries}\n</main>`,
  );
}

export function errorPage(status: number, message: string): string {
  return page(
    `${status}`,
    `<main>\n  <h1>${status}</h1>\n  <p>${escapeHtml(message)}</p>\n</main>`,
  );
}
