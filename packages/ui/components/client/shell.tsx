import type { ReactNode } from "react";

export function ClientShell({ children, local = false, page }: { children: ReactNode; local?: boolean; page?: string }) {
  const title = local ? "Run locally" : page;
  return <div className="client-home">
    <a className="client-skip" href={local ? "#local-main" : "#connections-main"}>{local ? "Skip to local platform" : page ? "Skip to content" : "Skip to connections"}</a>
    <header className="client-header">
      <span className="client-brand"><span aria-hidden className="client-mark" />Stack Client</span>
      <nav aria-label="Client"><ol className="client-crumbs">
        <li><a href="/client" aria-current={title ? undefined : "page"}>Connections</a></li>
        {title ? <li aria-current="page">{title}</li> : null}
      </ol></nav>
    </header>
    <main id={local ? "local-main" : "connections-main"} className="client-main">{children}</main>
  </div>;
}
