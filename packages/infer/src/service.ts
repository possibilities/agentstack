import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { discoverModels } from "./catalog.js";
import type { CompleteInput, CompleteOutput, Model, ModelObservation, RequestRecord, StartInput } from "./schema.js";
import type { InferTraces } from "./traces.js";

type Credentials = { access: string; nativeId: string; auth: string };
type Discover = (stateDir: string, auth: string, signal?: AbortSignal) => Promise<Model[]>;
const object = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const count = (value: unknown): number | null => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;

/** Secrets remain in the private auth store; neither metadata nor failure messages include them. */
export async function readCredentials(stateDir: string, accountId: string): Promise<Credentials> {
  const config = join(stateDir, "configuration.sqlite"), secrets = join(stateDir, "secrets.sqlite");
  for (const path of [config, secrets]) {
    let handle;
    try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch { throw new Error("credentials_unavailable"); }
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || stat.mode & 0o077 || stat.size > 32 * 1024 * 1024)
        throw new Error("credentials_unavailable");
    } finally { await handle.close(); }
  }
  try {
    const db = new DatabaseSync(config, { readOnly: true });
    try {
      db.prepare("ATTACH DATABASE ? AS secrets").run(secrets);
      const row = db.prepare("SELECT auth_json FROM accounts JOIN secrets.credentials ON accounts.name = secrets.credentials.name WHERE accounts.name = ? AND accounts.enabled = 1 AND accounts.removing = 0").get(accountId) as { auth_json: string } | undefined;
      if (!row) throw new Error("account_unavailable");
      const auth = object(JSON.parse(row.auth_json)), tokens = object(auth?.tokens);
      const access = tokens?.access_token, nativeId = tokens?.account_id;
      if (auth?.auth_mode !== "chatgpt" || typeof access !== "string" || !access || typeof nativeId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(nativeId))
        throw new Error("credentials_unavailable");
      return { access, nativeId, auth: row.auth_json };
    } finally { db.close(); }
  } catch (error) {
    if (error instanceof Error && ["account_unavailable", "credentials_unavailable"].includes(error.message)) throw error;
    throw new Error("credentials_unavailable");
  }
}

