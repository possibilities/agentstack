import { socketCall, socketPath } from "@agentstack/api";

export const dynamic = "force-dynamic";

type Child = { name: string; pid: number | null; running: boolean };
type Owner = {
  docsUrl: string | null;
  uixUrl: string | null;
  inspectorUrl: string | null;
  mcpUrls: Record<string, string>;
  children: Child[];
};
type Server = { id: string; pid: number | null; cwd: string; url: string | null; state: "running" | "stopped" };

export default async function Page() {
  const [ownerResult, serversResult] = await Promise.allSettled([
    socketCall(socketPath("owner"), "tools/call", { name: "owner_status", arguments: {} }, { timeoutMs: 1_500 }) as Promise<Owner>,
    socketCall(socketPath("codex"), "tools/call", { name: "server_list", arguments: {} }, { timeoutMs: 1_500 }) as Promise<{ servers: Server[] }>,
  ]);
  const owner = ownerResult.status === "fulfilled" ? ownerResult.value : null;
  const servers = serversResult.status === "fulfilled" ? serversResult.value.servers.filter((server) => server.state === "running") : null;
  const links = owner ? [
    { name: "UI canvas", url: owner.uixUrl },
    { name: "Package API reference", url: owner.docsUrl },
    { name: "MCP Inspector", url: owner.children.some((child) => child.name === "inspector" && child.running) ? owner.inspectorUrl : null },
  ].filter((entry): entry is { name: string; url: string } => entry.url !== null) : [];
  const mcp = Object.entries(owner?.mcpUrls ?? {}).sort(([a], [b]) => a.localeCompare(b));
  const children = owner?.children.filter((child) => child.running) ?? [];

  return (
    <main className="mx-auto flex min-h-dvh max-w-4xl flex-col gap-12 px-6 py-12 sm:px-10 sm:py-16">
      <header className="flex flex-wrap items-end justify-between gap-6">
        <div className="flex flex-col gap-2">
          <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">AgentStack</h1>
          <p className="text-muted-foreground">Local links and running Servers.</p>
        </div>
        <a className="text-sm underline underline-offset-4 hover:text-muted-foreground focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring" href="/">Refresh</a>
      </header>

      <section aria-labelledby="links-heading" className="flex flex-col gap-4">
        <h2 id="links-heading" className="text-xl font-medium">Open</h2>
        {owner ? links.length > 0 ? (
          <ul className="divide-y divide-border border-t border-border">
            {links.map(({ name, url }) => (
              <li key={name} className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 py-4">
                <a className="font-medium underline underline-offset-4 hover:text-muted-foreground focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring" href={url}>{name}</a>
                <code className="break-all text-sm text-muted-foreground">{url}</code>
              </li>
            ))}
          </ul>
        ) : <p className="text-muted-foreground">No links available.</p> : <p role="status" className="text-muted-foreground">Owner status unavailable.</p>}
      </section>

      <section aria-labelledby="mcp-heading" className="flex flex-col gap-4">
        <h2 id="mcp-heading" className="text-xl font-medium">Package API URLs</h2>
        {mcp.length > 0 ? (
          <ul className="divide-y divide-border border-t border-border">
            {mcp.map(([name, url]) => (
              <li key={name} className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 py-3">
                <span className="font-medium">{name}</span>
                <code className="break-all text-sm text-muted-foreground">{url}</code>
              </li>
            ))}
          </ul>
        ) : <p className="text-muted-foreground">No MCP URLs available.</p>}
      </section>

      <section aria-labelledby="processes-heading" className="flex flex-col gap-4">
        <h2 id="processes-heading" className="text-xl font-medium">Owner processes</h2>
        {children.length > 0 ? (
          <ul className="divide-y divide-border border-t border-border">
            {children.map((child) => (
              <li key={child.name} className="flex items-baseline justify-between gap-6 py-3">
                <span className="font-medium">{child.name}</span>
                <span className="text-sm text-muted-foreground">Running · PID {child.pid}</span>
              </li>
            ))}
          </ul>
        ) : <p className="text-muted-foreground">No running owner processes.</p>}
      </section>

      <section aria-labelledby="servers-heading" className="flex flex-col gap-4">
        <h2 id="servers-heading" className="text-xl font-medium">Codex Servers</h2>
        {servers === null ? <p role="status" className="text-muted-foreground">Server list unavailable.</p> : servers.length > 0 ? (
          <ul className="divide-y divide-border border-t border-border">
            {servers.map((server) => (
              <li key={server.id} className="flex flex-col gap-1 py-4">
                <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
                  <span className="font-medium">{server.id}</span>
                  <span className="text-sm text-muted-foreground">Running · PID {server.pid}</span>
                </div>
                <code className="break-all text-sm text-muted-foreground">{server.cwd}</code>
                {server.url ? <code className="break-all text-sm text-muted-foreground">{server.url}</code> : null}
              </li>
            ))}
          </ul>
        ) : <p className="text-muted-foreground">No running Codex Servers.</p>}
      </section>
    </main>
  );
}
