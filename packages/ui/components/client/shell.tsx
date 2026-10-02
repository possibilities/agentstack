import type { ReactNode } from "react";

export function ClientShell({ children, local = false }: { children: ReactNode; local?: boolean }) {
  return <div className="client-home">
    <a className="client-skip" href={local ? "#local-main" : "#connections-main"}>{local ? "Skip to local platform" : "Skip to connections"}</a>
    <header className="client-header">
      <span className="client-brand"><span aria-hidden className="client-mark" />Stack Client</span>
      <nav aria-label="Client"><ol className="client-crumbs">
        <li><a href="/client" aria-current={local ? undefined : "page"}>Connections</a></li>
        {local ? <li aria-current="page">Run locally</li> : null}
      </ol></nav>
    </header>
    <main id={local ? "local-main" : "connections-main"} className="client-main">{children}</main>
  </div>;
}