/** Parse only successful terminal SSE; partial deltas never constitute a completed answer. */
export async function readCompletion(response: Response, requestId: string, model: string, observe?: (kind: string, data: unknown) => void): Promise<CompleteOutput> {
  if (!response.body) throw new Error(`infer_outcome_unknown:${requestId}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "", text = "", bytes = 0, completed: Record<string, unknown> | null = null, failed = false;
  const consume = (line: string) => {
    if (!line.startsWith("data: ")) return;
    const raw = line.slice(6);
    if (raw === "[DONE]") return;
    const event = object(JSON.parse(raw));
    if (!event) throw new Error("invalid");
    if (event.type === "response.output_text.delta") {
      if (typeof event.delta !== "string") throw new Error("invalid");
      text += event.delta;
      observe?.("output_text.delta", { delta: event.delta });
      if (text.length > 128_000) throw new Error("invalid");
    } else if (event.type === "response.completed") {
      completed = object(event.response);
      if (!completed || completed.status !== "completed") throw new Error("invalid");
      observe?.("response.completed", { id: completed.id ?? null, model: completed.model ?? null, status: completed.status, usage: completed.usage ?? null });
    } else if (event.type === "response.failed" || event.type === "error" || event.type === "response.incomplete") {
      failed = true; observe?.("response.failure", { type: event.type, code: object(event.error)?.code ?? null,
        status: object(event.response)?.status ?? null, incompleteDetails: object(event.response)?.incomplete_details ?? null });
    }
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 2_000_000) throw new Error("invalid");
      buffer += decoder.decode(value, { stream: true });
      if (buffer.length > 512_000) throw new Error("invalid");
      let at = buffer.indexOf("\n");
      while (at !== -1) {
        consume(buffer.slice(0, at).replace(/\r$/, ""));
        buffer = buffer.slice(at + 1);
        at = buffer.indexOf("\n");
      }
    }
    buffer += decoder.decode();
    if (buffer) consume(buffer.replace(/\r$/, ""));
    if (failed || !completed) throw new Error("incomplete");
    const usage = object((completed as Record<string, unknown>).usage), details = object(usage?.output_tokens_details);
    const reportedModel = (completed as Record<string, unknown>).model;
    return { requestId, model, reportedModel: typeof reportedModel === "string" ? reportedModel : null, text, usage: {
      inputTokens: count(usage?.input_tokens), outputTokens: count(usage?.output_tokens),
      totalTokens: count(usage?.total_tokens), reasoningTokens: count(details?.reasoning_tokens),
    } };
  } catch { await reader.cancel().catch(() => {}); throw new Error(`infer_outcome_unknown:${requestId}`); }
  finally { reader.releaseLock(); }
}

/**
 * Runs inference requests into the durable ledger (`traces`). `complete` waits
 * for the outcome; `start` admits the same kind of request and returns while it
 * runs. Model discovery is cached per account in memory, refreshed on demand or
 * by a request's own fresh discovery. `onChange` fires for every request or
 * observation change.
 */
export class InferService {
  onChange?: () => void;
  private readonly inFlight = new Set<string>();
  private readonly running = new Map<string, { controller: AbortController; task: Promise<unknown> }>();
  private readonly observations = new Map<string, ModelObservation>();
  private readonly discoveries = new Map<string, { controller: AbortController; task: Promise<void> }>();
  private readonly catalogTasks = new Set<{ accountId: string; controller: AbortController }>();
  private catalogGeneration = 0;
  private readonly accountGenerations = new Map<string, number>();
  private closing = false;
  constructor(readonly stateDir: string, private readonly discover: Discover = (dir, auth, signal) => discoverModels(dir, auth, undefined, signal),
    private readonly fetcher: typeof fetch = fetch, private readonly credentials: typeof readCredentials = readCredentials,
    readonly traces?: InferTraces) {}

  /** Discovers now and waits; also refreshes the cached observation. */
  async models(accountId: string): Promise<{ models: Model[]; observedAt: string }> {
    const generation = this.catalogEpoch(accountId);
    const { auth } = await this.credentials(this.stateDir, accountId);
    try {
      const observed = { models: await this.discoverCatalog(accountId, auth, generation), observedAt: new Date().toISOString() };
      if (generation !== this.catalogEpoch(accountId)) throw new Error("cancelled");
      this.observe(accountId, { ...observed, error: null });
      return observed;
    } catch {
      if (generation === this.catalogEpoch(accountId)) this.observe(accountId, { error: "catalog_unavailable" });
      throw new Error("catalog_unavailable");
    }
  }

  modelList(accountId?: string): ModelObservation[] {
    return [...this.observations.values()].filter((row) => !accountId || row.accountId === accountId);
  }

  /** Derived observations only: abort and fence discovery, never dispatch a refresh or cancel admitted inference. */
  clearCatalog(accountIds?: string[]): { cleared: string[] } {
    const ids = [...new Set(accountIds ?? [...this.observations.keys(), ...this.discoveries.keys(), ...[...this.catalogTasks].map(task => task.accountId)])].sort();
    if (accountIds === undefined) { this.catalogGeneration++; this.accountGenerations.clear(); }
    else for (const id of ids) this.accountGenerations.set(id, (this.accountGenerations.get(id) ?? 0) + 1);
    for (const id of ids) { this.observations.delete(id); this.discoveries.get(id)?.controller.abort(); this.discoveries.delete(id); }
    for (const task of this.catalogTasks) if (accountIds === undefined || ids.includes(task.accountId)) task.controller.abort();
    this.changed();
    return { cleared: ids };
  }

  private catalogEpoch(accountId: string): string { return `${this.catalogGeneration}:${this.accountGenerations.get(accountId) ?? 0}`; }
  private async discoverCatalog(accountId: string, auth: string, generation: string, signal?: AbortSignal): Promise<Model[]> {
    if (this.closing || generation !== this.catalogEpoch(accountId)) throw new Error("cancelled");
    const task = { accountId, controller: new AbortController() };
    this.catalogTasks.add(task);
    try {
      const models = await this.discover(this.stateDir, auth, signal ? AbortSignal.any([signal, task.controller.signal]) : task.controller.signal);
      if (task.controller.signal.aborted || generation !== this.catalogEpoch(accountId)) throw new Error("cancelled");
      return models;
    } finally { this.catalogTasks.delete(task); }
  }

  /** Starts a background discovery, coalescing with one already running. An unusable account is refused and forgotten. */
  async refreshModels(accountId: string): Promise<ModelObservation> {
    if (this.closing) throw new Error("infer_closing");
    const generation = this.catalogEpoch(accountId);
    let auth: string;
    try { ({ auth } = await this.credentials(this.stateDir, accountId)); }
    catch (error) {
      if (generation === this.catalogEpoch(accountId) && this.observations.delete(accountId)) this.changed();
      throw error;
    }
    if (this.closing) throw new Error("infer_closing");
    if (generation !== this.catalogEpoch(accountId)) throw new Error("cancelled");
    if (!this.discoveries.has(accountId)) {
      const controller = new AbortController();
      this.observe(accountId, { discovering: true });
      const task = this.discoverCatalog(accountId, auth, generation, controller.signal)
        .then((models) => { if (generation === this.catalogEpoch(accountId)) this.observe(accountId, { models, observedAt: new Date().toISOString(), discovering: false, error: null }); },
          () => { if (generation === this.catalogEpoch(accountId)) this.observe(accountId, { discovering: false, error: "catalog_unavailable" }); })
        .finally(() => { if (this.discoveries.get(accountId)?.controller === controller) this.discoveries.delete(accountId); });
      this.discoveries.set(accountId, { controller, task });
    }
    return this.observations.get(accountId)!;
  }

  async complete(input: CompleteInput): Promise<CompleteOutput> {
    if (this.closing) throw new Error("infer_closing");
    // One request per account at a time; callers must not flood shared Codex allowance.
    if (this.inFlight.has(input.accountId) || this.inFlight.size >= 2) throw new Error("infer_busy");
    this.inFlight.add(input.accountId);
    const requestId = input.requestId ?? randomUUID();
    try {
      const previous = this.traces?.reserve(requestId, input);
      if (previous) return previous;
      this.changed();
      return await this.dispatch(input, requestId);
    }
    finally { this.inFlight.delete(input.accountId); }
  }

  /**
   * Admits one request into the ledger and returns its running record before any
   * backend work. An identical resend returns the recorded run; it never dispatches twice.
   */
  async start(input: StartInput): Promise<RequestRecord> {
    const traces = this.ledger();
    const existing = traces.find(input.requestId, input);
    if (existing) return existing;
    if (this.closing) throw new Error("infer_closing");
    if (this.inFlight.has(input.accountId) || this.inFlight.size >= 2) throw new Error("infer_busy");
    this.inFlight.add(input.accountId);
    traces.reserve(input.requestId, input);
    this.changed();
    void this.dispatch(input, input.requestId).catch(() => {}).finally(() => this.inFlight.delete(input.accountId));
    return traces.get(input.requestId)!;
  }

  list(limit: number, before?: number) { return this.ledger().list(limit, before); }

  get(requestId: string): RequestRecord {
    const record = this.ledger().get(requestId);
    if (!record) throw new Error("unknown_request");
    return record;
  }

  /** Refuses new work and cancels in-flight discovery and requests; one cancelled after it may have been sent is unknown. */
  prepareClose(): void {
    this.closing = true;
    for (const { controller } of [...this.running.values(), ...this.discoveries.values()]) controller.abort();
    for (const { controller } of this.catalogTasks) controller.abort();
  }

  async close(): Promise<void> {
    this.prepareClose();
    await Promise.allSettled([...this.running.values(), ...this.discoveries.values()].map(({ task }) => task));
    this.traces?.close();
  }

  private ledger(): InferTraces {
    if (!this.traces) throw new Error("ledger_unavailable");
    return this.traces;
  }

  /** Runs one reserved request to its single recorded outcome. */
  private dispatch(input: CompleteInput, requestId: string): Promise<CompleteOutput> {
    const controller = new AbortController();
    const task = this.completeOnce(input, requestId, controller.signal).then((result) => {
      this.traces?.finish(requestId, result, null);
      return result;
    }, (error: unknown) => {
      this.traces?.finish(requestId, null, error instanceof Error ? error.message : "infer_error");
      throw error;
    }).finally(() => {
      this.running.delete(requestId);
      this.changed();
    });
    this.running.set(requestId, { controller, task });
    return task;
  }

  private observe(accountId: string, patch: Partial<Omit<ModelObservation, "accountId">>): void {
    const current = this.observations.get(accountId) ?? { accountId, models: null, observedAt: null, discovering: false, error: null };
    this.observations.set(accountId, { ...current, ...patch });
    this.changed();
  }

  private changed(): void { this.onChange?.(); }

  private async completeOnce(input: CompleteInput, requestId: string, signal: AbortSignal): Promise<CompleteOutput> {
    const generation = this.catalogEpoch(input.accountId);
    const credentials = await this.credentials(this.stateDir, input.accountId);
    let models: Model[];
    try { models = await this.discoverCatalog(input.accountId, credentials.auth, generation, signal); }
    catch { throw new Error(signal.aborted ? "cancelled" : "catalog_unavailable"); }
    if (generation === this.catalogEpoch(input.accountId)) this.observe(input.accountId, { models, observedAt: new Date().toISOString(), error: null });
    if (!models.some((row) => row.id === input.model && row.supportedEfforts.includes(input.effort))) throw new Error("model_unavailable");
    if (signal.aborted) throw new Error("cancelled");
    this.traces?.event(requestId, "catalog", { models });
    const body = { model: input.model, instructions: input.instructions,
      input: [{ role: "user", content: [{ type: "input_text", text: input.input }] }],
      reasoning: { effort: input.effort }, stream: true, store: false };
    this.traces?.event(requestId, "dispatch", { url: "https://chatgpt.com/backend-api/codex/responses", body });
    let response: Response;
    try {
      response = await this.fetcher("https://chatgpt.com/backend-api/codex/responses", {
        method: "POST", redirect: "manual", signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
        headers: { Authorization: `Bearer ${credentials.access}`, "chatgpt-account-id": credentials.nativeId,
          "Content-Type": "application/json", Accept: "text/event-stream", originator: "codex_cli_rs", session_id: requestId },
        body: JSON.stringify(body),
      });
    } catch { throw new Error(`infer_outcome_unknown:${requestId}`); }
    this.traces?.event(requestId, "http", { status: response.status, requestId: response.headers.get("x-request-id"), contentType: response.headers.get("content-type") });
    if (!response.ok) {
      const reader=response.body?.getReader();let diagnostic="",truncated=false;
      if(reader)try{
        const decoder=new TextDecoder();
        while(true){const part=await reader.read();if(part.done)break;diagnostic+=decoder.decode(part.value,{stream:true});if(diagnostic.length>16_000){truncated=true;diagnostic=diagnostic.slice(0,16_000);break;}}
      }catch{diagnostic="response body unavailable";}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
      diagnostic=diagnostic.replaceAll(credentials.access,"[credential]").replaceAll(credentials.auth,"[credential]");
      this.traces?.event(requestId,"http_error",{status:response.status,diagnostic,truncated});
      if (response.status === 401) throw new Error("codex_sign_in_required");
      if (response.status === 403) throw new Error("codex_access_denied");
      if (response.status === 429) throw new Error("codex_rate_limited");
      throw new Error(`infer_http_error:${response.status}`);
    }
    const result=await readCompletion(response, requestId, input.model, (kind, data) => this.traces?.event(requestId, kind, data));
    this.traces?.event(requestId,"output_budget",{limit:input.maxOutputTokens,observedTokens:result.usage.outputTokens,
      exceeded:result.usage.outputTokens===null?null:result.usage.outputTokens>input.maxOutputTokens,enforcement:"post_response"});
    if(result.usage.outputTokens!==null&&result.usage.outputTokens>input.maxOutputTokens)throw new Error(`infer_output_budget_exceeded:${requestId}`);
    return result;
  }
}
