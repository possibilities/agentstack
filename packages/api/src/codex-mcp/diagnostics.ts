import { codexMcpServers, type CodexMcpDefinition, type CodexMcpName } from "./catalog.js";
import { browserModule, codexInstallation, CodexInstallationError, type CodexRuntimeSource } from "./install.js";
import { chromeBrowserProbe, projectedTools } from "./projections.js";
import { CodexRpc, record } from "./rpc.js";
import { selectUpstream, startToolThread, upstreamServers } from "./upstream.js";

export type CodexToolsProblemCode = "runtime_missing" | "config_invalid" | "plugin_unavailable" | "browser_module_missing" | "no_browser" | "multiple_browsers"
  | "approval_required" | "probe_failed" | "probe_timeout";
/** Sanitized: never a path, credential, signed URL or raw runtime diagnostic. */
export type CodexToolsProblem = { code: CodexToolsProblemCode; message: string; recovery: string };
export type CodexToolsRuntime = { state: "not_checked" | "found" | "missing" | "invalid"; source: CodexRuntimeSource | null; checkedAt: string | null; problem: CodexToolsProblem | null };
export type CodexToolsCatalog = { state: "not_checked" | "available" | "unavailable" | "failed"; checkedAt: string | null; tools: number | null; evidence: string | null; problem: CodexToolsProblem | null };
export type CodexToolsBrowser = { state: "not_checked" | "connected" | "none" | "multiple" | "failed"; checkedAt: string | null; evidence: string | null; problem: CodexToolsProblem | null };
export type CodexToolsConnection = { name: CodexMcpName; title: string; description: string; upstream: string; catalog: CodexToolsCatalog;
  /** Chrome only: whether the extension exposed exactly one Chrome browser when last asked. */
  browser: CodexToolsBrowser | null };
export type CodexToolsStatus = {
  checking: { startedAt: string; chromeBrowser: boolean } | null;
  checkedAt: string | null;
  runtime: CodexToolsRuntime;
  connections: CodexToolsConnection[];
};

const recovery: Record<CodexToolsProblemCode, string> = {
  runtime_missing: "Install the ChatGPT or Codex desktop app, or set STACK_CODEX_TOOLS_BIN and STACK_CODEX_TOOLS_HOME on the Stack server, then check again.",
  config_invalid: "Set STACK_CODEX_TOOLS_BIN and STACK_CODEX_TOOLS_HOME to absolute paths on the Stack server, restart it, then check again.",
  plugin_unavailable: "Install and enable this plugin in the desktop app's selected installation, then check again. Existing sessions must reconnect.",
  browser_module_missing: "Enable the Chrome (browser) plugin in the desktop app and install the ChatGPT Chrome extension, then check again.",
  no_browser: "Open Chrome with the ChatGPT extension signed in and connected to the desktop app, then check the browser again.",
  multiple_browsers: "Leave exactly one Chrome profile connected through the ChatGPT extension, then check the browser again.",
  approval_required: "Stack's diagnostic cannot answer approvals. Use the connection from a Bot or Worker whose client can answer them.",
  probe_failed: "Check that the desktop app runs and its selected installation is signed in, then check again.",
  probe_timeout: "The desktop runtime did not answer in time. Check that the app is responsive, then check again.",
};
const problem = (code: CodexToolsProblemCode, message: string): CodexToolsProblem => ({ code, message, recovery: recovery[code] });
const notChecked = (): CodexToolsCatalog => ({ state: "not_checked", checkedAt: null, tools: null, evidence: null, problem: null });
const browserNotChecked = (): CodexToolsBrowser => ({ state: "not_checked", checkedAt: null, evidence: null, problem: null });
const stageTimeoutMs = 30_000;

/**
 * Server-wide observations of the selected desktop installation. Reads are cached; only an explicit
 * check starts one temporary app-server, which lists catalogs on an ephemeral thread, starts no model
 * turn, and is closed before the check completes. Consumer connections and approvals are not observed.
 */
