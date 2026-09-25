#!/usr/bin/env node
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { WebSocketServer } from "ws";

if (process.argv.includes("--device-auth")) {
  process.stdout.write(`\nWelcome to Codex [v[90m0.0.0-test[0m]\n[90mOpenAI's command-line coding agent[0m\n\nFollow these steps to sign in with ChatGPT using device code authorization:\n\n1. Open this link in your browser and sign in to your account\n   [34mhttps://auth.openai.com/codex/device[0m\n\n2. Enter this one-time code [90m(expires in 15 minutes)[0m\n   [34mABCD-EFGH[0m\n\n[90mContinue only if you started this login in Codex. If a website or another person gave you this code, cancel.[0m\n`);
  setInterval(() => undefined, 60_000);
} else {

  const listenIndex = process.argv.indexOf("--listen");
  const listen = process.argv[listenIndex + 1];
  if (!listen) {
    process.stderr.write("missing --listen\n");
    process.exit(1);
  }
  const server = createServer((req, res) => {
    if (req.url === "/readyz") {
      res.writeHead(200).end("ok");
      return;
    }
    res.writeHead(404).end();
  });
  const history = process.argv[process.argv.indexOf("--history-dir") + 1];
  const log = join(history, "fake-threads.jsonl");
  const entries = () => {
    try { return readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)); }
    catch (error) { if (error.code === "ENOENT") return []; throw error; }
  };
  const notify = (method) => {
    for (const client of wss.clients) client.send(JSON.stringify({ method }));
  };
  const wss = new WebSocketServer({ server });
  wss.on("connection", (peer) => peer.on("message", (raw) => {
    const frame = JSON.parse(String(raw));
    if (frame.method === "initialize") peer.send(JSON.stringify({ id: frame.id, result: {} }));
    if (frame.method === "thread/start") {
      const id = randomUUID();
      appendFileSync(log, JSON.stringify({ method: frame.method, cwd: frame.params.cwd ?? process.cwd(), threadId: id }) + "\n");
      peer.send(JSON.stringify({ id: frame.id, result: { thread: { id } } }));
      notify("thread/started");
    }
    if (frame.method === "thread/resume") {
      if (!entries().some((entry) => entry.method === "turn/start" && entry.threadId === frame.params.threadId)) {
        peer.send(JSON.stringify({ id: frame.id, error: { message: "no rollout found for thread id " + frame.params.threadId } }));
        return;
      }
      appendFileSync(log, JSON.stringify({ method: frame.method, cwd: frame.params.cwd, threadId: frame.params.threadId }) + "\n");
      peer.send(JSON.stringify({ id: frame.id, result: { thread: { id: frame.params.threadId } } }));
    }
    if (frame.method === "turn/start") {
      const threadId = frame.params.threadId;
      if (!entries().some((entry) => entry.method === "thread/start" && entry.threadId === threadId)) {
        peer.send(JSON.stringify({ id: frame.id, error: { message: "unknown thread" } }));
        return;
      }
      const turnId = randomUUID();
      appendFileSync(log, JSON.stringify({ method: frame.method, threadId, turnId, input: frame.params.input }) + "\n");
      peer.send(JSON.stringify({ id: frame.id, result: { turn: { id: turnId } } }));
      notify("turn/completed");
    }
    if (frame.method === "turn/steer") peer.send(JSON.stringify({ id: frame.id, result: { turnId: frame.params.expectedTurnId } }));
    if (frame.method === "turn/interrupt") peer.send(JSON.stringify({ id: frame.id, result: {} }));
    if (frame.method === "thread/list") {
      const seen = new Set();
      const data = entries().filter((entry) => entry.method === "thread/start" && !seen.has(entry.threadId) && seen.add(entry.threadId))
        .map((entry) => ({ id: entry.threadId, parentThreadId: null, forkedFromId: null, ephemeral: false }));
      peer.send(JSON.stringify({ id: frame.id, result: { data, nextCursor: null } }));
    }
    if (frame.method === "thread/read") {
      const turns = entries().filter((entry) => entry.method === "turn/start" && entry.threadId === frame.params.threadId);
      if (frame.params.includeTurns && turns.length === 0) peer.send(JSON.stringify({ id: frame.id, error: { message: "not materialized yet" } }));
      else peer.send(JSON.stringify({ id: frame.id, result: { thread: { id: frame.params.threadId, status: { type: "idle" }, turns } } }));
    }
    if (frame.method === "thread/turns/list") peer.send(JSON.stringify({ id: frame.id, result: { data: entries().filter((entry) => entry.method === "turn/start" && entry.threadId === frame.params.threadId).map((entry) => ({ id: entry.turnId, items: entry.input, status: "completed" })), nextCursor: null } }));
    if (frame.method === "thread/items/list") peer.send(JSON.stringify({ id: frame.id, result: { data: entries().filter((entry) => entry.method === "turn/start" && entry.threadId === frame.params.threadId).flatMap((entry) => entry.input.map((item) => ({ turnId: entry.turnId, item }))), nextCursor: null } }));
    if (frame.method === "thread/searchOccurrences") peer.send(JSON.stringify({ id: frame.id, result: { data: [], nextCursor: null } }));
    if (frame.method === "thread/queue/add" || frame.method === "thread/queue/update") peer.send(JSON.stringify({ id: frame.id, result: { queuedSubmission: { id: frame.params.queuedSubmissionId ?? randomUUID(), input: frame.params.input, clientUserMessageId: frame.params.clientUserMessageId ?? "existing" } } }));
    if (frame.method === "thread/queue/list") peer.send(JSON.stringify({ id: frame.id, result: { data: [], nextCursor: null } }));
    if (frame.method === "thread/queue/delete") peer.send(JSON.stringify({ id: frame.id, result: { deleted: true } }));
    if (frame.method === "thread/queue/reorder") peer.send(JSON.stringify({ id: frame.id, result: {} }));
    if (frame.method === "thread/queue/start") peer.send(JSON.stringify({ id: frame.id, result: { turn: { id: randomUUID() } } }));
    if (frame.method === "thread/attachment/add") peer.send(JSON.stringify({ id: frame.id, result: { outcome: "created", attachment: { id: randomUUID(), attachmentType: frame.params.attachmentType, identityKey: frame.params.identityKey, payload: frame.params.payload, createdAt: 1 } } }));
    if (frame.method === "thread/attachment/list") peer.send(JSON.stringify({ id: frame.id, result: { data: [], nextCursor: null } }));
    if (frame.method === "thread/attachment/remove") peer.send(JSON.stringify({ id: frame.id, result: {} }));
    if (frame.method === "thread/loaded/list") peer.send(JSON.stringify({ id: frame.id, result: { data: [] } }));
  }));
  if (listen.startsWith("unix://")) server.listen(listen.slice("unix://".length));
  else server.listen(Number(new URL(listen).port), "127.0.0.1");
}
