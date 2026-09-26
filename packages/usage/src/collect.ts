import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AccountScope, Provider, Measurement, Subscription } from "./schema.js";
import { codexUsage, grokUsage, devinUsage, claudeUsage, grokBotUsage } from "./schema.js";
import { ClaudeCredentialError, readClaudeCredentials, type ClaudeCredentialOptions } from "@agentstack/auth";
import type { z } from "zod";

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue | null => value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : null;
const string = (value: unknown): string | null => typeof value === "string" && value.length ? value : null;
const label = (value: unknown): string | null => {
  const text = string(value);
  return text && /^[\w .+-]{1,80}$/.test(text) && !text.includes("://") ? text : null;
};
const number = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;
const integer = (value: unknown): number | null => typeof value === "number" && Number.isSafeInteger(value) ? value : typeof value === "string" && /^-?\d+$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : null;
const flag = (value: unknown): boolean | null => typeof value === "boolean" ? value : null;
const iso = (value: unknown): string | null => typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const epoch = (value: unknown): string | null => { const seconds = integer(value); return seconds && seconds > 0 ? new Date(seconds * 1000).toISOString() : null; };
const codexClaims = (token: string): RecordValue | null => {
  try { return record(record(JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")))?.["https://api.openai.com/auth"]); }
  catch { return null; }
};
const codexIdentity = (access: string): string | null => string(codexClaims(access)?.chatgpt_account_id);
/** The stored ID token's subscription claim, as current as the credential owner's last token refresh. */
const codexSubscription = (idToken: unknown): Subscription => {
  const claims = typeof idToken === "string" ? codexClaims(idToken) : null;
  const endsAt = iso(claims?.chatgpt_subscription_active_until), checked = iso(claims?.chatgpt_subscription_last_checked);
  return endsAt ? { endsAt, source: "sign_in_claim", checkedAtMs: checked ? Date.parse(checked) : null } : null;
};
const clamp = (value: number | null) => value === null ? null : Math.min(100, Math.max(0, value));

export class ObservationFailure extends Error {
  constructor(readonly code: string) { super(code); }
}

async function privateFile(path: string, maxBytes = 128_000): Promise<string> {
  let handle;
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch { throw new ObservationFailure("credentials_unavailable"); }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || stat.mode & 0o077 || stat.size > maxBytes)
      throw new ObservationFailure("credentials_unsafe");
    return await handle.readFile("utf8");
  } finally { await handle.close(); }
}

async function privateDatabase(path: string): Promise<void> {
  let handle;
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch { throw new ObservationFailure("credentials_unavailable"); }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || stat.mode & 0o077 || stat.size > 32 * 1024 * 1024)
      throw new ObservationFailure("credentials_unsafe");
  } finally { await handle.close(); }
}

