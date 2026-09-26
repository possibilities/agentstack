import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { discoverModels } from "./catalog.js";
import { type CompleteInput, type CompleteOutput, type Model } from "./schema.js";
import type { InferTraces } from "./traces.js";

type Credentials = { access: string; nativeId: string; auth: string };
type Discover = (stateDir: string, auth: string) => Promise<Model[]>;
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

export class InferService {
  private readonly inFlight = new Set<string>();
  constructor(readonly stateDir: string, private readonly discover: Discover = discoverModels,
    private readonly fetcher: typeof fetch = fetch, private readonly credentials: typeof readCredentials = readCredentials,
    readonly traces?: InferTraces) {}

  async models(accountId: string): Promise<{ models: Model[]; observedAt: string }> {
    const { auth } = await this.credentials(this.stateDir, accountId);
    try { return { models: await this.discover(this.stateDir, auth), observedAt: new Date().toISOString() }; }
    catch { throw new Error("catalog_unavailable"); }
  }

  async complete(input: CompleteInput): Promise<CompleteOutput> {
    // One request per account at a time; callers must not flood shared Codex allowance.
    if (this.inFlight.has(input.accountId) || this.inFlight.size >= 2) throw new Error("infer_busy");
    this.inFlight.add(input.accountId);
    const requestId = input.requestId ?? randomUUID();
    try {
      const previous = this.traces?.reserve(requestId, input);
      if (previous) return previous;
      try {
        const result = await this.completeOnce(input, requestId);
        this.traces?.finish(requestId, result, null);
        return result;
      } catch (error) {
        this.traces?.finish(requestId, null, error instanceof Error ? error.message : "infer_error");
        throw error;
      }
    }
    finally { this.inFlight.delete(input.accountId); }
  }

  private async completeOnce(input: CompleteInput, requestId: string): Promise<CompleteOutput> {
    const credentials = await this.credentials(this.stateDir, input.accountId);
    let models: Model[];
    try { models = await this.discover(this.stateDir, credentials.auth); }
    catch { throw new Error("catalog_unavailable"); }
    if (!models.some((row) => row.id === input.model && row.supportedEfforts.includes(input.effort))) throw new Error("model_unavailable");
    this.traces?.event(requestId, "catalog", { models });
    const body = { model: input.model, instructions: input.instructions,
      input: [{ role: "user", content: [{ type: "input_text", text: input.input }] }],
      reasoning: { effort: input.effort }, stream: true, store: false };
    this.traces?.event(requestId, "dispatch", { url: "https://chatgpt.com/backend-api/codex/responses", body });
    let response: Response;
    try {
      response = await this.fetcher("https://chatgpt.com/backend-api/codex/responses", {
        method: "POST", redirect: "manual", signal: AbortSignal.timeout(30_000),
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
