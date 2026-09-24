import { annotationBadges, operationTitle } from "./catalog";
import { accountLabels, botsFor, shortId } from "./derive";
import type { Resource, Snapshot } from "./types";

const code = (value: unknown): string => `\`${String(value ?? "")}\``;

function section<T>(title: string, resource: Resource<T>, render: (data: T) => string[]): string[] {
  return [`## ${title}`, "", ...(resource.data === null ? [`Unavailable: ${resource.error ?? "no data"}.`, ""] : render(resource.data))];
}

export function renderCanvasMarkdown(snapshot: Snapshot): string {
  const { owner, accounts, login, bots, voice, catalog, endpoints } = snapshot;
  const labels = accountLabels(accounts.data);
  const label = (id: string | null) => (id ? labels.get(id) ?? shortId(id) : "unbound");

  return [
    "# AgentStack canvas", "",
    "A live view of every Package API. The HTML canvas operates account sign-in and full-duplex voice calls to existing bot main threads. This markdown twin reports their state.", "",
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
        const bound = botsFor(account.id, bots.data).map((item) => item.id);
        return `- **${label(account.id)}** — ${code(account.id)}${account.active ? " · active" : ""}${account.removing ? " · removing" : ""}${bound.length ? ` · ${bound.join(", ")}` : ""}`;
      }) : ["No Codex accounts."]),
      "",
    ]),
    ...section("Bots", bots, (data) => [...(data.length ? data.flatMap((bot) => [
      `- **${bot.id}** — ${bot.recoveryIssue ? "needs inspection (reported running state unverified)" : bot.state}${bot.pid ? ` · pid ${bot.pid}` : ""} · account ${label(bot.account)}`,
      ...(bot.recoveryIssue ? [`  - Recovery: ${bot.recoveryIssue}`] : []),
      ...(bot.state === "running" && !bot.recoveryIssue && bot.account !== bot.runningAccount ? [`  - Running as ${label(bot.runningAccount)}; stop and start to apply ${label(bot.account)}`] : []),
      `  - Main thread ${code(bot.mainThreadId ?? "awaiting first turn")}`,
      `  - Last launched role revision ${code(bot.roleRevision ?? "never launched")}`,
      `  - Workspace ${code(bot.cwd)}`,
      ...(bot.url ? [`  - Endpoint ${code(bot.url)}`] : []),
    ]) : ["No bots."]), ""]),
    "## Voice", "", voice.error ? `Unavailable: ${voice.error}.` : voice.data ? `Call ${code(voice.data.sessionId)} · ${voice.data.phase} · Bot ${code(voice.data.botId)} · main thread ${code(voice.data.threadId)}` : "No active voice call.", "",
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
