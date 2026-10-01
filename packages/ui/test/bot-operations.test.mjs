import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire, registerHooks } from "node:module";
import { extname } from "node:path";
import test from "node:test";
import { publishedJsonSchema } from "../../api/src/schema.ts";

// The pure stack modules import one another bundler-style, without extensions.
registerHooks({ resolve(specifier, context, next) {
  return next(context.parentURL?.includes("/lib/stack/") && specifier.startsWith("./") && !extname(specifier) ? `${specifier}.ts` : specifier, context);
} });
const { botControlOperations, botOperationDraft, connectedVoiceSession, defaultBotOperation, inputKind, inputRequired, interactiveBotOperations, operationScopeError, parseOperationDraft } = await import("../lib/stack/bot-operations.ts");
const { BotUploads } = await import("../lib/stack/bot-uploads.ts");

const { z } = createRequire(new URL("../../api/package.json", import.meta.url))("zod");

test("Bot operation inputs preserve scope, explicit zero/false, JSON parts and omitted optionals", () => {
  const operation = { name: "chat_send", inputSchema: { required: ["botId", "threadId", "input"], properties: {
    botId: { type: "string" }, threadId: { type: "string" }, input: { type: "array" },
    offset: { type: "integer" }, enabled: { type: "boolean" }, cursor: { type: "string" },
    clientUserMessageId: { type: "string", format: "uuid" },
  } } };
  const draft = botOperationDraft(operation, { id: "bot-1", mainThreadId: "sanctioned-root" }, null);
  assert.equal(draft.threadId, "sanctioned-root");
  assert.match(draft.clientUserMessageId, /^[0-9a-f-]{36}$/);
  const input = parseOperationDraft(operation, { ...draft, botId: "another-bot", input: '[{"type":"text","text":"Keep  spaces"}]', offset: "0", enabled: "false" }, "bot-1");
  assert.equal(input.botId, "bot-1");
  assert.equal(input.offset, 0);
  assert.equal(input.enabled, false);
  assert.deepEqual(input.input, [{ type: "text", text: "Keep  spaces" }]);
  assert.equal("cursor" in input, false);
  assert.throws(() => parseOperationDraft(operation, { ...draft, input: "{" }, "bot-1"), /input must be valid array/);
  assert.throws(() => parseOperationDraft(operation, { ...draft, threadId: "" }, "bot-1"), /threadId is required/);
  assert.throws(() => parseOperationDraft(operation, { ...draft, offset: "1.2" }, "bot-1"), /integer/);
});

test("voice speech defaults only to the selected Bot's exact call", () => {
  const operation = { name: "voice_speak", inputSchema: { properties: { sessionId: { type: "string" } } } };
  const bot = { id: "bot-1", mainThreadId: "root" };
  const call = { botId: "bot-1", sessionId: "exact", threadId: "root", phase: "connected" };
  assert.equal(botOperationDraft(operation, bot, { ...call, botId: "bot-2" }).sessionId, "");
  assert.equal(botOperationDraft(operation, bot, { ...call, phase: "dialing" }).sessionId, "");
  assert.equal(botOperationDraft(operation, bot, call).sessionId, "exact");
});

