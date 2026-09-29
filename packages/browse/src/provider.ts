#!/usr/bin/env node
import { socketCall, socketPath } from "@stack/api";

const protocol = "agent-browser.plugin.v1";
type Request = { protocol: string; type: string; capability: string; request: Record<string, unknown> };

export async function handleProvider(source: string, env: NodeJS.ProcessEnv = process.env,
  call: typeof socketCall = socketCall, identity?: string): Promise<Record<string, unknown>> {
  try {
    if (Buffer.byteLength(source) > 1024 * 1024) throw new Error("provider request too large");
    const input = JSON.parse(source) as Request;
    if (!input || input.protocol !== protocol || input.capability !== (input.type === "plugin.manifest" ? "plugin.manifest" : "browser.provider") ||
        !input.request || typeof input.request !== "object" || Array.isArray(input.request)) throw new Error("invalid provider request");
    if (input.type === "plugin.manifest") return { protocol, success: true,
      manifest: { name: "stack", capabilities: ["browser.provider"], description: "Stack durable Bot browsers" } };
    const socket = socketPath("browse", env);
    if (input.type === "browser.close") {
      // Disconnect belongs to agent-browser, not to an available owner socket.
      // This is only a last-observation notice: no browser or profile is released.
      // In particular planned owner drain must not strand the native daemon when
      // public ingress has already closed.
      await call(socket, "tools/call", { name: "browser_controller_close", arguments: input.request }, { timeoutMs: 3000 }).catch(() => undefined);
      return { protocol, success: true, data: { closed: true } };
    }
    // A running owner can retain the previous AgentBrowse-backed socket across
    // a build. Never let a newly selected global provider route to that old
    // process (which may fall back to Artbird) before an authorized restart.
    const status = await call(socket, "tools/call", { name: "browser_status", arguments: {} }, { timeoutMs: 3000 }) as { provider?: string };
    if (status.provider !== "hypeman") throw new Error("browser owner has not loaded the local-only Hypeman backend");
    if (input.type === "browser.launch") {
      const session = input.request.session;
      if (typeof session !== "string" || !session || session.length > 128) throw new Error("invalid session");
      if (!identity) throw new Error("browser provider requires a private Bot launch configuration; session is not Bot identity");
      const launch = await call(socket, "tools/call", { name: "browser_controller_launch", arguments: { identity, session } }, { timeoutMs: 55_000 }) as { cdpUrl: string; cleanup: unknown };
      return { protocol, success: true, browser: { cdpUrl: launch.cdpUrl, directPage: false, cleanup: launch.cleanup } };
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
  process.stdout.write(`${JSON.stringify(await handleProvider(source, process.env, socketCall, process.argv[2]))}\n`);
}