/** No file or token leaves this module. Sign-in and token rotation stay with auth and native runtimes. */
async function credential(stateDir: string, id: string, provider: Provider, scope: AccountScope, claude: ClaudeCredentialOptions = {}): Promise<{ access: string; userId?: string; server?: string; subscription?: Subscription }> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new ObservationFailure("account_invalid");
  if (provider === "claude") {
    if (scope !== "worker") throw new ObservationFailure("account_invalid");
    try {
      const value = await readClaudeCredentials(stateDir, id, claude);
      // Bind a read to the confirmed native identity without publishing or rotating it.
      const path = join(stateDir, "configuration.sqlite");
      await privateDatabase(path);
      const db = new DatabaseSync(path, { readOnly: true });
      try {
        const row = db.prepare("SELECT identity_digest FROM worker_accounts WHERE id = ? AND provider = 'claude' AND ready = 1 AND removing = 0").get(id) as { identity_digest: string | null } | undefined;
        if (!row?.identity_digest || row.identity_digest !== createHash("sha256").update(value.identity).digest("hex"))
          throw new ObservationFailure("identity_invalid");
      } finally { db.close(); }
      return { access: value.access };
    } catch (error) {
      if (error instanceof ObservationFailure) throw error;
      throw new ObservationFailure(error instanceof ClaudeCredentialError && ["credentials_unsafe", "identity_invalid"].includes(error.code) ? error.code : "credentials_unavailable");
    }
  }
  if (provider === "codex" && scope === "bot") {
    const path = join(stateDir, "secrets.sqlite");
    await privateDatabase(path);
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      const row = db.prepare("SELECT auth_json FROM credentials WHERE name = ?").get(id) as { auth_json: string } | undefined;
      const auth = record(row && JSON.parse(row.auth_json));
      const tokens = record(auth?.tokens);
      const access = string(tokens?.access_token);
      if (!access) throw new ObservationFailure("credentials_unavailable");
      const nativeId = string(tokens?.account_id) ?? codexIdentity(access);
      if (nativeId && /[\r\n]/.test(nativeId)) throw new ObservationFailure("credentials_unavailable");
      return { access, userId: nativeId ?? undefined, subscription: codexSubscription(tokens?.id_token) };
    } finally { db.close(); }
  }
  const root = join(stateDir, "worker-accounts", id, "data");
  if (provider === "codex" || provider === "grok") {
    const path = join(root, "opencode", "opencode.db");
    await privateDatabase(path);
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      const rows = db.prepare("SELECT integration_id, value FROM credential").all() as Array<{ integration_id: string; value: string }>;
      if (rows.length !== 1 || rows[0]?.integration_id !== (provider === "codex" ? "openai" : "xai")) throw new ObservationFailure("credentials_unavailable");
      const entry = record(JSON.parse(rows[0].value));
      const access = string(entry?.access);
      if (entry?.type !== "oauth" || !access) throw new ObservationFailure("credentials_unavailable");
      const userId = provider === "codex" ? string(record(entry.metadata)?.accountID) ?? codexIdentity(access) : null;
      if (userId && /[\r\n]/.test(userId)) throw new ObservationFailure("credentials_unavailable");
      return { access, userId: userId ?? undefined };
    } finally { db.close(); }
  }
  const text = await privateFile(join(root, "devin", "credentials.toml"));
  const values: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const match = /^([a-z_]+)\s*=\s*(?:"([^"]*)"|'([^']*)')\s*$/.exec(line.trim());
    if (match) values[match[1]!] = match[2] ?? match[3] ?? "";
  }
  const access = values.windsurf_api_key || values.api_key;
  let url: URL;
  try { url = new URL(values.api_server_url ?? ""); } catch { throw new ObservationFailure("credentials_unavailable"); }
  if (!access || access.length > 4096 || url.protocol !== "https:" || url.username || url.password || url.hash)
    throw new ObservationFailure("credentials_unavailable");
  return { access, server: url.origin };
}

export type SignIn = { identity: string | null; subscription: Subscription };
/** Read a native identity for optional correlation and any subscription claim; never publish the identity or an OAuth token. */
export async function accountSignIn(stateDir: string, id: string, provider: Provider, scope: AccountScope): Promise<SignIn> {
  if (provider !== "codex") return { identity: null, subscription: null };
  const value = await credential(stateDir, id, provider, scope);
  return { identity: value.userId ?? null, subscription: value.subscription ?? null };
}

async function boundedJson(response: Response): Promise<RecordValue> {
  if (!response.body) throw new ObservationFailure("response_invalid");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > 262_144) throw new ObservationFailure("response_invalid");
      chunks.push(value);
    }
    const parsed = record(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    if (!parsed) throw new ObservationFailure("response_invalid");
    return parsed;
  } catch {
    await reader.cancel().catch(() => {});
    throw new ObservationFailure("response_invalid");
  }
  finally { reader.releaseLock(); }
}

async function request(url: string, init: RequestInit, fetcher: typeof fetch, signal: AbortSignal): Promise<RecordValue> {
  let response: Response;
  try { response = await fetcher(url, { ...init, redirect: "manual", signal: AbortSignal.any([AbortSignal.timeout(15_000), signal]) }); }
  catch { throw new ObservationFailure("provider_unavailable"); }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    if (response.status === 401 || response.status === 403) throw new ObservationFailure("auth_unavailable");
    if (response.status === 429) throw new ObservationFailure("rate_limited");
    if (response.status === 404) throw new ObservationFailure("not_found");
    throw new ObservationFailure("provider_error");
  }
  return boundedJson(response);
}