test("live publication's required defaults remain omittable, including zero, false and anyOf", () => {
  const input = z.strictObject({ botId: z.string(), limit: z.number().int().min(1).max(100).default(25), offset: z.number().int().nonnegative().default(0),
    sortDirection: z.enum(["asc", "desc"]).default("desc"), enabled: z.boolean().default(false), note: z.string().nullable().default(null) });
  const operation = { name: "chat_list", inputSchema: publishedJsonSchema(input) };
  assert.ok(operation.inputSchema.required.includes("limit"), "exercise the live output-mode publication, not an input-mode fixture");
  assert.ok(operation.inputSchema.properties.note.anyOf, "publication expands nullable types into anyOf");
  assert.equal(inputKind(operation.inputSchema.properties.note), "json");
  for (const key of ["limit", "offset", "sortDirection", "enabled", "note"]) assert.equal(inputRequired(operation, key), false);
  const draft = botOperationDraft(operation, { id: "bot-1" }, null);
  const omitted = parseOperationDraft(operation, draft, "bot-1");
  assert.deepEqual(omitted, { botId: "bot-1" });
  assert.deepEqual(input.parse(omitted), { botId: "bot-1", limit: 25, offset: 0, sortDirection: "desc", enabled: false, note: null });
  assert.deepEqual(parseOperationDraft(operation, { ...draft, offset: "0", enabled: "false", note: "null" }, "bot-1"), { botId: "bot-1", offset: 0, enabled: false, note: null });
  assert.equal(parseOperationDraft(operation, { ...draft, note: '"null"' }, "bot-1").note, "null");
});

test("speech binding rejects foreign, changed, disconnected and wrong-thread calls at submission", () => {
  const operation = { name: "voice_speak", annotations: {}, inputSchema: { properties: { sessionId: { type: "string" } } } };
  const bot = { id: "bot-1", mainThreadId: "root", state: "running", runningAccount: "account", recoveryIssue: null };
  const call = { botId: bot.id, sessionId: "exact", threadId: "root", phase: "connected" };
  const input = { sessionId: "exact", text: "Announcement" };
  assert.equal(operationScopeError(operation, input, bot, call), null);
  for (const changed of [null, { ...call, botId: "bot-2" }, { ...call, sessionId: "new" }, { ...call, phase: "dialing" }, { ...call, threadId: "other-root" }]) {
    assert.match(operationScopeError(operation, input, bot, changed), /exact current connected voice call/);
  }
  assert.equal(connectedVoiceSession(bot, { ...call, botId: "bot-2" }), "");
});

test("stopped Bots can admit durable queue messages only on their main thread", () => {
  const operation = { name: "chat_enqueue", annotations: {}, inputSchema: { properties: { botId: { type: "string" }, threadId: { type: "string" } } } };
  const bot = { id: "bot-1", mainThreadId: "root", state: "stopped", runningAccount: null };
  assert.equal(operationScopeError(operation, { threadId: "root" }, bot, null), null);
  assert.match(operationScopeError(operation, { threadId: "descendant" }, bot, null), /current main thread/);
  assert.match(operationScopeError(operation, { threadId: "root" }, { ...bot, mainThreadId: null }, null), /current main thread/);
  assert.match(operationScopeError({ ...operation, name: "chat_send" }, { threadId: "root" }, bot, null), /verified running Bot/);
});

const orientation = (state, extra = {}) => ({ admissionId: "8f0f2a54-6a63-4f65-9b3c-0e5d0d0b7a10", state, threadId: null, turnId: null, issue: null, updatedAt: 1, ...extra });
const running = (fields = {}) => ({ id: "bot-1", state: "running", runningAccount: "account", recoveryIssue: null, mainThreadId: null, orientation: null, ...fields });
const chatOpen = { name: "chat_open", annotations: {}, inputSchema: { properties: { botId: { type: "string" }, input: { type: "array" } } } };
const chatSend = { name: "chat_send", annotations: {}, inputSchema: { properties: { botId: { type: "string" }, threadId: { type: "string" }, input: { type: "array" } } } };
const unfinished = /Initialization is unfinished; Stack won’t create another main thread/;
const admitting = /admitting this Bot’s introduction/;

