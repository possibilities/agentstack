import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WebSocketServer } from "ws";
import { VoiceCalls } from "../src/voice.js";
import type { ServerView } from "../src/supervisor.js";
import { DEFAULT_BOT_SETTINGS } from "../src/store.js";
import { voiceSpeak } from "../api.js";

const server = (url: string, threadId: string | null = "main"): ServerView => ({
  id: "bot-1", pid: 123, cwd: "/tmp/bot-1", url, state: "running", account: "account",
  runningAccount: "account", mainThreadId: threadId, recoveryIssue: null, roleRevision: 1,
  settings: DEFAULT_BOT_SETTINGS,
});

test("voice dials only an adopted main thread, relays SDP, and stops without touching turns", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentstack-voice-"));
  const path = join(dir, "codex.sock");
  const http = createServer();
  const wss = new WebSocketServer({ server: http });
  const methods: string[] = [];
  const spoken: string[] = [];
  let emitAnswer = () => {};
  let holdStopAck = false;
  let ackStop = () => {};
  wss.on("connection", (peer) => {
    let experimentalApi = false;
    peer.on("message", (raw) => {
      const frame = JSON.parse(String(raw)) as { id?: number; method?: string; params?: Record<string, unknown> };
      if (!frame.id || !frame.method) return;
      methods.push(frame.method);
      if (frame.method === "initialize") {
        assert.deepEqual(frame.params?.capabilities, { experimentalApi: true, requestAttestation: false });
        experimentalApi = (frame.params.capabilities as { experimentalApi?: boolean }).experimentalApi === true;
      }
      if (frame.method === "thread/realtime/start") {
        if (!experimentalApi) {
          peer.send(JSON.stringify({ id: frame.id, error: { message: "thread/realtime/start requires experimentalApi capability" } }));
          return;
        }
        assert.deepEqual(frame.params, {
          threadId: "main", realtimeSessionId: frame.params?.realtimeSessionId,
          version: "v3", outputModality: "audio", transport: { type: "webrtc", sdp: "offer" },
        });
        peer.send(JSON.stringify({ id: frame.id, result: {} }));
        emitAnswer = () => {
          peer.send(JSON.stringify({ method: "thread/realtime/started", params: { threadId: "main", realtimeSessionId: frame.params?.realtimeSessionId, version: "v3" } }));
          peer.send(JSON.stringify({ method: "thread/realtime/sdp", params: { threadId: "main", sdp: "answer" } }));
        };
      } else if (frame.method === "thread/realtime/appendSpeech") {
        assert.equal(frame.params?.threadId, "main");
        spoken.push(frame.params?.text as string);
        if (frame.params?.text === "Native refusal") peer.send(JSON.stringify({ id: frame.id, error: { message: "speech refused" } }));
        else peer.send(JSON.stringify({ id: frame.id, result: {} }));
      } else {
        if (frame.method === "thread/realtime/stop") {
          peer.send(JSON.stringify({ method: "thread/realtime/closed", params: { threadId: "main", reason: "requested" } }));
          if (holdStopAck) { ackStop = () => peer.send(JSON.stringify({ id: frame.id, result: {} })); return; }
        }
        peer.send(JSON.stringify({ id: frame.id, result: {} }));
      }
    });
  });
  await new Promise<void>((resolve) => http.listen(path, resolve));
  try {
    const voice = new VoiceCalls(() => [server(`unix://${path}`)]);
    let changes = 0;
    voice.onChange = () => { changes++; };
    const id = "11111111-1111-4111-8111-111111111111";
    await assert.rejects(voice.speak(id, "Before dialing"), /active call/);
    const dialing = voice.dial("bot-1", id, "offer");
    assert.equal(voice.status()?.phase, "dialing");
    await assert.rejects(voice.speak(id, "Too early"), /not connected/);
    await assert.rejects(voice.dial("bot-1", crypto.randomUUID(), "offer"), /already in progress/);
    await assert.rejects(voice.hangup(crypto.randomUUID()), /does not match/);
    await until(() => methods.includes("thread/realtime/start"));
    emitAnswer();
    assert.deepEqual(await dialing, { sessionId: id, answer: "answer" });
    assert.deepEqual(voice.status(), { sessionId: id, botId: "bot-1", threadId: "main", phase: "connected" });
    assert.equal(changes, 2);
    await assert.rejects(voice.speak(crypto.randomUUID(), "Stale announcement"), /active call/);
    await assert.rejects(voice.speak(id, "Wrong bot", "bot-2"), /another Bot/);
    assert.deepEqual(await voice.speak(id, "A short announcement", "bot-1"), { sessionId: id, status: "submitted" });
    await assert.rejects(voice.speak(id, "Native refusal"), /speech refused/);
    assert.deepEqual(spoken, ["A short announcement", "Native refusal"]);
    assert.equal(voice.status()?.phase, "connected");
    holdStopAck = true;
    const hangingUp = voice.hangup(id);
    await until(() => methods.includes("thread/realtime/stop"));
    await assert.rejects(voice.speak(id, "During hangup"), /not connected/);
    ackStop();
    assert.deepEqual(await hangingUp, null);
    holdStopAck = false;
    assert.equal(voice.status(), null);
    await assert.rejects(voice.speak(id, "Too late"), /active call/);
    assert.deepEqual(await voice.hangup(id), null);
    assert.deepEqual(methods, ["initialize", "thread/realtime/start", "thread/realtime/appendSpeech", "thread/realtime/appendSpeech", "thread/realtime/stop"]);

    const nextId = crypto.randomUUID();
    const pending = voice.dial("bot-1", nextId, "offer");
    await until(() => methods.filter((method) => method === "thread/realtime/start").length === 2);
    assert.equal(voice.status()?.phase, "dialing");
    await assert.rejects(voice.speak(id, "Previous call"), /active call/);
    await voice.hangup(nextId);
    await assert.rejects(pending, /Voice call ended/);
    assert.equal(voice.status(), null);
    assert.deepEqual(methods.slice(-3), ["initialize", "thread/realtime/start", "thread/realtime/stop"]);
  } finally {
    for (const peer of wss.clients) peer.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve) => http.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

test("speech input requires an exact call ID and bounded non-blank text", () => {
  const id = crypto.randomUUID();
  assert.equal(voiceSpeak.input.safeParse({ sessionId: id, text: "Status update" }).success, true);
  for (const text of ["", " \n ", "x".repeat(4_001)]) {
    assert.equal(voiceSpeak.input.safeParse({ sessionId: id, text }).success, false);
  }
  assert.equal(voiceSpeak.input.safeParse({ sessionId: "not-a-uuid", text: "Status update" }).success, false);
});

test("voice refuses bots without a verified, durable main thread", async () => {
  const voice = new VoiceCalls(() => [server("ws://127.0.0.1:1", null)]);
  await assert.rejects(voice.dial("bot-1", crypto.randomUUID(), "offer"), /durable main thread/);
  assert.equal(voice.status(), null);
});

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(check());
}