function codex(value: RecordValue, measuredAtMs: number): Measurement {
  const lanes = new Map<string, { id: string; title: string; windows: Array<{
    role: "primary" | "secondary" | "code_review" | "other"; label: string; windowSeconds: number | null;
    usedPercent: number; remainingPercent: number; resetsAt: string | null;
    limitName: string | null; meteredFeature: string | null }> }>();
  const add = (raw: unknown, role: "primary" | "secondary" | "code_review" | "other", id: string, title: string,
    limitName: string | null = null, meteredFeature: string | null = null) => {
    if (raw == null) return;
    const row = record(raw), used = number(row?.used_percent);
    if (used === null || used < 0) throw new ObservationFailure("response_invalid");
    const windowSeconds = number(row?.limit_window_seconds);
    const resetSeconds = number(row?.reset_at);
    const after = number(row?.reset_after_seconds);
    const reset = resetSeconds && resetSeconds * 1000 > 0 && resetSeconds * 1000 < measuredAtMs + 2 * 365 * 86400_000
      ? new Date(resetSeconds * 1000).toISOString()
      : after !== null && after >= 0 && after < 2 * 365 * 86400 ? new Date(measuredAtMs + after * 1000).toISOString() : null;
    const lane = lanes.get(id) ?? { id, title, windows: [] };
    lane.windows.push({ role, label: windowSeconds === 18000 ? "5h" : windowSeconds === 604800 ? "weekly" : windowSeconds === 86400 ? "daily" : windowSeconds ? `${windowSeconds}s` : "window",
      windowSeconds, usedPercent: used, remainingPercent: Math.max(0, 100 - used), resetsAt: reset, limitName, meteredFeature });
    lanes.set(id, lane);
  };
  const limits = record(value.rate_limit);
  add(limits?.primary_window, "primary", "main", "Main");
  add(limits?.secondary_window, "secondary", "main", "Main");
  if (!lanes.get("main")?.windows.some((entry) => entry.role === "primary")) throw new ObservationFailure("response_invalid");
  const review = record(value.code_review_rate_limit);
  add(review?.primary_window, "code_review", "code-review", "Code Review");
  add(review?.secondary_window, "code_review", "code-review", "Code Review");
  for (const candidate of Array.isArray(value.additional_rate_limits) ? value.additional_rate_limits : []) {
    const row = record(candidate), windows = record(row?.rate_limit);
    const name = label(row?.limit_name), feature = label(row?.metered_feature);
    const identity = name ?? feature;
    const id = identity?.toLowerCase().includes("spark") ? "codex-spark" : identity ? `codex-${identity.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}` : "codex-extra";
    add(windows?.primary_window, "other", id, identity ?? "Additional", name, feature);
    add(windows?.secondary_window, "other", id, identity ?? "Additional", name, feature);
  }
  const credit = record(value.rate_limit_reset_credit_details) ?? record(value.rate_limit_reset_credits);
  const originalCredit = record(value.rate_limit_reset_credits);
  const expirations = Array.isArray(credit?.credits) ? credit.credits.map((item) => iso(record(item)?.expires_at)) : null;
  return codexUsage.parse({ planType: label(value.plan_type), limitReached: flag(limits?.limit_reached),
    resetCreditsAvailable: integer(credit?.available_count) ?? integer(originalCredit?.available_count),
    resetCreditExpirations: expirations, lanes: [...lanes.values()] });
}

function cents(value: unknown): number | null {
  const row = record(value);
  if (!row) return null;
  if (!Object.hasOwn(row, "val")) return Object.keys(row).length === 0 ? 0 : null;
  return integer(row.val);
}
function usd(value: number | null): number | null { return value === null ? null : Math.round(value) / 100; }
function grok(value: RecordValue): Measurement {
  const config = record(value.config);
  if (!config) throw new ObservationFailure("response_invalid");
  const period = record(config.currentPeriod);
  const periodType = string(period?.type);
  const periodStart = iso(period?.start) ?? iso(config.billingPeriodStart);
  const resetsAt = iso(period?.end) ?? iso(config.billingPeriodEnd);
  const monthlyLimit = cents(config.monthlyLimit), legacyUsed = cents(config.used);
  let used = number(config.creditUsagePercent);
  if (used === null && monthlyLimit && legacyUsed !== null) used = 100 * legacyUsed / monthlyLimit;
  if (used === null && !Object.hasOwn(config, "creditUsagePercent") && config.isUnifiedBillingUser === true &&
      ["USAGE_PERIOD_TYPE_WEEKLY", "USAGE_PERIOD_TYPE_MONTHLY"].includes(periodType ?? "") && periodStart && resetsAt) used = 0;
  used = clamp(used);
  const onDemandUsed = cents(config.onDemandUsed), onDemandCap = cents(config.onDemandCap);
  return grokUsage.parse({ subscriptionTier: label(value.subscriptionTier),
    included: { usedPercent: used, remainingPercent: used === null ? null : 100 - used,
      periodType: periodType?.toLowerCase().replace(/^usage_period_type_/, "") ?? null, periodStart, resetsAt,
      allocatedUsd: monthlyLimit !== null && monthlyLimit >= 0 ? usd(monthlyLimit) : null },
    prepaidBalanceUsd: usd(cents(config.prepaidBalance)), paygEnabled: flag(value.onDemandEnabled) ?? (onDemandCap === null ? null : onDemandCap > 0),
    paygUsedUsd: usd(onDemandUsed), paygCapUsd: usd(onDemandCap),
    paygRemainingUsd: onDemandUsed === null || onDemandCap === null ? null : usd(Math.max(0, onDemandCap - onDemandUsed)) });
}

