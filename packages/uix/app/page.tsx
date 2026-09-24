import type { Metadata } from "next";
import { loadIndex } from "@/lib/status";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  alternates: { types: { "text/markdown": "/index.md" } },
};

export default async function Page() {
  const { owner, bots, links, mcp, children } = await loadIndex();

  return (
    <main className="mx-auto flex min-h-dvh max-w-4xl flex-col gap-12 px-6 py-12 sm:px-10 sm:py-16">
      <header className="flex flex-wrap items-end justify-between gap-6">
        <div className="flex flex-col gap-2">
          <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">AgentStack</h1>
          <p className="text-muted-foreground">Local links and bot processes.</p>
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

      <section aria-labelledby="bots-heading" className="flex flex-col gap-4">
        <h2 id="bots-heading" className="text-xl font-medium">Bots</h2>
        {bots === null ? <p role="status" className="text-muted-foreground">Bot list unavailable.</p> : bots.length > 0 ? (
          <ul className="divide-y divide-border border-t border-border">
            {bots.map((bot) => (
              <li key={bot.id} className="flex flex-col gap-1 py-4">
                <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
                  <span className="font-medium">{bot.id}</span>
                  <span className="text-sm text-muted-foreground">{bot.recoveryIssue ? "Needs inspection · reported running state unverified" : "Running"} · PID {bot.pid}</span>
                </div>
                {bot.recoveryIssue ? <p className="text-sm text-warning">{bot.recoveryIssue}</p> : null}
                <code className="break-all text-sm text-muted-foreground">{bot.cwd}</code>
                {bot.url ? <code className="break-all text-sm text-muted-foreground">{bot.url}</code> : null}
              </li>
            ))}
          </ul>
        ) : <p className="text-muted-foreground">No running bots.</p>}
      </section>
    </main>
  );
}
