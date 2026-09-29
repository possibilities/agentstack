import type { CodexMcpDefinition } from "./catalog.js";
import { CodexRpc, record } from "./rpc.js";

/** Starts the ephemeral tool thread; no inference turn is ever started on it. */
export async function startToolThread(rpc: CodexRpc, signal?: AbortSignal, timeoutMs?: number): Promise<string> {
  await rpc.request("initialize", { clientInfo: { name: "stack-codex-tools", version: "0.0.0" }, capabilities: { mcpServerOpenaiFormElicitation: true, extensions: { "openai/form": {}, "openai/standard-form-input": {} } } }, signal, timeoutMs);
  rpc.notify("initialized");
  const started = await rpc.request("thread/start", { ephemeral: true, approvalPolicy: "on-request", sessionStartSource: "startup" }, signal, timeoutMs);
  if (!record(started) || !record(started.thread) || typeof started.thread.id !== "string") throw new Error("Invalid Codex tool thread response");
  return started.thread.id;
}

export async function upstreamServers(rpc: CodexRpc, threadId: string, signal?: AbortSignal, timeoutMs?: number): Promise<Record<string, any>[]> {
  const servers: Record<string, any>[] = [];
  let cursor: string | undefined;
  const cursors = new Set<string>();
  for (let page = 0; page < 32; page++) {
    const result = await rpc.request("mcpServerStatus/list", { threadId, detail: "toolsAndAuthOnly", ...(cursor ? { cursor } : {}) }, signal, timeoutMs);
    if (!record(result) || !Array.isArray(result.data) || !result.data.every(record)) throw new Error("Invalid Codex tool catalog");
    servers.push(...result.data);
    if (result.nextCursor == null) break;
    if (typeof result.nextCursor !== "string" || cursors.has(result.nextCursor) || page === 31) throw new Error("Invalid Codex tool catalog pagination");
    cursor = result.nextCursor; cursors.add(cursor);
  }
  return servers;
}

/** The live upstream entry that serves a connection, or undefined when the installation does not offer it. */
export function selectUpstream(definition: CodexMcpDefinition, servers: Record<string, any>[]): Record<string, any> | undefined {
  // Both runtime generations still support the bundled trusted module imports.
  const upstream = "surface" in definition
    ? servers.find((s) => s.name === "node_repl" && record(s.tools) && s.tools.js) ?? servers.find((s) => s.name === "cua_repl" && record(s.tools) && s.tools.js)
    : servers.find((s) => s.name === definition.server);
  if (!upstream || !record(upstream.tools) || !Object.keys(upstream.tools).length || upstream.runtimeStatus === "disabled" || upstream.runtimeStatus === "failed") return undefined;
  return upstream;
}