function devin(value: RecordValue): Measurement {
  const status = record(record(value.userStatus)?.planStatus);
  const plan = record(status?.planInfo);
  if (!status || !plan) throw new ObservationFailure("response_invalid");
  const dailyResetsAt = epoch(status.dailyQuotaResetAtUnix), weeklyResetsAt = epoch(status.weeklyQuotaResetAtUnix);
  const percent = (value: unknown, reset: string | null) => value === undefined && reset ? 0 : clamp(number(value));
  const billing = { BILLING_STRATEGY_QUOTA: "quota", BILLING_STRATEGY_ACU: "acu", BILLING_STRATEGY_CREDITS: "credits" };
  return devinUsage.parse({ planLabel: label(plan.planName), billing: billing[plan.billingStrategy as keyof typeof billing] ?? null,
    dailyRemainingPercent: percent(status.dailyQuotaRemainingPercent, dailyResetsAt),
    weeklyRemainingPercent: percent(status.weeklyQuotaRemainingPercent, weeklyResetsAt), dailyResetsAt, weeklyResetsAt,
    periodStart: iso(status.planStart), periodEnd: iso(status.planEnd), promptCreditsMonthly: integer(plan.monthlyPromptCredits),
    promptCreditsAvailable: integer(status.availablePromptCredits), weeklyQuotaHidden: flag(plan.hideWeeklyQuota),
    displayName: label(record(plan.devinInfo)?.accountDisplayName) });
}

