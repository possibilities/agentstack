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
      appendFileSync(log, JSON.stringify({ method: frame.method, threadId }) + "\n");
      peer.send(JSON.stringify({ id: frame.id, result: { turn: { id: randomUUID() } } }));
      notify("turn/completed");
    }
    if (frame.method === "thread/list") {
      const seen = new Set();
      const data = entries().filter((entry) => entry.method === "thread/start" && !seen.has(entry.threadId) && seen.add(entry.threadId))
        .map((entry) => ({ id: entry.threadId, parentThreadId: null, forkedFromId: null, ephemeral: false }));
      peer.send(JSON.stringify({ id: frame.id, result: { data, nextCursor: null } }));
    }
    if (frame.method === "thread/read") {
      const turns = entries().filter((entry) => entry.method === "turn/start" && entry.threadId === frame.params.threadId);
      if (frame.params.includeTurns && turns.length === 0) peer.send(JSON.stringify({ id: frame.id, error: { message: "not materialized yet" } }));
      else peer.send(JSON.stringify({ id: frame.id, result: { thread: { id: frame.params.threadId, turns } } }));
    }
    if (frame.method === "thread/loaded/list") peer.send(JSON.stringify({ id: frame.id, result: { data: [] } }));
  }));
  if (listen.startsWith("unix://")) server.listen(listen.slice("unix://".length));
  else server.listen(Number(new URL(listen).port), "127.0.0.1");
}