export class CodexToolsDiagnostics {
  private status: CodexToolsStatus = {
    checking: null, checkedAt: null,
    runtime: { state: "not_checked", source: null, checkedAt: null, problem: null },
    connections: codexMcpServers.map((definition) => ({ name: definition.name, title: definition.title, description: definition.description, upstream: definition.upstream,
      catalog: notChecked(), browser: definition.name === "chrome" ? browserNotChecked() : null })),
  };
  private running?: Promise<void>;
  private rpc?: CodexRpc;
  private closed = false;
  onChange: (() => void) | undefined;
  constructor(private env: NodeJS.ProcessEnv) {}

  snapshot(): CodexToolsStatus { return structuredClone(this.status); }

  /** Single-flight: a request while a check runs joins it instead of starting another runtime. */
  check(options: { chromeBrowser?: boolean } = {}): { admitted: boolean; status: CodexToolsStatus } {
    if (this.closed) throw new Error("Codex tools diagnostics are closed");
    if (this.running) return { admitted: false, status: this.snapshot() };
    this.status.checking = { startedAt: new Date().toISOString(), chromeBrowser: !!options.chromeBrowser };
    this.running = this.run(!!options.chromeBrowser).finally(() => { this.running = undefined; this.status.checking = null; this.onChange?.(); });
    this.onChange?.();
    return { admitted: true, status: this.snapshot() };
  }

  /** Resolves when the current check, if any, has recorded its result. */
  async settled(): Promise<void> { await this.running; }

  private async run(chromeBrowser: boolean) {
    const now = () => new Date().toISOString();
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), 3 * stageTimeoutMs);
    timer.unref();
    let installation: Awaited<ReturnType<typeof codexInstallation>>;
    try { installation = await codexInstallation(this.env); }
    catch (error) {
      const code = error instanceof CodexInstallationError && error.code === "config_invalid" ? "config_invalid" : "runtime_missing";
      const found = problem(code, error instanceof Error ? error.message : "Codex tools runtime unavailable");
      const at = now();
      this.status.runtime = { state: code === "config_invalid" ? "invalid" : "missing", source: null, checkedAt: at, problem: found };
      this.everyConnection(() => ({ state: "unavailable", checkedAt: at, tools: null, evidence: "No usable Codex tools runtime was found.", problem: found }), () => ({ state: "not_checked", checkedAt: null, evidence: null, problem: null }));
      this.status.checkedAt = at;
      clearTimeout(timer);
      return;
    }
    this.status.runtime = { state: "found", source: installation.source, checkedAt: now(), problem: null };
    const modulePath = await browserModule(installation.home).catch(() => undefined);
    const rpc = this.rpc = new CodexRpc(installation.binary, installation.home, this.env);
    let elicited = false;
    // A diagnostic has no human to ask; any approval is cancelled and reported.
    rpc.onElicitation = async () => { elicited = true; return { action: "cancel" }; };
    try {
      const threadId = await startToolThread(rpc, timeout.signal, stageTimeoutMs);
      const servers = await upstreamServers(rpc, threadId, timeout.signal, stageTimeoutMs);
      const at = now();
      const upstreams = new Map<CodexMcpName, Record<string, any> | undefined>();
      for (const connection of this.status.connections) {
        const definition = codexMcpServers.find((item) => item.name === connection.name)!;
        const upstream = selectUpstream(definition, servers);
        upstreams.set(connection.name, upstream);
        connection.catalog = catalogObservation(definition, upstream, modulePath, at);
        if (connection.browser && connection.catalog.state !== "available") connection.browser = browserNotChecked();
      }
      const chrome = this.status.connections.find((item) => item.name === "chrome")!;
      if (chromeBrowser && chrome.catalog.state === "available" && modulePath) {
        chrome.browser = await this.browser(rpc, threadId, upstreams.get("chrome")!.name, modulePath, timeout.signal, () => elicited);
      }
      this.status.checkedAt = now();
    } catch (error) {
      const at = now();
      const found = timeout.signal.aborted || /timed out/.test(error instanceof Error ? error.message : "")
        ? problem("probe_timeout", "The Codex tools runtime did not answer the catalog check in time.")
        : problem("probe_failed", "The Codex tools runtime could not list its tool catalog.");
      // A failed refresh replaces every earlier result; stale availability must not look current.
      this.everyConnection(() => ({ state: "failed", checkedAt: at, tools: null, evidence: null, problem: found }), () => ({ state: "failed", checkedAt: at, evidence: null, problem: found }), chromeBrowser);
      this.status.checkedAt = at;
    } finally {
      clearTimeout(timer);
      this.rpc = undefined;
      await rpc.close();
    }
  }

  private async browser(rpc: CodexRpc, threadId: string, server: string, modulePath: string, signal: AbortSignal, elicited: () => boolean): Promise<CodexToolsBrowser> {
    const failed = (found: CodexToolsProblem): CodexToolsBrowser => ({ state: "failed", checkedAt: new Date().toISOString(), evidence: null, problem: found });
    let count: number | undefined;
    try {
      const result = await rpc.request("mcpServer/tool/call", { threadId, server, tool: "js",
        arguments: { code: chromeBrowserProbe(modulePath), title: "stack diagnostics: list Chrome browsers", timeout_ms: 20_000 } }, signal, stageTimeoutMs);
      if (record(result) && result.isError !== true && Array.isArray(result.content)) {
        for (const block of result.content) {
          if (!record(block) || block.type !== "text" || typeof block.text !== "string") continue;
          try { const parsed = JSON.parse(block.text); if (record(parsed) && Number.isInteger(parsed.chromeBrowsers)) count = parsed.chromeBrowsers; } catch { /* not the probe's line */ }
        }
      }
    } catch (error) {
      if (signal.aborted || /timed out/.test(error instanceof Error ? error.message : "")) return failed(problem("probe_timeout", "Chrome browser discovery did not answer in time."));
    }
    if (count === undefined) return failed(elicited()
      ? problem("approval_required", "Chrome browser discovery asked for an approval, which the diagnostic cancelled.")
      : problem("probe_failed", "Chrome browser discovery failed."));
    const at = new Date().toISOString();
    const evidence = `The Chrome extension listed ${count} Chrome browser${count === 1 ? "" : "s"}. No tab or page was read.`;
    if (count === 1) return { state: "connected", checkedAt: at, evidence, problem: null };
    return count === 0
      ? { state: "none", checkedAt: at, evidence, problem: problem("no_browser", "No Chrome browser is connected through the ChatGPT extension.") }
      : { state: "multiple", checkedAt: at, evidence, problem: problem("multiple_browsers", `${count} Chrome browsers are connected; the Chrome connection needs exactly one.`) };
  }

  private everyConnection(catalog: () => CodexToolsCatalog, browser: () => CodexToolsBrowser, replaceBrowser = true) {
    for (const connection of this.status.connections) {
      connection.catalog = catalog();
      if (connection.browser) connection.browser = replaceBrowser ? browser() : browserNotChecked();
    }
  }

  async close() {
    this.closed = true;
    await this.rpc?.close();
    await this.running?.catch(() => {});
  }
}