test("a first chat opens only a Bot with no main thread and no unfinished initialization", () => {
  // Legacy Bots (null or absent) and every settled outcome open a first thread once, and default to doing so.
  for (const settled of [null, undefined, ...["completed", "failed", "interrupted", "retired"].map((state) => orientation(state))]) {
    const bot = running({ orientation: settled });
    assert.equal(operationScopeError(chatOpen, {}, bot, null), null, `${settled?.state ?? "legacy"} without a root`);
    assert.equal(defaultBotOperation(bot), "chat_open");
    assert.match(operationScopeError(chatOpen, {}, { ...bot, mainThreadId: "root" }, null), /already has a main thread; use chat_send/);
    assert.equal(defaultBotOperation({ ...bot, mainThreadId: "root" }), "chat_list");
  }
  // Admission, a running introduction and an unknown outcome refuse a replacement, whether or not a root is recorded.
  for (const state of ["pending", "creating", "ready", "submitting", "running", "unknown"]) {
    for (const mainThreadId of [null, "root"]) {
      const bot = running({ orientation: orientation(state, { threadId: mainThreadId }), mainThreadId });
      assert.match(operationScopeError(chatOpen, {}, bot, null), unfinished, `${state} ${mainThreadId ?? "without a root"}`);
      assert.equal(defaultBotOperation(bot), "chat_list", "the form starts on a read, not a refused action");
    }
  }
  // The server checks the verified live process first.
  assert.match(operationScopeError(chatOpen, {}, running({ state: "stopped", runningAccount: null }), null), /verified running Bot/);
});

test("competing direct input is refused only while the introduction is being admitted", () => {
  const send = (state, fields = {}) => operationScopeError(chatSend, { threadId: "root" }, running({ mainThreadId: "root", orientation: state ? orientation(state) : null, ...fields }), null);
  for (const state of ["pending", "creating", "ready", "submitting"]) assert.match(send(state), admitting, state);
  // Once admitted, native start-or-steer stands: a running introduction and an unknown outcome on the exact root still accept input.
  for (const state of [null, "running", "unknown", "completed", "failed", "interrupted", "retired"]) assert.equal(send(state), null, String(state));
  // Every operation the Bots API runs through interactive() is refused in admission; reads and other actions are not.
  for (const name of interactiveBotOperations) {
    const operation = { name, annotations: {}, inputSchema: { properties: { botId: { type: "string" }, threadId: { type: "string" } } } };
    assert.match(operationScopeError(operation, { threadId: "root" }, running({ mainThreadId: "root", orientation: orientation("creating") }), null), admitting, name);
  }
  const read = { name: "chat_list", annotations: { readOnlyHint: true }, inputSchema: { properties: { botId: { type: "string" } } } };
  const upload = { name: "chat_upload_start", annotations: {}, inputSchema: { properties: { botId: { type: "string" } } } };
  const admission = running({ orientation: orientation("submitting") });
  assert.equal(operationScopeError(read, {}, admission, null), null);
  assert.equal(operationScopeError(upload, {}, admission, null), null);
});

