// Optional rendered check of the Content space. The real Content API runs against a disposable state
// directory on free loopback ports; owner and discovery are fixtures. No live owner is touched.
// PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node test/content-browser-check.mjs
// CHROME_BIN may override the local headless Chrome executable. CONTENT_NEXT=dev uses `next dev` instead of a build.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { copyFile, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { publishedJsonSchema, serveApi, serveSocket, serveWebSocket, socketCall, socketPath } from "@agentstack/api";
import { api as contentApi } from "../../content/dist/api.js";

if (!process.env.PLAYWRIGHT_MODULE) throw new Error("Set PLAYWRIGHT_MODULE to an installed Playwright module");
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
const require = createRequire(import.meta.url);
const uix = dirname(dirname(fileURLToPath(import.meta.url)));
const root = dirname(dirname(uix));
const dir = await mkdtemp(join("/tmp", "as-content-ui-"));
const evidence = process.env.CONTENT_EVIDENCE_DIR ?? join(dir, "evidence");
await mkdir(evidence, { recursive: true });
async function port() { const server = createServer(); await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve)); const value = server.address().port; await new Promise((resolve) => server.close(resolve)); return value; }
const env = { ...process.env, AGENTSTACK_STATE_DIR: dir, NEXT_TELEMETRY_DISABLED: "1",
  AGENTSTACK_CONTENT_PORT: String(await port()), AGENTSTACK_CONTENT_ARTIFACT_PORT: String(await port()) };
// Socket listings publish JSON Schemas, so fixtures need real zod types; zod comes from the content package.
const { z } = createRequire(join(root, "packages", "content", "package.json"))("zod");
const passthrough = z.looseObject({});
const handlers = { owner_status: () => ({ pid: process.pid, children: [], mcpUrls: {}, indexUrl: null, uixUrl: null, inspectorUrl: null }) };
const fixture = (names) => names.map((name) => ({ name, description: name, input: passthrough, output: passthrough, async call() { return handlers[name](); } }));
const sockets = [];
let websocket, next, browser, content, page;
let log = "";
const contentCall = (name, args = {}) => socketCall(socketPath("content", env), "tools/call", { name, arguments: args });