function catalogObservation(definition: CodexMcpDefinition, upstream: Record<string, any> | undefined, modulePath: string | undefined, at: string): CodexToolsCatalog {
  if (!upstream) {
    const extra = definition.name === "computer-history" ? " Computer History also needs recording enabled." : "";
    return { state: "unavailable", checkedAt: at, tools: null, evidence: `The selected installation's live catalog has no usable ${definition.server} server.`,
      problem: problem("plugin_unavailable", `${definition.title} is not in the selected installation's live tool catalog.${extra}`) };
  }
  const tools = Object.keys(upstream.tools).length;
  if (definition.name === "chrome" && !modulePath) {
    return { state: "unavailable", checkedAt: at, tools: null, evidence: `${upstream.name} is listed, but no Chrome browser client module is installed.`,
      problem: problem("browser_module_missing", "The Chrome browser plugin's client module is not installed.") };
  }
  const evidence = "surface" in definition
    ? `${upstream.name} listed its js tool${definition.name === "chrome" ? " and the Chrome browser client module is installed" : ""}. No desktop action was taken.`
    : `${upstream.name} listed ${tools} tool${tools === 1 ? "" : "s"}. No tool was called.`;
  return { state: "available", checkedAt: at, tools: "surface" in definition ? projectedTools(definition.surface).length : tools, evidence, problem: null };
}
