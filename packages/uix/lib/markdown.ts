import type { IndexData } from "./status";

const code = (value: unknown): string => `\`${String(value ?? "")}\``;

export function renderIndexMarkdown({ owner, bots, links, mcp, children }: IndexData): string {
  const lines = [
    "# AgentStack", "",
    "Local links and bot processes.", "",
    "## Open", "",
    ...(owner === null
      ? ["Owner status unavailable.", ""]
      : links.length === 0
        ? ["No links available.", ""]
        : [...links.map(({ name, url }) => `- [${name}](${url}) — ${code(url)}`), ""]),
    "## Package API URLs", "",
    ...(mcp.length ? [...mcp.map(([name, url]) => `- **${name}** — ${code(url)}`), ""] : ["No MCP URLs available.", ""]),
    "## Owner processes", "",
    ...(children.length ? [...children.map((child) => `- **${child.name}** — Running · PID ${child.pid}`), ""] : ["No running owner processes.", ""]),
    "## Bots", "",
    ...(bots === null
      ? ["Bot list unavailable.", ""]
      : bots.length === 0
        ? ["No running bots.", ""]
        : bots.flatMap((bot) => [
            `- **${bot.id}** — ${bot.recoveryIssue ? "Needs inspection (reported running state unverified)" : "Running"} · PID ${bot.pid}`,
            ...(bot.recoveryIssue ? [`  - Recovery: ${bot.recoveryIssue}`] : []),
            `  - ${code(bot.cwd)}`,
            ...(bot.url ? [`  - ${code(bot.url)}`] : []),
            "",
          ])),
  ];
  return lines.join("\n");
}
