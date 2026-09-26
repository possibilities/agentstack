import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { discoverModels } from "./catalog.js";
import { type CompleteInput, type CompleteOutput, type Model } from "./schema.js";

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
export async function readCompletion(response: Response, requestId: string, model: string): Promise<CompleteOutput> {
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
      if (text.length > 16_000) throw new Error("invalid");
    } else if (event.type === "response.completed") {
      completed = object(event.response);
      if (!completed || completed.status !== "completed") throw new Error("invalid");
    } else if (event.type === "response.failed" || event.type === "error" || event.type === "response.incomplete") failed = true;
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 512_000) throw new Error("invalid");
      buffer += decoder.decode(value, { stream: true });
      if (buffer.length > 64_000) throw new Error("invalid");
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
    return { requestId, model, text, usage: {
      inputTokens: count(usage?.input_tokens), outputTokens: count(usage?.output_tokens),
      totalTokens: count(usage?.total_tokens), reasoningTokens: count(details?.reasoning_tokens),
    } };
  } catch { await reader.cancel().catch(() => {}); throw new Error(`infer_outcome_unknown:${requestId}`); }
  finally { reader.releaseLock(); }
}

export class InferService {
  private readonly inFlight = new Set<string>();
  constructor(readonly stateDir: string, private readonly discover: Discover = discoverModels,
    private readonly fetcher: typeof fetch = fetch, private readonly credentials: typeof readCredentials = readCredentials) {}

  async models(accountId: string): Promise<{ models: Model[]; observedAt: string }> {
    const { auth } = await this.credentials(this.stateDir, accountId);
    try { return { models: await this.discover(this.stateDir, auth), observedAt: new Date().toISOString() }; }
    catch { throw new Error("catalog_unavailable"); }
  }

  async complete(input: CompleteInput): Promise<CompleteOutput> {
    // One request per account at a time; callers must not flood shared Codex allowance.
    if (this.inFlight.has(input.accountId) || this.inFlight.size >= 2) throw new Error("infer_busy");
    this.inFlight.add(input.accountId);
    try { return await this.completeOnce(input); }
    finally { this.inFlight.delete(input.accountId); }
  }

  private async completeOnce(input: CompleteInput): Promise<CompleteOutput> {
    const credentials = await this.credentials(this.stateDir, input.accountId);
    let models: Model[];
    try { models = await this.discover(this.stateDir, credentials.auth); }
    catch { throw new Error("catalog_unavailable"); }
    if (!models.some((row) => row.id === input.model && row.supportedEfforts.includes(input.effort))) throw new Error("model_unavailable");
    const requestId = randomUUID();
    let response: Response;
    try {
      response = await this.fetcher("https://chatgpt.com/backend-api/codex/responses", {
        method: "POST", redirect: "manual", signal: AbortSignal.timeout(30_000),
        headers: { Authorization: `Bearer ${credentials.access}`, "chatgpt-account-id": credentials.nativeId,
          "Content-Type": "application/json", Accept: "text/event-stream", originator: "codex_cli_rs", session_id: requestId },
        body: JSON.stringify({ model: input.model, instructions: input.instructions,
          input: [{ role: "user", content: [{ type: "input_text", text: input.input }] }],
          reasoning: { effort: input.effort }, max_output_tokens: input.maxOutputTokens, stream: true, store: false }),
      });
    } catch { throw new Error(`infer_outcome_unknown:${requestId}`); }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      if (response.status === 401) throw new Error("codex_sign_in_required");
      if (response.status === 403) throw new Error("codex_access_denied");
      if (response.status === 429) throw new Error("codex_rate_limited");
      throw new Error(`infer_http_error:${response.status}`);
    }
    return readCompletion(response, requestId, input.model);
  }
}
