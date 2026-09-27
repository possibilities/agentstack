#!/usr/bin/env node
import { socketCall, socketPath } from "@agentstack/api";

const protocol = "agent-browser.plugin.v1";
type Request = { protocol: string; type: string; capability: string; request: Record<string, unknown> };

export async function handleProvider(source: string, env: NodeJS.ProcessEnv = process.env,
  call: typeof socketCall = socketCall): Promise<Record<string, unknown>> {
  try {
    if (Buffer.byteLength(source) > 1024 * 1024) throw new Error("provider request too large");
    const input = JSON.parse(source) as Request;
    if (!input || input.protocol !== protocol || input.capability !== (input.type === "plugin.manifest" ? "plugin.manifest" : "browser.provider") ||
        !input.request || typeof input.request !== "object" || Array.isArray(input.request)) throw new Error("invalid provider request");
    if (input.type === "plugin.manifest") return { protocol, success: true,
      manifest: { name: "agentstack", capabilities: ["browser.provider"], description: "AgentStack disposable Hypeman browsers" } };
    const socket = socketPath("browser", env);
    // A running owner can retain the previous AgentBrowse-backed socket across
    // a build. Never let a newly selected global provider route to that old
    // process (which may fall back to Artbird) before an authorized restart.
    const status = await call(socket, "tools/call", { name: "browser_status", arguments: {} }, { timeoutMs: 3000 }) as { provider?: string };
    if (status.provider !== "hypeman") throw new Error("browser owner has not loaded the local-only Hypeman backend");
    if (input.type === "browser.launch") {
      const session = input.request.session;
      if (typeof session !== "string" || !session || session.length > 128) throw new Error("invalid session");
      const launch = await call(socket, "tools/call", { name: "browser_session_launch", arguments: { session } }, { timeoutMs: 55_000 }) as { cdpUrl: string; cleanup: unknown };
      return { protocol, success: true, browser: { cdpUrl: launch.cdpUrl, directPage: false, cleanup: launch.cleanup } };
    }
    if (input.type === "browser.close") {
      await call(socket, "tools/call", { name: "browser_session_close", arguments: { cleanup: input.request } }, { timeoutMs: 12_000 });
      return { protocol, success: true, data: { closed: true } };
    }
    throw new Error("unsupported provider operation");
  } catch (error) {
    return { protocol, success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  let source = "";
  for await (const chunk of process.stdin) {
    source += chunk.toString();
    if (source.length > 1024 * 1024) break;
  }
  process.stdout.write(`${JSON.stringify(await handleProvider(source))}\n`);
}