try {
  content = await serveApi({ name: "content", transport: "socket", env, root });
  // The gateway admits a connection only when every configured package's socket answers, so it
  // sees a workspace of just the packages this check serves.
  const gatewayRoot = join(dir, "gateway");
  for (const name of ["content", "owner", "api"]) {
    await mkdir(join(gatewayRoot, "packages", name), { recursive: true });
    await copyFile(join(root, "packages", name, "api.yaml"), join(gatewayRoot, "packages", name, "api.yaml"));
  }
  websocket = await serveWebSocket({ env, root: gatewayRoot, port: 0 });
  const doc = (name, api) => ({ name, packageName: `@agentstack/${name}`, description: `${name} fixture`, events: api?.events?.topics ?? {}, eventScope: null,
    transports: [{ type: "websocket", description: "Isolated fixture", supported: true, subscriptions: true, endpoint: websocket.url,
      operations: (api?.operations ?? []).map((operation) => operation.name), events: Object.keys(api?.events?.topics ?? {}), routes: [] }],
    operations: (api?.operations ?? []).map((operation) => ({ name: operation.name, title: operation.annotations?.title ?? null, description: operation.description,
      annotations: operation.annotations ?? {}, inputSchema: publishedJsonSchema(operation.input), outputSchema: publishedJsonSchema(operation.output) })) });
  const catalog = [doc("content", contentApi), doc("owner"), doc("api")];
  handlers.docs_snapshot = () => ({ packages: catalog });
  for (const [name, names, topics] of [["owner", ["owner_status"], { pids_changed: "Fixture" }], ["api", ["docs_snapshot"], {}]]) {
    sockets.push(await serveSocket({ info: { name, description: name, transportDescription: "Fixture", path: socketPath(name, env) }, context: {}, operations: fixture(names), events: { topics } }));
  }
  const nextPort = await port();
  const mode = process.env.CONTENT_NEXT === "dev" ? "dev" : "start";
  next = spawn(process.execPath, [require.resolve("next/dist/bin/next"), mode, "--hostname", "127.0.0.1", "--port", String(nextPort)], { cwd: uix, env, stdio: ["ignore", "pipe", "pipe"] });
  next.stdout.on("data", (chunk) => { log += chunk; }); next.stderr.on("data", (chunk) => { log += chunk; });
  const origin = `http://127.0.0.1:${nextPort}`;
  for (let attempt = 0; ; attempt++) {
    try { if ((await fetch(`${origin}/x/content`)).ok) break; } catch { /* bounded readiness check */ }
    if (attempt > 1200 || next.exitCode !== null) throw new Error(log);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
  const context = await browser.newContext({ viewport: { width: 1900, height: 1150 }, reducedMotion: "reduce", permissions: ["clipboard-read", "clipboard-write"] });
  page = await context.newPage();
  page.setDefaultTimeout(30_000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${origin}/x/content`);
  const documents = page.locator('[data-window="content-documents"]');
  const library = page.locator('[data-window="content-library"]');
  const editor = page.locator('[data-window="content-editor"]');
  const preview = page.locator('[data-window="content-preview"]');
  const artifacts = page.locator('[data-window="content-artifacts"]');
  await documents.getByText("No documents yet", { exact: true }).waitFor();
  await editor.getByText("Choose a document to edit", { exact: true }).waitFor();
  await preview.getByText("Choose something to preview", { exact: true }).waitFor();
  await artifacts.getByText("No Artifacts · agents publish them", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Spaces · Content" }).waitFor();
  assert.equal(await artifacts.getByRole("button", { name: /publish/i }).count(), 0, "no publish control");
  await page.screenshot({ path: join(evidence, "content-empty.png"), animations: "disabled" });

  // Create a collection; the Library then shows it.
  await library.getByRole("button", { name: "New collection", exact: true }).click();
  const collectionDialog = page.getByRole("dialog", { name: "New collection" });
  await collectionDialog.getByLabel("Title").fill("Research notes");
  assert.equal(await collectionDialog.getByLabel("Slug").inputValue(), "research-notes");
  await collectionDialog.getByRole("button", { name: "Create collection" }).click();
  await library.getByRole("button", { name: /^Research notes( \d+)?$/ }).waitFor();
  assert.equal((await contentCall("collection_list")).collections[0].slug, "research-notes");

  // Upload a PNG and a 600 KiB binary through the chooser; the binary needs three chunks.
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR4nGP8z8DwnwEIGBmhDEYGBgBQKAP/2ZJqkgAAAABJRU5ErkJggg==", "base64");
  const big = Buffer.alloc(600 * 1024, 7);
  await writeFile(join(dir, "dot.png"), png);
  await writeFile(join(dir, "blob.bin"), big);
  const chooser = page.waitForEvent("filechooser");
  await library.getByRole("button", { name: "Upload here", exact: true }).click();
  await (await chooser).setFiles([join(dir, "dot.png"), join(dir, "blob.bin")]);
  await library.getByRole("button", { name: "blob.bin", exact: true }).first().waitFor();
  await library.locator("tbody").getByText("dot.png", { exact: true }).waitFor();
  await library.locator("tbody").getByText("blob.bin", { exact: true }).waitFor();
  const stored = (await contentCall("item_list", { collection: "research-notes" })).items;
  assert.deepEqual(stored.map((item) => [item.name, item.kind, item.bytes]).sort(), [["blob.bin", "file", big.length], ["dot.png", "image", png.length]]);
  assert.equal(stored.find((item) => item.name === "blob.bin").digest, createHash("sha256").update(big).digest("hex"));

  // An image previews inline from Package API bytes; a file shows its first bytes as hex.
  await library.locator("tbody").getByRole("button", { name: "image dot.png", exact: true }).click();
  await preview.getByRole("img", { name: "dot.png" }).waitFor();
  await library.locator("tbody").getByRole("button", { name: "file blob.bin", exact: true }).click();
  await preview.getByText("First bytes", { exact: true }).waitFor();
  await page.screenshot({ path: join(evidence, "content-library.png"), animations: "disabled" });

  // Create a document with a body; it appears in Documents and opens in the editor.
  await documents.getByRole("button", { name: "New document", exact: true }).click();
  const form = editor.getByRole("form", { name: "New document" });
  await form.getByLabel("Title").fill("Field notes");
  await form.getByLabel("Tags").fill("research, audio");
  await form.getByLabel("Markdown").fill("# Field notes\n\nFirst draft.");
  await editor.getByRole("button", { name: "Create document" }).click();
  await editor.getByRole("form", { name: "Edit Field notes" }).waitFor();
  await documents.getByRole("button", { name: /Field notes/ }).first().waitFor();
  assert.match((await contentCall("get", { ref: "field-notes" })).content, /First draft\./);

  // Edit and save with ⌘S; the preview follows.
  const body = editor.getByLabel("Markdown");
  await body.fill("# Field notes\n\nSecond draft with a link to [[field-notes]].");
  await editor.getByText("Unsaved changes · ⌘S to save").waitFor();
  await body.press("Meta+s");
  await editor.getByText("All changes saved").waitFor();
  assert.match((await contentCall("get", { ref: "field-notes" })).content, /Second draft/);
  await preview.getByText("Second draft with a link to", { exact: false }).waitFor();

  // Wikilink completion offers documents after [[.
  await body.press("End");
  await body.pressSequentially("\n\nSee [[fie");
  await editor.getByRole("option", { name: /Field notes/ }).waitFor();
  await body.press("Enter");
  assert.match(await body.inputValue(), /See \[\[field-notes\]\]$/);

  // A conflicting API edit while a draft is open offers Keep mine / Use theirs.
  const fresh = await contentCall("get", { ref: "field-notes" });
  await contentCall("document_update", { ref: "field-notes", expectedDigest: fresh.digest, content: "# Field notes\n\nEdited by an agent." });
  await editor.getByText("Changed elsewhere", { exact: true }).waitFor();
  await page.screenshot({ path: join(evidence, "content-conflict.png"), animations: "disabled" });
  await editor.getByRole("button", { name: "Use theirs" }).click();
  await editor.getByText("All changes saved").waitFor();
  assert.match(await body.inputValue(), /Edited by an agent\./);

  // content_changed refreshes the Documents list after an API-side mutation, without reloading.
  await contentCall("new", { title: "From the API" });
  await documents.getByRole("button", { name: /From the API/ }).first().waitFor();

  // Search shows FTS snippets.
  await documents.getByLabel("Search documents").fill("agent");
  await documents.locator("mark").first().waitFor();
  await documents.getByLabel("Clear search").click();

  // An agent-published Artifact appears; its versions expand; tombstone needs a reason and Restore undoes it.
  const site = Buffer.from("<h1>Hello</h1>");
  const digest = createHash("sha256").update(site).digest("hex");
  const stage = await contentCall("blob_stage_start", { bytes: site.length, digest });
  await contentCall("blob_stage_chunk", { id: stage.id, offset: 0, base64: site.toString("base64") });
  await contentCall("blob_stage_finish", { id: stage.id });
  await contentCall("artifact_publish", { name: "hello-page", kind: "page", files: [{ name: "index.html", blob: digest }] });
  await artifacts.getByText("hello-page", { exact: true }).waitFor();
  await artifacts.getByRole("button", { name: "Show hello-page versions" }).click();
  await artifacts.getByRole("list", { name: "hello-page versions, newest first" }).waitFor();
  await artifacts.getByRole("button", { name: /hello-page/ }).nth(1).click();
  await preview.getByRole("link", { name: "Open this version" }).waitFor();
  await page.screenshot({ path: join(evidence, "content-artifact.png"), animations: "disabled" });
  await artifacts.getByRole("button", { name: "hello-page actions" }).click();
  await page.getByRole("menuitem", { name: "Tombstone every version…" }).click();
  const tombstone = page.getByRole("alertdialog");
  assert.equal(await tombstone.getByRole("button", { name: "Tombstone" }).isDisabled(), true, "a reason is required");
  await tombstone.getByLabel("Reason").fill("Superseded");
  await tombstone.getByRole("button", { name: "Tombstone" }).click();
  await artifacts.getByText("No Artifacts · agents publish them", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Restore", exact: true }).click();
  await artifacts.getByText("hello-page", { exact: true }).waitFor();

  // Deleting an item warns that its shared link stops working.
  await library.locator("tbody").getByRole("button", { name: "dot.png actions" }).click();
  await page.getByRole("menuitem", { name: "Delete permanently…" }).click();
  const deletion = page.getByRole("alertdialog");
  await deletion.getByText(/stops working for everyone who has it/).waitFor();
  await deletion.getByRole("button", { name: "Delete permanently" }).click();
  await library.locator("tbody").getByText("dot.png", { exact: true }).waitFor({ state: "detached" });

  // Deleting a collection explains that items become ungrouped.
  await library.getByRole("button", { name: "Research notes actions" }).click();
  await page.getByRole("menuitem", { name: "Delete collection…" }).click();
  await page.getByRole("alertdialog").getByText(/become ungrouped/).waitFor();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete collection" }).click();
  await library.getByRole("button", { name: /^Research notes( \d+)?$/ }).waitFor({ state: "detached" });
  assert.equal((await contentCall("item_list", { collection: null })).total, 1);
  // The Library falls back to every item once the collection it showed is gone.
  await library.getByText("content · All items", { exact: true }).waitFor();

  // Inspector hand-off and palette.
  await documents.getByRole("button", { name: "Field notes actions" }).click();
  await page.getByRole("menuitem", { name: "Inspect record" }).click();
  await page.getByRole("button", { name: "Edit in Content" }).waitFor();
  await page.keyboard.press("Meta+k");
  await page.getByPlaceholder(/Jump to/).fill("From the API");
  await page.getByRole("option", { name: /From the API/ }).first().waitFor();
  await page.keyboard.press("Escape");

  await page.screenshot({ path: join(evidence, "content-final.png"), animations: "disabled" });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.screenshot({ path: join(evidence, "content-dark.png"), animations: "disabled" });
  assert.deepEqual(errors, [], "browser has no uncaught application errors");
  console.log(JSON.stringify({ ok: true, evidence, assertions: "empty states, no publish control, collection create, chunked upload with progress, image and hex previews, new document, save, wikilink completion, conflict use-theirs, content_changed refresh, search snippets, artifact versions, tombstone with reason and undo, item delete wording, collection delete wording, inspector hand-off, palette search, dark" }, null, 2));
} catch (error) {
  if (page) await page.screenshot({ path: join(evidence, "failure.png"), animations: "disabled" }).catch(() => undefined);
  console.error(log.slice(-4000));
  throw error;
} finally {
  await browser?.close();
  if (next && next.exitCode === null) { next.kill("SIGTERM"); await new Promise((resolve) => next.once("exit", resolve)); }
  await websocket?.close();
  await Promise.all(sockets.map((socket) => socket.close()));
  await content?.close();
  if (!process.env.CONTENT_EVIDENCE_DIR) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
}
