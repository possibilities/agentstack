import { socketCall, socketPath } from "@agentstack/api";

export type Child = { name: string; pid: number | null; running: boolean };
export type Owner = {
  docsUrl: string | null;
  uixUrl: string | null;
  inspectorUrl: string | null;
  mcpUrls: Record<string, string>;
  children: Child[];
};
export type Bot = { id: string; pid: number | null; cwd: string; url: string | null; state: "running" | "stopped"; recoveryIssue: string | null };

export type IndexData = {
  owner: Owner | null;
  bots: Bot[] | null;
  links: { name: string; url: string }[];
  mcp: [string, string][];
  children: Child[];
};

export async function loadIndex(): Promise<IndexData> {
  const [ownerResult, botsResult] = await Promise.allSettled([
    socketCall(socketPath("owner"), "tools/call", { name: "owner_status", arguments: {} }, { timeoutMs: 1_500 }) as Promise<Owner>,
    socketCall(socketPath("bots"), "tools/call", { name: "bot_list", arguments: {} }, { timeoutMs: 1_500 }) as Promise<{ bots: Bot[] }>,
  ]);
  const owner = ownerResult.status === "fulfilled" ? ownerResult.value : null;
  const bots = botsResult.status === "fulfilled" ? botsResult.value.bots.filter((bot) => bot.state === "running") : null;
  const links = owner ? [
    { name: "UI canvas", url: owner.uixUrl },
    { name: "Package API reference", url: owner.docsUrl },
    { name: "MCP Inspector", url: owner.children.some((child) => child.name === "inspector" && child.running) ? owner.inspectorUrl : null },
  ].filter((entry): entry is { name: string; url: string } => entry.url !== null) : [];
  const mcp = Object.entries(owner?.mcpUrls ?? {}).sort(([a], [b]) => a.localeCompare(b));
  const children = owner?.children.filter((child) => child.running) ?? [];
  return { owner, bots, links, mcp, children };
}
