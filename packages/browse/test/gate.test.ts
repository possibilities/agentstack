import assert from "node:assert/strict";
import { createServer, get } from "node:http";
import { once } from "node:events";
import test from "node:test";
import WebSocket, { WebSocketServer } from "ws";
import { BrowserGate } from "../src/gate.js";

test("managed gate drains accepted CDP, rejects new work on existing and new connections and fences viewer control", async () => {
  let implicit = true;
  const sessions: Array<{ id: string; profile: { name: string } }> = [];
  const received: Array<{ method?: string; event?: string }> = [];
  let pending: (() => void) | undefined;
  const upstream = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    let value: unknown = {};
    if (req.url === "/api/login") { value = { id: "owner", token: "secret" }; sessions.push({ id: "owner", profile: { name: "test:owner" } }); }
    else if (req.url === "/api/room/settings") { if (body) implicit = JSON.parse(body).implicit_hosting; value = { implicit_hosting: implicit }; }
    else if (req.url === "/api/sessions") value = sessions;
    else if (req.url?.startsWith("/api/sessions/") && req.method === "DELETE") { const index = sessions.findIndex((s) => s.id === req.url!.split("/").at(-1)); if (index >= 0) sessions.splice(index, 1); }
    else if (req.url === "/json/version") value = { webSocketDebuggerUrl: `ws://127.0.0.1:${(upstream.address() as { port: number }).port}/devtools/browser/test` };
    res.setHeader("content-type", "application/json"); res.end(JSON.stringify(value));
  });
  const ws = new WebSocketServer({ server: upstream });
  ws.on("connection", (socket, request) => {
    if (request.url!.startsWith("/ws")) {
      sessions.push({ id: String(sessions.length), profile: { name: new URL(request.url!, "http://fixture").searchParams.get("username")! } });
      socket.send(JSON.stringify({ event: "system/init" }));
    }
    socket.on("message", (raw) => {
      const frame = JSON.parse(raw.toString()); received.push(frame);
      if (frame.method === "Runtime.evaluate") pending = () => socket.send(JSON.stringify({ id: frame.id, sessionId: frame.sessionId, result: {} }));
      else if (frame.id !== undefined) socket.send(JSON.stringify({ id: frame.id, result: {} }));
      else socket.send(JSON.stringify({ event: "ack", original: frame.event }));
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
  const gate = new BrowserGate(origin, origin, "test");
  const clients: WebSocket[] = [];
  const open = async (url: string, init = false) => {
    const client = new WebSocket(url); clients.push(client);
    const ready = once(client, init ? "message" : "open"); await ready; return client;
  };
  try {
    await gate.start(); assert.equal(implicit, false); gate.resume();
    const version = await (await fetch(gate.cdpUrl + "/json/version")).json() as { webSocketDebuggerUrl: string };
    const reboundStatus = await new Promise<number | undefined>((resolve, reject) => {
      get(gate.cdpUrl + "/json/version", { headers: { host: "rebind.example" } }, (response) => { response.resume(); resolve(response.statusCode); }).on("error", reject);
    });
    assert.equal(reboundStatus, 403);
    const foreign = new WebSocket(version.webSocketDebuggerUrl, { origin: "http://localhost:3000" });
    foreign.on("error", () => undefined);
    const [, response] = await once(foreign, "unexpected-response");
    assert.equal(response.statusCode, 403);
    foreign.terminate();
    const client = await open(version.webSocketDebuggerUrl);
    client.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", sessionId: "page" }));
    while (!pending) await new Promise((r) => setTimeout(r, 5));
    const draining = gate.drain(1000);
    const rejected = once(client, "message"); client.send(JSON.stringify({ id: 2, method: "Input.dispatchKeyEvent" }));
    assert.match(String((await rejected)[0]), /held/);
    assert.equal(received.some((f) => f.method === "Input.dispatchKeyEvent"), false);
    assert.equal((await fetch(gate.cdpUrl + "/json/version")).status, 423);
    const denied = new WebSocket(version.webSocketDebuggerUrl); denied.on("error", () => undefined);
    await once(denied, "unexpected-response"); denied.terminate();
    pending!(); await draining;
    const observer = await open(gate.observationUrl.replace("http:", "ws:").replace("?readOnly=1", "ws"), true);
    observer.send(JSON.stringify({ event: "admin/control" }));
    const ack = once(observer, "message"); observer.send(JSON.stringify({ event: "client/heartbeat" })); await ack;
    assert.equal(received.some((f) => f.event === "admin/control"), false);
    const grant = await gate.grantHuman();
    const human = await open(grant.replace("http:", "ws:") + "ws", true);
    const host = once(human, "message"); human.send(JSON.stringify({ event: "admin/control" })); await host;
    assert.equal(received.some((f) => f.event === "admin/control"), true);
    human.send(JSON.stringify({ event: "control/keyboard", layout: "us" }));
    const keyboardFence = once(human, "message"); human.send(JSON.stringify({ event: "client/heartbeat" })); await keyboardFence;
    assert.equal(received.some((f) => f.event === "control/keyboard"), false);
    await gate.revokeHuman();
    assert.equal(sessions.length, 1); assert.equal((await fetch(grant)).status, 403);
    gate.resume(); assert.equal((await fetch(gate.cdpUrl + "/json/version")).status, 200);
    const slow = await open(version.webSocketDebuggerUrl); pending = undefined;
    slow.send(JSON.stringify({ id: 3, method: "Runtime.evaluate" }));
    while (!pending) await new Promise((r) => setTimeout(r, 5));
    await assert.rejects(gate.drain(20), /deadline/);
    slow.terminate(); await new Promise((r) => setTimeout(r, 10));
    await assert.rejects(gate.drain(20), /quiescence is unknown/);
    assert.throws(() => gate.resume(), /unknown/);
  } finally {
    for (const client of clients) client.terminate();
    await gate.close(); for (const client of ws.clients) client.terminate(); ws.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});
