import { annotationBadges, operationTitle } from "./catalog";
import { accountLabels, serversFor, shortId } from "./derive";
import type { Resource, Server, Snapshot } from "./types";

const code = (value: unknown): string => `\`${String(value ?? "")}\``;

function section<T>(title: string, resource: Resource<T>, render: (data: T) => string[]): string[] {
  return [`## ${title}`, "", ...(resource.data === null ? [`Unavailable: ${resource.error ?? "no data"}.`, ""] : render(resource.data))];
}

export function renderCanvasMarkdown(snapshot: Snapshot): string {
  const { owner, accounts, login, servers, bots, catalog, endpoints } = snapshot;
  const labels = accountLabels(accounts.data);
  const label = (id: string | null) => (id ? labels.get(id) ?? shortId(id) : "unbound");
  const server = (item: Server) => [
    `- **${item.id}** — ${item.recoveryIssue ? "needs inspection (reported running state unverified)" : item.state}${item.pid ? ` · pid ${item.pid}` : ""} · account ${label(item.account)}`,
    ...(item.recoveryIssue ? [`  - Recovery: ${item.recoveryIssue}`] : []),
    ...(item.state === "running" && !item.recoveryIssue && item.account !== item.runningAccount ? [`  - Running as ${label(item.runningAccount)}; stop and start to apply ${label(item.account)}`] : []),
    `  - Main thread ${code(item.mainThreadId ?? "awaiting first turn")}`,
    `  - Workspace ${code(item.cwd)}`,
    ...(item.url ? [`  - Endpoint ${code(item.url)}`] : []),
  ];

  return [
    "# AgentStack canvas", "",
    "A live view of every Package API. The HTML page reads the same state over WebSocket, refreshes on change notices, and can also run the auth API's operations (sign-in, activation, removal).", "",
    ...section("System", owner, (data) => [
      `Owner pid ${data.pid} · ${data.children.filter((child) => child.running).length}/${data.children.length} children running.`, "",
      ...data.children.map((child) => `- **${child.name}** — ${child.running ? `running · pid ${child.pid}` : `stopped${child.exitCode !== null ? ` · exit ${child.exitCode}` : ""}${child.signal ? ` · ${child.signal}` : ""}${child.error ? ` · ${child.error}` : ""}`}`),
      "",
      ...Object.entries(data.mcpUrls).sort(([a], [b]) => a.localeCompare(b)).map(([name, url]) => `- MCP **${name}** — ${code(url)}`),
      "",
    ]),
    ...section("Accounts", accounts, (data) => [
      ...(login.data ? [`Sign-in ${login.data.status}${login.data.targetAccount ? ` for ${label(login.data.targetAccount)}` : ""}${login.data.error ? ` — ${login.data.error}` : ""}.`, ""] : []),
      ...(data.length ? data.map((account) => {
        const bound = serversFor(account.id, servers.data).map((item) => item.id);
        return `- **${label(account.id)}** — ${code(account.id)}${account.active ? " · active" : ""}${account.removing ? " · removing" : ""}${bound.length ? ` · ${bound.join(", ")}` : ""}`;
      }) : ["No Codex accounts."]),
      "",
    ]),
    ...section("Servers", servers, (data) => [...(data.length ? data.flatMap(server) : ["No Codex Servers."]), ""]),
    ...section("Bots", bots, (data) => [...(data.length ? data.flatMap((bot) => [
      `- **${bot.id}** — ${bot.recoveryIssue ? "needs inspection (reported running state unverified)" : bot.state} · account ${label(bot.account)} · main thread ${code(bot.mainThreadId ?? "awaiting first turn")} · ${code(bot.cwd)}`,
      ...(bot.recoveryIssue ? [`  - Recovery: ${bot.recoveryIssue}`] : []),
    ]) : ["No bots."]), ""]),
    ...section("API", catalog, (data) => data.flatMap((doc) => [
      `### ${doc.name}`, "",
      `${doc.description} ${code(doc.packageName)}`, "",
      ...(endpoints[doc.name] ? [`WebSocket ${code(endpoints[doc.name])}`, ""] : []),
      ...doc.operations.map((operation) => {
        const badges = annotationBadges(operation).map((badge) => badge.label);
        return `- ${code(operation.name)} — ${operationTitle(operation)}${badges.length ? ` (${badges.join(", ")})` : ""}`;
      }),
      ...Object.entries(doc.events).map(([topic, description]) => `- event ${code(topic)} — ${description}`),
      "",
    ])),
  ].join("\n");
}