test("the workbench refuses exactly the operations the Bots API runs through interactive()", async () => {
  const api = await readFile(new URL("../../bots/api.ts", import.meta.url), "utf8");
  const interactive = api.split(/\n(?=export const \w+ = operation\()/).filter((source) => /\binteractive\(ctx, /.test(source)).map((source) => /name: "([a-z_]+)"/.exec(source)[1]);
  assert.ok(interactive.length >= 10);
  assert.deepEqual([...interactiveBotOperations].sort(), interactive.sort());
});

test("page-owned upload state survives observer dismissal and resumes an uncertain chunk from status", async () => {
  const calls = [];
  let receipt;
  let rejectChunk;
  let entered;
  const chunkStarted = new Promise((resolve) => { entered = resolve; });
  const uploads = new BotUploads(async (name, input) => {
    calls.push({ name, input });
    if (name === "chat_upload_start") receipt ??= { ...input, offset: 0, path: null };
    if (name === "chat_upload_chunk") {
      assert.equal(input.offset, receipt.offset);
      receipt = { ...receipt, offset: receipt.offset + Buffer.from(input.data, "base64").length };
      if (input.offset === 0) {
        entered();
        return new Promise((_, reject) => { rejectChunk = reject; });
      }
    }
    if (name === "chat_upload_finish") receipt = { ...receipt, path: "/verified/file.bin" };
    return { ...receipt };
  });
  const file = new File([new Uint8Array(300_000)], "file.bin");
  uploads.select("bot-1", file);
  uploads.select("bot-2", new File(["other"], "other.txt"));
  const id = uploads.getState()["bot-1"].id;
  const off = uploads.subscribe(() => {});
  const run = uploads.run("bot-1");
  assert.equal(uploads.getState()["bot-1"].pending, true);
  off(); // The dialog leaves; the server and work remain.
  await chunkStarted;
  await uploads.run("bot-1");
  uploads.select("bot-1", new File(["replacement"], "replacement.txt"));
  assert.equal(uploads.getState()["bot-1"].file, file, "pending input cannot be replaced");
  assert.equal(calls.filter((call) => call.name === "chat_upload_start").length, 1, "a reopened view cannot duplicate pending work");
  rejectChunk(new Error("connection closed after writing"));
  await run;
  const reopened = uploads.getState()["bot-1"];
  assert.equal(reopened.id, id);
  assert.equal(reopened.file, file);
  assert.equal(reopened.pending, false);
  assert.match(reopened.error, /Resume checks the server offset/);
  assert.deepEqual(calls.map((call) => call.name), ["chat_upload_start", "chat_upload_status", "chat_upload_chunk"], "failure never replays work automatically");
  await uploads.run("bot-1"); // Explicit human resume.
  assert.deepEqual(calls.map((call) => call.name), ["chat_upload_start", "chat_upload_status", "chat_upload_chunk", "chat_upload_start", "chat_upload_status", "chat_upload_chunk", "chat_upload_finish"]);
  assert.deepEqual(calls.filter((call) => call.name === "chat_upload_chunk").map((call) => call.input.offset), [0, 262144]);
  assert.ok(calls.every((call) => call.input.id === id && call.input.botId === "bot-1"));
  assert.equal(uploads.getState()["bot-1"].receipt.path, "/verified/file.bin");
  assert.equal(uploads.getState()["bot-2"].receipt, null, "each Bot retains independent state");
  const count = calls.length;
  await uploads.run("bot-1");
  assert.equal(calls.length, count, "completed state survives reopening without resending");
});

test("an uncertain upload finish is recovered by status without re-finishing", async () => {
  let receipt;
  let finishes = 0;
  const uploads = new BotUploads(async (name, input) => {
    if (name === "chat_upload_start") receipt ??= { ...input, offset: 0, path: null };
    if (name === "chat_upload_chunk") receipt.offset = receipt.bytes;
    if (name === "chat_upload_finish") {
      finishes++;
      receipt.path = "/verified/complete.txt";
      throw new Error("lost finish receipt");
    }
    return { ...receipt };
  });
  uploads.select("bot-1", new File(["complete"], "complete.txt"));
  await uploads.run("bot-1");
  assert.match(uploads.getState()["bot-1"].error, /lost finish receipt/);
  await uploads.run("bot-1");
  assert.equal(finishes, 1);
  assert.equal(uploads.getState()["bot-1"].receipt.path, "/verified/complete.txt");
  assert.equal(uploads.getState()["bot-1"].error, null);
});

test("every Bots operation has dedicated controls or is exposed by the scoped workbench", async () => {
  const api = await readFile(new URL("../../bots/api.ts", import.meta.url), "utf8");
  const names = [...api.matchAll(/name: "((?:bot|chat|voice)_[a-z_]+)"/g)].map((match) => match[1]);
  assert.ok(names.length >= 40);
  for (const name of names) assert.ok(botControlOperations.has(name) || name.startsWith("chat_") || name === "voice_speak", `${name} needs a deliberate UI home`);
  for (const name of botControlOperations) assert.ok(names.includes(name), `${name} must still exist`);
});
