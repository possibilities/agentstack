import type { ReactNode } from "react";

export function ClientShell({ children, local = false }: { children: ReactNode; local?: boolean }) {
  return <div className="client-home">
    <a className="client-skip" href={local ? "#local-main" : "#connections-main"}>{local ? "Skip to local platform" : "Skip to connections"}</a>
    <header className="client-header">
      <span className="font-medium">Stack Client</span>
      <nav aria-label="Client"><a href="/client" aria-current={local ? undefined : "page"}>Connections</a></nav>
    </header>
    <main id={local ? "local-main" : "connections-main"} className="client-main">{children}</main>
  </div>;
}
