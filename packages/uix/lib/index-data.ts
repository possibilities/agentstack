import type { Bot as StackBot, OwnerStatus } from "./stack/types";

export type Child = Pick<OwnerStatus["children"][number], "name" | "pid" | "running">;
export type Owner = Pick<OwnerStatus, "docsUrl" | "uixUrl" | "inspectorUrl" | "mcpUrls"> & { children: Child[] };
export type Bot = Pick<StackBot, "id" | "pid" | "cwd" | "url" | "state" | "recoveryIssue">;

export type IndexData = {
  owner: Owner | null;
  bots: Bot[] | null;
  links: { name: string; url: string }[];
  mcp: [string, string][];
  children: Child[];
};

export function indexData(owner: Owner | null, allBots: Bot[] | null): IndexData {
  const bots = allBots?.filter((bot) => bot.state === "running") ?? null;
  const links = owner ? [
    { name: "UI canvas", url: owner.uixUrl },
    { name: "Package API reference", url: owner.docsUrl },
    { name: "MCP Inspector", url: owner.children.some((child) => child.name === "inspector" && child.running) ? owner.inspectorUrl : null },
  ].filter((entry): entry is { name: string; url: string } => entry.url !== null) : [];
  const mcp = Object.entries(owner?.mcpUrls ?? {}).sort(([a], [b]) => a.localeCompare(b));
  const children = owner?.children.filter((child) => child.running) ?? [];
  return { owner, bots, links, mcp, children };
}