export function parseClaudeUsage(value: RecordValue): z.infer<typeof claudeUsage> {
  const windows: z.infer<typeof claudeUsage>["windows"] = [];
  for (const [id, raw] of Object.entries(value)) {
    // Weekly breakdown metadata is not an independent model quota window.
    if (id === "seven_day_breakdown") continue;
    if (id !== "five_hour" && id !== "seven_day" && !/^seven_day_[a-z0-9_]{1,60}$/.test(id)) continue;
    if (raw === null) continue;
    const window = record(raw), used = number(window?.utilization);
    if (!window || used === null || used < 0) throw new ObservationFailure("response_invalid");
    const reset = string(window.resets_at);
    windows.push({ id, label: id === "five_hour" ? "5h" : id === "seven_day" ? "Weekly" : `Weekly ${id.slice(10).replaceAll("_", " ")}`,
      usedPercent: used, remainingPercent: Math.max(0, 100 - used),
      resetsAt: reset && /(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(reset) ? iso(reset) : null });
  }
  if (!windows.some((window) => window.id === "five_hour") || !windows.some((window) => window.id === "seven_day") || windows.length > 32)
    throw new ObservationFailure("response_invalid");
  let extraUsage: z.infer<typeof claudeUsage>["extraUsage"] = null;
  if (value.extra_usage != null) {
    const extra = record(value.extra_usage);
    if (!extra) throw new ObservationFailure("response_invalid");
    const optional = (raw: unknown) => {
      if (raw == null) return null;
      const parsed = number(raw);
      if (parsed === null || parsed < 0) throw new ObservationFailure("response_invalid");
      return parsed;
    };
    extraUsage = { enabled: flag(extra.is_enabled), monthlyLimit: optional(extra.monthly_limit),
      usedCredits: optional(extra.used_credits), utilization: optional(extra.utilization) };
  }
  return claudeUsage.parse({ windows, extraUsage });
}

export async function collectAccount(stateDir: string, id: string, provider: Provider, fetcher: typeof fetch = fetch,
  signal: AbortSignal = new AbortController().signal, scope: AccountScope = provider === "codex" ? "bot" : "worker",
  claude: ClaudeCredentialOptions = {}): Promise<Measurement> {
  const credentials = await credential(stateDir, id, provider, scope, claude);
  if (provider === "claude") {
    return parseClaudeUsage(await request("https://api.anthropic.com/api/oauth/usage", { headers: {
      authorization: `Bearer ${credentials.access}`, "anthropic-beta": "oauth-2025-04-20", "anthropic-version": "2023-06-01",
    } }, fetcher, signal));
  }
  if (provider === "codex") {
    const headers = { authorization: `Bearer ${credentials.access}`, ...(credentials.userId ? { "ChatGPT-Account-ID": credentials.userId } : {}) };
    let data: RecordValue;
    try { data = await request("https://chatgpt.com/backend-api/wham/usage", { headers }, fetcher, signal); }
    catch (error) {
      if (!(error instanceof ObservationFailure) || error.code !== "not_found") throw error;
      data = await request("https://chatgpt.com/api/codex/usage", { headers }, fetcher, signal);
    }
    const credits = record(data.rate_limit_reset_credits);
    if ((integer(credits?.available_count) ?? 0) > 0) {
      try {
        data.rate_limit_reset_credit_details = await request("https://chatgpt.com/api/codex/rate-limit-reset-credits", { headers }, fetcher, signal);
      } catch { /* optional detail; the original count remains useful */ }
    }
    return codex(data, Date.now());
  }
  if (provider === "grok") {
    const identity = await request("https://auth.x.ai/oauth2/userinfo", { headers: { authorization: `Bearer ${credentials.access}`, "x-grok-client-version": "1.0.16" } }, fetcher, signal);
    const userId = string(identity.sub);
    if (!userId || userId.length > 1024 || /[\r\n]/.test(userId)) throw new ObservationFailure("identity_invalid");
    const data = await request("https://cli-chat-proxy.grok.com/v1/billing?format=credits", { headers: {
      authorization: `Bearer ${credentials.access}`, "X-XAI-Token-Auth": "xai-grok-cli", "x-userid": userId,
      "x-grok-client-version": "1.0.16", "x-grok-client-mode": "headless",
    } }, fetcher, signal);
    return grok(data);
  }
  const data = await request(new URL("/exa.seat_management_pb.SeatManagementService/GetUserStatus", credentials.server).toString(), {
    method: "POST", headers: { "content-type": "application/json", "connect-protocol-version": "1" },
    body: JSON.stringify({ metadata: { apiKey: credentials.access, ideName: "devin-cli", ideVersion: "3000.11.1",
      extensionName: "devin-cli", extensionVersion: "3000.11.1" } }),
  }, fetcher, signal);
  return devin(data);
}

export async function collectGrokBot(binary = join(homedir(), ".local/bin/agentgrok"),
  signal: AbortSignal = new AbortController().signal): Promise<z.infer<typeof grokBotUsage>> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ["usage", "--json"], { stdio: ["ignore", "pipe", "ignore"], detached: process.platform !== "win32" });
    let output = "", failed = false, done = false;
    const stop = () => { if (child.pid) try { process.kill(process.platform === "win32" ? child.pid : -child.pid, "SIGKILL"); } catch { /* exited */ } };
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
    const timer = setTimeout(() => { failed = true; stop(); }, 30_000);
    child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); if (output.length > 262_144) { failed = true; stop(); } });
    child.once("error", () => finish());
    child.once("close", (code) => {
      if (code !== 0) failed = true;
      finish();
    });
    function finish() {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
      if (failed || !output) { reject(new ObservationFailure("grok_bot_unavailable")); return; }
      try {
        const envelope = record(JSON.parse(output));
        const data = record(envelope?.data), usage = record(data?.usage);
        if (envelope?.ok !== true || envelope.schema_version !== 1 || !usage) throw new Error("invalid");
        const start = number(usage.currentPeriodStartMs), reset = number(usage.nextResetAtMs);
        if (!start || !reset) throw new Error("invalid");
        resolve(grokBotUsage.parse({ usedPercent: clamp(number(usage.usagePercent)), periodStart: new Date(start).toISOString(),
          resetsAt: new Date(reset).toISOString(), hasAvailableUsage: usage.hasAvailableUsage !== false,
          planLabel: label(usage.planLabel), fundingPlan: label(usage.fundingPlan),
          onDemandEligible: flag(usage.onDemandEligible), onDemandEnabled: flag(usage.onDemandEnabled),
          trial: flag(usage.trial), teamSeat: flag(usage.isTeamSeat) }));
      } catch { reject(new ObservationFailure("grok_bot_invalid")); }
    }
  });
}
