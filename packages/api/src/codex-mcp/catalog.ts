/** Stack-owned connection names, independent of the installed upstream tool catalog. */
export const codexMcpServers = [
  { name: "computer-use", title: "Computer Use", upstream: "Codex REPL Computer Use module", description: "Control native Mac applications through the installed Codex Computer Use runtime. Read app state before acting; native approvals remain in force.", server: "node_repl", surface: "computer" },
  { name: "chrome", title: "Chrome", upstream: "Codex REPL and the Chrome browser plugin", description: "Control the human's signed-in Chrome browser through the installed Codex browser plugin. This is separate from Stack's managed Browser profiles.", server: "node_repl", surface: "chrome" },
  { name: "messages", title: "Messages", upstream: "Codex messages plugin", description: "Read, search and send iMessage/SMS using the installed Codex Messages plugin and its native approvals.", server: "messages" },
  { name: "computer-history", title: "Computer History", upstream: "Codex computer-history plugin", description: "Read recent on-screen activity through Codex Computer History. Requires that plugin and Computer History to be enabled in the desktop app.", server: "computer-history" },
  { name: "openai-developer-docs", title: "OpenAI Developer Docs", upstream: "Codex openaiDeveloperDocs plugin", description: "Search and read OpenAI developer documentation, API reference and OpenAPI specifications through Codex.", server: "openaiDeveloperDocs" },
] as const;

export type CodexMcpName = typeof codexMcpServers[number]["name"];
export type CodexMcpDefinition = typeof codexMcpServers[number];
export const codexMcpDefinition = (name: string | undefined) => codexMcpServers.find((item) => item.name === name);
