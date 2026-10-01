import WebSocket from "ws";
import { stateHash, type StateOutcome } from "@stack/api";

export type SiteSelection = { origins: string[]; categories: Array<"cookies" | "storage" | "cache" | "history"> };
type Cookie = { name: string; domain: string; path: string; partitionKey?: { topLevelSite: string; hasCrossSiteAncestor: boolean }; partitionKeyOpaque?: boolean };
class Cdp {
  private seq = 0;
  private readonly pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  constructor(private readonly ws: WebSocket) {
    ws.on("message", raw => {
      try { const value = JSON.parse(String(raw)), pending = this.pending.get(value.id); if (!pending) return;
        this.pending.delete(value.id); clearTimeout(pending.timer);
        if (value.error) pending.reject(new Error("Scoped CDP command refused")); else pending.resolve(value.result);
      } catch { this.close(); }
    });
    ws.on("error", () => this.close()); ws.on("close", () => this.close());
  }
  async call(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = ++this.seq, timer = setTimeout(() => { this.pending.delete(id); reject(new Error("Scoped CDP outcome is unknown")); this.close(); }, 5000);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }), error => { if (error) this.close(); });
    });
  }
  close() { for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error("Scoped CDP connection ended; outcome unknown")); } this.pending.clear(); this.ws.terminate(); }
}
async function connect(source: string) {
  const url = new URL(source);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password || url.pathname !== "/") throw new Error("Browser maintenance requires the exact owned loopback relay");
  const response = await fetch(source + "/json/version", { signal: AbortSignal.timeout(5000), redirect: "error" });
  if (!response.ok) throw new Error("Exact browser CDP endpoint unavailable");
  const value = await response.json() as { webSocketDebuggerUrl: string }, endpoint = new URL(value.webSocketDebuggerUrl);
  if (endpoint.protocol !== "ws:" || endpoint.host !== url.host || !/^\/devtools\/browser\/[A-Za-z0-9-]+$/.test(endpoint.pathname) || endpoint.search || endpoint.username || endpoint.password) throw new Error("Browser CDP incarnation endpoint unsafe");
  const ws = new WebSocket(endpoint, { maxPayload: 8_000_000, followRedirects: false, handshakeTimeout: 5000 });
  await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
  return { cdp: new Cdp(ws), endpoint: endpoint.href };
}
const selectedCookie = (cookie: Cookie, origins: string[]) => origins.some(origin => {
  const host = new URL(origin).hostname, domain = cookie.domain.replace(/^\./, "");
  return (cookie.domain.startsWith(".") ? host === domain || host.endsWith(`.${domain}`) : host === domain)
    && (!cookie.partitionKey || origins.some(origin => new URL(origin).origin === new URL(cookie.partitionKey!.topLevelSite).origin));
});
async function observe(cdp: Cdp, selection: SiteSelection, endpoint: string) {
  const cookies: Cookie[] = selection.categories.includes("cookies") ? (await cdp.call("Storage.getCookies")).cookies : [];
  if (cookies.length > 10000) throw new Error("Cookie observation exceeds bounded scope");
  const selected = cookies.filter(cookie => selectedCookie(cookie, selection.origins));
  if (selected.some(cookie => cookie.partitionKeyOpaque || typeof cookie.name !== "string" || typeof cookie.path !== "string" || !cookie.path.startsWith("/"))) throw new Error("Cookie partition/path scope cannot be verified");
  const storage = selection.categories.some(category => category === "storage" || category === "cache")
    ? await Promise.all(selection.origins.map(async origin => [origin, await cdp.call("Storage.getUsageAndQuota", { origin })])) : [];
  const targets = await cdp.call("Target.getTargets");
  return { revision: stateHash([endpoint, selected, storage, targets]), cookies: selected.map(({ name, domain, path, partitionKey }) => ({ name, domain, path, ...(partitionKey ? { partitionKey } : {}) })) };
}
export async function observeSiteData(source: string, selection: SiteSelection) {
  const { cdp, endpoint } = await connect(source);
  try { return { revision: (await observe(cdp, selection, endpoint)).revision }; } finally { cdp.close(); }
}
export async function clearSiteData(source: string, selection: SiteSelection, expected: string, progress: (outcomes: StateOutcome[]) => void) {
  const { cdp, endpoint } = await connect(source), outcomes: StateOutcome[] = [];
  let targetId: string | null = null;
  try {
    const before = await observe(cdp, selection, endpoint); if (before.revision !== expected) throw new Error("Site observations changed before dispatch");
    let sessionId: string | undefined;
    if (selection.categories.includes("cookies")) {
      targetId = (await cdp.call("Target.createTarget", { url: "about:blank" })).targetId;
      sessionId = (await cdp.call("Target.attachToTarget", { targetId, flatten: true })).sessionId;
      for (const cookie of before.cookies) await cdp.call("Network.deleteCookies", cookie, sessionId);
      const remaining: Cookie[] = (await cdp.call("Storage.getCookies")).cookies;
      if (remaining.some(cookie => selectedCookie(cookie, selection.origins))) throw new Error("Selected cookies remain or were recreated; purge outcome is unknown");
      outcomes.push(...selection.origins.map(origin => ({ resource: `${origin}:cookies`, outcome: "removed" as const, detail: "Exact observed domain/path/partition cookie identities removed; domain cookies are shared across matching subdomains/ports" }))); progress(outcomes);
    }
    for (const origin of selection.origins) for (const category of selection.categories) {
      if (category === "cookies" || category === "history") continue;
      const storageTypes = category === "cache" ? "cache_storage" : "local_storage,indexeddb,websql,file_systems,service_workers";
      await cdp.call("Storage.clearDataForOrigin", { origin, storageTypes });
      const after = await cdp.call("Storage.getUsageAndQuota", { origin });
      const selectedTypes = new Set(storageTypes.split(","));
      if (typeof after.usage !== "number" || !Array.isArray(after.usageBreakdown)
        || after.usageBreakdown.some((entry: { storageType: string; usage: number }) => selectedTypes.has(entry.storageType) && entry.usage !== 0)
        || after.usage > 0 && !after.usageBreakdown.some((entry: { storageType: string }) => selectedTypes.has(entry.storageType))) throw new Error("Scoped storage absence cannot be verified or data was recreated");
      outcomes.push({ resource: `${origin}:${category}`, outcome: "removed", detail: `Scoped ${storageTypes} command and quota-usage absence verified; local-storage values and concurrent writers are not an atomic erasure guarantee` }); progress(outcomes);
    }
    return outcomes;
  } finally {
    if (targetId) try { if ((await cdp.call("Target.closeTarget", { targetId })).success !== true) throw new Error("Blank target closure refused"); } catch { outcomes.push({ resource: targetId, outcome: "unknown", detail: "Maintenance-created blank target closure was not verified" }); progress(outcomes); }
    cdp.close();
  }
}
