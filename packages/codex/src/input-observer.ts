import { attachInputMiddleware, type InputCandidate, type InputMiddlewareConnection, type InputResolution } from "./middleware.js";
import type { ServerView } from "./supervisor.js";

const MAX_ENTRIES = 200;

export type InputObservation = {
  serverId: string;
  threadId: string;
  inputId: string;
  origin: InputCandidate["origin"];
  originalText: string;
  selectedText: string | null;
  observedAt: string;
  disposition: "pending" | "passed" | "replaced" | "intercepted" | "rejected" | "unresolved";
  operationId: string | null;
  effect: InputResolution["effect"];
};

export type InputObservationTarget = { serverId: string; threadId: string };
export type InputObservationIssue = InputObservationTarget & { message: string; at: string };

export class InputObserver {
  private readonly connections = new Map<string, InputMiddlewareConnection>();
  private readonly connecting = new Map<string, Promise<void>>();
  private readonly targets = new Map<string, InputObservationTarget>();
  private readonly entries: InputObservation[] = [];
  private readonly issues: InputObservationIssue[] = [];
  private publish: ((serverId: string) => void) | undefined;

  setPublisher(publish: ((serverId: string) => void) | undefined): void {
    this.publish = publish;
  }

  snapshot(): { targets: InputObservationTarget[]; entries: InputObservation[]; issues: InputObservationIssue[] } {
    return {
      targets: [...this.targets.values()], entries: this.entries.map((entry) => ({ ...entry })),
      issues: this.issues.map((issue) => ({ ...issue })),
    };
  }

  async start(server: ServerView, threadId: string): Promise<void> {
    if (server.state !== "running" || !server.url) throw new Error(`Codex server ${server.id} is not running`);
    const key = this.key(server.id, threadId);
    if (this.connections.has(key)) return;
    if (this.connecting.has(key)) return this.connecting.get(key);
    const connecting = (async () => {
      const connection = await attachInputMiddleware(
        server.url!, threadId,
        (candidate) => { this.noteCandidate(server.id, candidate); return { type: "pass" }; },
        (resolution) => this.noteResolution(server.id, resolution),
        { onUnavailable: "pass", timeoutMs: 500 },
      );
      this.connections.set(key, connection);
      this.targets.set(key, { serverId: server.id, threadId });
      this.endpoints.set(key, server.url!);
      for (let index = this.issues.length - 1; index >= 0; index--) {
        if (this.issues[index]?.serverId === server.id && this.issues[index]?.threadId === threadId) this.issues.splice(index, 1);
      }
      this.publish?.(server.id);
    })();
    this.connecting.set(key, connecting);
    try { await connecting; }
    catch (error) {
      this.issues.unshift({ serverId: server.id, threadId, at: new Date().toISOString(),
        message: String(error instanceof Error ? error.message : error).slice(0, 256) });
      if (this.issues.length > 20) this.issues.length = 20;
      this.publish?.(server.id);
      throw error;
    } finally { this.connecting.delete(key); }
  }

  async stop(serverId: string, threadId: string, graceful = true): Promise<void> {
    const key = this.key(serverId, threadId);
    const connection = this.connections.get(key);
    let detachError: unknown;
    if (graceful) {
      try { await connection?.detach(); }
      catch (error) {
        detachError = error;
        this.issues.unshift({ serverId, threadId, at: new Date().toISOString(),
          message: `Could not detach middleware: ${String(error instanceof Error ? error.message : error).slice(0, 180)}` });
        if (this.issues.length > 20) this.issues.length = 20;
      } finally { connection?.close(); }
    } else {
      connection?.close();
    }
    this.connections.delete(key);
    this.endpoints.delete(key);
    if (this.targets.delete(key)) this.publish?.(serverId);
    for (const entry of this.entries) {
      if (entry.serverId === serverId && entry.threadId === threadId && entry.disposition === "pending") {
        entry.disposition = "unresolved";
      }
    }
    if (detachError) throw detachError;
  }

  reconcile(servers: ServerView[]): void {
    const live = new Map(servers.filter((server) => server.state === "running").map((server) => [server.id, server.url]));
    for (const [key, target] of this.targets) {
      if (live.get(target.serverId) !== this.endpointFor(key)) void this.stop(target.serverId, target.threadId, false);
    }
  }

  close(): void {
    for (const target of [...this.targets.values()]) void this.stop(target.serverId, target.threadId, false);
  }

  private readonly endpoints = new Map<string, string>();

  private endpointFor(key: string): string | undefined {
    return this.endpoints.get(key);
  }

  private key(serverId: string, threadId: string): string {
    return JSON.stringify([serverId, threadId]);
  }

  private noteCandidate(serverId: string, candidate: InputCandidate): void {
    const entry: InputObservation = {
      serverId, threadId: candidate.threadId, inputId: candidate.inputId,
      origin: candidate.origin, originalText: candidate.text, selectedText: null,
      observedAt: new Date().toISOString(), disposition: "pending", operationId: null, effect: null,
    };
    this.entries.unshift(entry);
    if (this.entries.length > MAX_ENTRIES) this.entries.length = MAX_ENTRIES;
    this.publish?.(serverId);
  }

  private noteResolution(serverId: string, resolution: InputResolution): void {
    const entry = this.entries.find((item) =>
      item.serverId === serverId && item.threadId === resolution.threadId && item.inputId === resolution.inputId);
    if (!entry) return;
    entry.disposition = resolution.disposition.type;
    entry.operationId = resolution.disposition.type === "intercepted" ? resolution.disposition.operationId : null;
    entry.effect = resolution.effect;
    this.publish?.(serverId);
    const connection = this.connections.get(this.key(serverId, resolution.threadId));
    void connection?.read(resolution.inputId).then((record) => {
      if (!record) return;
      entry.selectedText = record.selectedText;
      entry.effect = record.effect;
      this.publish?.(serverId);
    }).catch(() => undefined);
  }
}
