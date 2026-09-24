import type { IndexData } from "./status";

const code = (value: unknown): string => `\`${String(value ?? "")}\``;

export function renderIndexMarkdown({ owner, servers, links, mcp, children }: IndexData): string {
  const lines = [
    "# AgentStack", "",
    "Local links and Server processes.", "",
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
    "## Codex Servers", "",
    ...(servers === null
      ? ["Server list unavailable.", ""]
      : servers.length === 0
        ? ["No running Codex Servers.", ""]
        : servers.flatMap((server) => [
            `- **${server.id}** — ${server.recoveryIssue ? "Needs inspection (reported running state unverified)" : "Running"} · PID ${server.pid}`,
            ...(server.recoveryIssue ? [`  - Recovery: ${server.recoveryIssue}`] : []),
            `  - ${code(server.cwd)}`,
            ...(server.url ? [`  - ${code(server.url)}`] : []),
            "",
          ])),
  ];
  return lines.join("\n");
}
