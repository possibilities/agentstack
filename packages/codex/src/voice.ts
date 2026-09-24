import WebSocket, { type RawData } from "ws";
import { appServerSocket } from "./threads.js";
import type { ServerView } from "./supervisor.js";

const START_TIMEOUT_MS = 60_000;
const REQUEST_TIMEOUT_MS = 15_000;

export type VoiceCall = {
  sessionId: string;
  serverId: string;
  threadId: string;
  phase: "dialing" | "connected";
};

type Pending = { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };
type ActiveCall = VoiceCall & {
  connection: WebSocket | null;
  startSent: boolean;
  ending: boolean;
  stop: (() => Promise<unknown>) | null;
  finish: (error: Error, answer?: string) => void;
};

/** A single call across all managed Servers. Codex owns the media; this connection only signals SDP. */
export class VoiceCalls {
  private current: ActiveCall | null = null;
  onChange?: () => void;

  constructor(private readonly servers: () => ServerView[], private readonly connect = appServerSocket) {}

  status(): VoiceCall | null {
    const call = this.current;
    return call ? { sessionId: call.sessionId, serverId: call.serverId, threadId: call.threadId, phase: call.phase } : null;
  }

  async dial(serverId: string, sessionId: string, sdp: string): Promise<{ sessionId: string; answer: string }> {
    if (this.current) throw new Error(`voice call already in progress on ${this.current.serverId}`);
    const server = this.servers().find((item) => item.id === serverId);
    if (!server || server.state !== "running" || !server.url || server.recoveryIssue || !server.mainThreadId || !server.runningAccount) {
      throw new Error(`Server ${serverId} needs a verified running account and a durable main thread before a voice call`);
    }

    let resolveAnswer!: (answer: string) => void;
    let rejectAnswer!: (error: Error) => void;
    const answer = new Promise<string>((resolve, reject) => { resolveAnswer = resolve; rejectAnswer = reject; });
    // Reserve synchronously, before any socket or native request can race a second dial.
    const call: ActiveCall = {
      sessionId, serverId, threadId: server.mainThreadId, phase: "dialing",
      connection: null, startSent: false, ending: false, stop: null,
      finish: (error: Error, value?: string) => value === undefined ? rejectAnswer(error) : resolveAnswer(value),
    };
    this.current = call;
    this.onChange?.();
    let ws: WebSocket;
    try { ws = this.connect(server.url); }
    catch (error) { this.release(call); throw error; }
    call.connection = ws;
    const pending = new Map<number, Pending>();
    let sequence = 0;
    let started = false;
    let remoteSdp: string | null = null;
    let failing = false;
    const release = (error: Error) => {
      for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); }
      pending.clear();
      call.finish(error);
      this.release(call);
    };
    const request = (method: string, params: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<unknown> => new Promise((resolve, reject) => {
      if (ws.readyState !== WebSocket.OPEN) { reject(new Error("Codex connection closed")); return; }
      const id = ++sequence;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ id, method, params }));
    });
    const fail = async (error: Error) => {
      if (this.current !== call || failing || call.ending) return;
      failing = true;
      if (call.startSent && ws.readyState === WebSocket.OPEN) {
        call.ending = true;
        try { await request("thread/realtime/stop", { threadId: call.threadId }, 5_000); }
        catch { /* The connection or native stop may be unavailable. */ }
      }
      release(error);
    };
    ws.on("message", (raw: RawData) => {
      let frame: { id?: unknown; result?: unknown; error?: { message?: string }; method?: unknown; params?: Record<string, unknown> };
      try { frame = JSON.parse(String(raw)) as typeof frame; } catch { return; }
      if (typeof frame.id === "number") {
        const item = pending.get(frame.id);
        if (!item) return;
        pending.delete(frame.id);
        clearTimeout(item.timer);
        if (frame.error) item.reject(new Error(`${frame.error.message ?? "Codex request failed"}`));
        else item.resolve(frame.result);
        return;
      }
      if (this.current !== call || frame.params?.threadId !== call.threadId) return;
      if (frame.method === "thread/realtime/started" && frame.params.realtimeSessionId === sessionId) started = true;
      if (frame.method === "thread/realtime/sdp" && started && typeof frame.params.sdp === "string") remoteSdp = frame.params.sdp;
      if (started && remoteSdp && !call.ending) {
        call.phase = "connected";
        call.finish(new Error("unused"), remoteSdp);
        remoteSdp = null;
        this.onChange?.();
      }
      if (frame.method === "thread/realtime/closed" || frame.method === "thread/realtime/error") {
        if (call.ending) return; // Stop may emit closed before its RPC acknowledgement.
        release(new Error(typeof frame.params?.message === "string" ? frame.params.message : "Voice call ended"));
      }
    });
    ws.on("error", (error) => release(error));
    ws.on("close", () => release(new Error("Codex connection closed")));
    const ready = new Promise<void>((resolve, reject) => {
      if (ws.readyState === WebSocket.OPEN) { resolve(); return; }
      const timer = setTimeout(() => reject(new Error("Codex connection timed out")), 5_000);
      ws.once("open", () => { clearTimeout(timer); resolve(); });
      ws.once("error", (error) => { clearTimeout(timer); reject(error); });
    });
    const setup = (async () => {
      await ready;
      if (this.current !== call) return;
      await request("initialize", { clientInfo: { name: "agentstack-voice", version: "0.0.0" } });
      if (this.current !== call) return;
      ws.send(JSON.stringify({ method: "initialized" }));
      // WebRTC v3 is the compatible native audio path; leave Codex's prompt,
      // model, voice, handoff policy and thread settings to their own defaults.
      call.stop = () => request("thread/realtime/stop", { threadId: call.threadId }, 5_000);
      call.startSent = true;
      await request("thread/realtime/start", {
        threadId: call.threadId, realtimeSessionId: sessionId,
        version: "v3", outputModality: "audio", transport: { type: "webrtc", sdp },
      }, START_TIMEOUT_MS);
    })();
    void setup.catch((error) => void fail(error instanceof Error ? error : new Error(String(error))));
    const timer = setTimeout(() => void fail(new Error("Voice negotiation timed out")), START_TIMEOUT_MS);
    try { return { sessionId, answer: await answer }; }
    finally { clearTimeout(timer); }
  }

  async hangup(sessionId: string): Promise<VoiceCall | null> {
    const call = this.current;
    if (!call) return null;
    if (call.sessionId !== sessionId) throw new Error("Voice session ID does not match the active call");
    // Requests on this native connection are ordered: stop follows start even
    // when the SDP answer has not arrived. A refusal leaves the call inspectable.
    call.ending = true;
    try { if (call.startSent) await call.stop?.(); }
    catch (error) { call.ending = false; throw error; }
    call.finish(new Error("Voice call ended"));
    this.release(call);
    return null;
  }

  async close(): Promise<void> {
    const id = this.current?.sessionId;
    if (id) await this.hangup(id);
  }

  private release(call: ActiveCall): void {
    if (!call || this.current !== call) return;
    this.current = null;
    call.connection?.close();
    this.onChange?.();
  }
}
