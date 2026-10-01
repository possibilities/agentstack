import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { stateHash } from "@stack/api";
import { z } from "zod";
import { hook, type Endpoint, type Hook, type RemoteReceipt } from "./schema.js";
import type { GithubStore } from "./store.js";

class RemoteError extends Error {
  constructor(readonly code: string, readonly definite = false) { super(code); }
}
const rawHook = z.object({ id: z.number().int().positive(), active: z.boolean(), events: z.array(z.string()),
  config: z.object({ url: z.string(), content_type: z.string().optional(), insecure_ssl: z.string().optional() }), updated_at: z.string().optional() });
function normalizeHook(value: unknown): Hook {
  const parsed = rawHook.parse(value);
  return hook.parse({ id: parsed.id, active: parsed.active, events: parsed.events, url: parsed.config.url,
    contentType: parsed.config.content_type ?? null, insecureSsl: parsed.config.insecure_ssl ?? null, updatedAt: parsed.updated_at ?? null });
}
function hookPath(endpoint: Endpoint): string {
  if (endpoint.githubHost.toLowerCase() !== "github.com") throw new Error("github_manual_setup_required: GitHub Enterprise Server setup is manual; native gh automation targets github.com only");
  if (endpoint.target.kind === "repository") return `repos/${endpoint.target.repository}/hooks`;
  if (endpoint.target.kind === "organization") return `orgs/${endpoint.target.organization}/hooks`;
  throw new Error("github_manual_setup_required: App, enterprise, Marketplace and Sponsors setup uses GitHub settings; only repository and organization hooks support native gh automation");
}
/** Native gh authentication stays outside API records and UI; commands never accept arbitrary paths or argv. */
export class GithubRemote {
  private readonly children = new Map<ChildProcessWithoutNullStreams, () => void>();
  private readonly busy = new Set<string>();
  private stopping = false;
  constructor(private readonly store: GithubStore, private readonly env: NodeJS.ProcessEnv, private readonly changed: () => void) {}
  private async request(method: string, path: string, body?: unknown, includeHeaders = false): Promise<unknown> {
    if (this.stopping) throw new RemoteError("github_stopping", true);
    if (this.children.size >= 4) throw new RemoteError("github_native_request_capacity", true);
    return new Promise((resolve, reject) => {
      const env = { ...this.env }; delete env.GH_DEBUG;
      const args = ["api", "--hostname", "github.com", "--method", method, path, "-H", "Accept: application/vnd.github+json", "-H", "X-GitHub-Api-Version: 2022-11-28", ...(body === undefined ? [] : ["--input", "-"]), ...(includeHeaders ? ["--include"] : [])];
      const child = spawn("gh", args, { env, stdio: ["pipe", "pipe", "pipe"] });
      let forced: NodeJS.Timeout | undefined;
      const terminate = () => { child.kill("SIGTERM"); forced ??= setTimeout(() => child.kill("SIGKILL"), 1000); };
      this.children.set(child, terminate);
      let stdout = "", stderr = "", size = 0, limited = false;
      const timer = setTimeout(terminate, 30_000);
      const cleanup = () => { clearTimeout(timer); clearTimeout(forced); this.children.delete(child); };
      const collect = (chunk: Buffer, stream: "out" | "err") => {
        size += chunk.length;
        if (size > 4 * 1024 * 1024) { limited = true; terminate(); return; }
        if (stream === "out") stdout += chunk.toString("utf8"); else stderr += chunk.toString("utf8");
      };
      child.stdout.on("data", chunk => collect(chunk, "out")); child.stderr.on("data", chunk => collect(chunk, "err"));
      child.stdin.on("error", () => {}); // Close/exit determines outcome; EPIPE alone never proves refusal.
      child.once("error", error => { cleanup(); reject(new RemoteError((error as NodeJS.ErrnoException).code === "ENOENT" ? "github_gh_not_installed" : "github_gh_spawn_failed", true)); });
      child.once("close", (code, signal) => {
        cleanup();
        if (limited || signal) { reject(new RemoteError(limited ? "github_response_too_large" : "github_request_interrupted")); return; }
        if (code !== 0) {
          // Discard provider stderr (it can contain credentials/payloads). Preserve only a classified status.
          const status = /\(HTTP (\d{3})\)/.exec(stderr)?.[1];
          reject(new RemoteError(status ? `github_http_${status}` : "github_gh_request_failed", !!status && /^4\d\d$/.test(status) && status !== "408")); return;
        }
        if (!stdout.trim()) { resolve(null); return; }
        try {
          if (includeHeaders) {
            const boundary = /\r?\n\r?\n/.exec(stdout);
            if (!boundary || !/^HTTP\//.test(stdout)) throw new Error("missing HTTP headers");
            const headers = stdout.slice(0, boundary.index);
            resolve({ data: JSON.parse(stdout.slice(boundary.index + boundary[0].length)), link: /^link:\s*(.*)$/im.exec(headers)?.[1] ?? null });
          } else resolve(JSON.parse(stdout));
        } catch { reject(new RemoteError("github_response_invalid")); }
      });
      child.stdin.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }
  async authStatus() {
    try {
      const value = z.object({ login: z.string(), id: z.number() }).parse(await this.request("GET", "user"));
      return { available: true, authenticated: true, login: value.login, error: null };
    } catch (error) { return { available: !(error instanceof RemoteError && error.code === "github_gh_not_installed"), authenticated: false,
      login: null, error: error instanceof RemoteError ? error.code : "github_response_invalid" }; }
  }
  async repositories(page: number, organization?: string) {
    const path = organization ? `orgs/${organization}/repos?per_page=100&page=${page}&sort=full_name` : `user/repos?per_page=100&page=${page}&sort=full_name&affiliation=owner,collaborator,organization_member`;
    const schema = z.array(z.object({ id: z.number(), full_name: z.string(), private: z.boolean(), html_url: z.string(), permissions: z.object({ admin: z.boolean().optional() }).optional(), archived: z.boolean().optional() }));
    const values = schema.parse(await this.request("GET", path));
    return { entries: values.map(item => ({ id: item.id, repository: item.full_name, private: item.private, url: item.html_url, admin: item.permissions?.admin ?? null, archived: item.archived ?? false })), nextPage: values.length === 100 ? page + 1 : null };
  }
  async organizations(page: number) {
    const values = z.array(z.object({ id: z.number(), login: z.string() })).parse(await this.request("GET", `user/orgs?per_page=100&page=${page}`));
    return { entries: values, nextPage: values.length === 100 ? page + 1 : null };
  }
  async hooks(endpointId: string): Promise<Hook[]> {
    const endpoint = this.store.getEndpoint(endpointId), path = hookPath(endpoint), entries: Hook[] = [];
    // Never silently reconcile a truncated inventory; an unobserved hook could duplicate one we create.
    for (let page = 1; page <= 10; page++) {
      const values = z.array(z.unknown()).parse(await this.request("GET", `${path}?per_page=100&page=${page}`));
      entries.push(...values.map(normalizeHook));
      if (values.length < 100) return entries;
    }
    throw new Error("github_hook_inventory_incomplete");
  }
  private selected(endpoint: Endpoint, hooks: Hook[]) {
    const matches = hooks.filter(hook => hook.id === endpoint.managedHookId || hook.url === endpoint.webhookUrl);
    if (matches.length > 1) throw new Error("github_hook_ambiguous: multiple hooks match; inspect and resolve on GitHub");
    return matches[0] ?? null;
  }
  async plan(endpointId: string, events: string[]) {
    const endpoint = this.store.getEndpoint(endpointId);
    if (!endpoint.enabled || !endpoint.webhookUrl) throw new Error("github_endpoint_not_ready: enable the receiver and configure its externally reachable HTTPS origin");
    const existing = this.selected(endpoint, await this.hooks(endpointId));
    if (this.store.getEndpoint(endpointId).revision !== endpoint.revision) throw new Error("github_endpoint_revision_changed");
    const plan = { id: randomUUID(), endpointId, endpointRevision: endpoint.revision, action: existing ? "update" as const : "create" as const,
      hookId: existing?.id ?? null, webhookUrl: endpoint.webhookUrl, events: [...new Set(events)].sort(), observedRevision: stateHash(existing),
      expiresAt: new Date(Date.now() + 600_000).toISOString(), consequences: ["Configure only the exact matching/previously managed hook; unrelated hooks remain untouched",
        "Set JSON, active=true, TLS verification and the receiver's current secret; GitHub never returns the secret for comparison",
        "Public reachability is an operator prerequisite; configuration success does not prove signed deliveries arrive"] };
    this.store.saveHookPlan(plan); return plan;
  }
  private async exclusive<T>(endpointId: string, work: () => Promise<T>): Promise<T> {
    if (this.busy.has(endpointId)) throw new Error("github_endpoint_busy");
    this.busy.add(endpointId); try { return await work(); } finally { this.busy.delete(endpointId); }
  }
  endpointBusy(id: string): boolean { return this.busy.has(id); }
  async apply(input: { planId: string; requestId: string }) {
    const old = this.store.existingRemote(input.requestId, input); if (old) return old;
    const plan = this.store.getHookPlan(input.planId);
    return this.exclusive(plan.endpointId, async () => {
      const endpoint = this.store.getEndpoint(plan.endpointId);
      if (endpoint.revision !== plan.endpointRevision || !endpoint.enabled) throw new Error("github_endpoint_revision_changed");
      const existing = this.selected(endpoint, await this.hooks(endpoint.id));
      if (stateHash(existing) !== plan.observedRevision) throw new Error("github_remote_hook_changed: prepare a new plan");
      if (this.store.getEndpoint(endpoint.id).revision !== plan.endpointRevision) throw new Error("github_endpoint_revision_changed");
      const receipt: RemoteReceipt = { requestId: input.requestId, endpointId: endpoint.id, action: plan.action, status: "running", hookId: plan.hookId,
        startedAt: new Date().toISOString(), completedAt: null, error: null };
      this.store.beginRemote(receipt, input); this.changed();
      try {
        const value = normalizeHook(await this.request(existing ? "PATCH" : "POST", `${hookPath(endpoint)}${existing ? `/${existing.id}` : ""}`, {
          ...(existing ? {} : { name: "web" }), active: true, events: plan.events,
          config: { url: plan.webhookUrl, content_type: "json", insecure_ssl: "0", secret: this.store.secrets(endpoint.id)[0] },
        }));
        this.store.bindHook(endpoint.id, value.id);
        receipt.hookId = value.id; receipt.status = "succeeded";
      } catch (error) {
        receipt.status = error instanceof RemoteError && error.definite ? "failed" : "unknown";
        receipt.error = error instanceof RemoteError ? error.code : "github_response_invalid";
      }
      receipt.completedAt = new Date().toISOString(); this.store.finishRemote(receipt); this.changed(); return receipt;
    });
  }
  private managed(endpointId: string, hookId: number): Endpoint {
    const endpoint = this.store.getEndpoint(endpointId);
    if (endpoint.managedHookId !== hookId) throw new Error("github_hook_not_managed: configure through a reviewed hook plan first");
    return endpoint;
  }
  async hookAction(input: { endpointId: string; hookId: number; requestId: string; action: "ping" | "test" | "redeliver"; deliveryId?: number }) {
    const old = this.store.existingRemote(input.requestId, input); if (old) return old;
    return this.exclusive(input.endpointId, async () => {
      const endpoint = this.managed(input.endpointId, input.hookId);
      const path = `${hookPath(endpoint)}/${input.hookId}/${input.action === "redeliver" ? `deliveries/${input.deliveryId}/attempts` : input.action === "test" ? "tests" : "pings"}`;
      const receipt: RemoteReceipt = { requestId: input.requestId, endpointId: input.endpointId, action: input.action, status: "running", hookId: input.hookId,
        startedAt: new Date().toISOString(), completedAt: null, error: null };
      this.store.beginRemote(receipt, input); this.changed();
      try { await this.request("POST", path); receipt.status = "succeeded"; }
      catch (error) { receipt.status = error instanceof RemoteError && error.definite ? "failed" : "unknown"; receipt.error = error instanceof RemoteError ? error.code : "github_response_invalid"; }
      receipt.completedAt = new Date().toISOString(); this.store.finishRemote(receipt); this.changed(); return receipt;
    });
  }
  async deliveries(endpointId: string, hookId: number, cursor?: string) {
    const endpoint = this.managed(endpointId, hookId);
    const page = z.object({ data: z.unknown(), link: z.string().nullable() }).parse(await this.request("GET", `${hookPath(endpoint)}/${hookId}/deliveries?per_page=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, undefined, true));
    const values = z.array(z.object({ id: z.number().int().positive(), guid: z.string(), delivered_at: z.string(), redelivery: z.boolean(),
      duration: z.number(), status: z.string(), status_code: z.number(), event: z.string(), action: z.string().nullable() })).parse(page.data);
    const next = page.link?.split(",").map(value => /<([^>]+)>;\s*rel="next"/.exec(value)?.[1]).find(Boolean);
    const nextCursor = next ? new URL(next).searchParams.get("cursor") : null;
    if (next && !nextCursor) throw new Error("github_delivery_pagination_invalid");
    return { entries: values.map(item => ({ id: item.id, guid: item.guid, deliveredAt: item.delivered_at, redelivery: item.redelivery, duration: item.duration,
      status: item.status, statusCode: item.status_code, event: item.event, action: item.action })),
      nextCursor };
  }
  stopAdmission(): void { this.stopping = true; for (const terminate of this.children.values()) terminate(); }
}
