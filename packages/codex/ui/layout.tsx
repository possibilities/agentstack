import type { ReactNode } from "react";
import { cn } from "./lib/utils";

const sections = [
  { id: "servers", label: "Servers", href: "/_ui/codex" },
  { id: "auth", label: "Auth", href: "/_ui/codex/auth" },
] as const;

export type CodexSection = (typeof sections)[number]["id"];

export function CodexShell({ section, children }: { section: CodexSection; children: ReactNode }) {
  return (
    <div className="mx-auto min-h-dvh w-[min(1920px,100%)] px-[clamp(12px,3vw,48px)] py-5 text-lg leading-normal [overflow-anchor:none] max-[480px]:py-3">
      <main aria-label="Codex">
        <header className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1">
          <h1 className="text-lg font-[550]">Codex</h1>
          <nav aria-label="Codex sections" className="flex items-center gap-3 text-sm">
            {sections.map((item) => (
              <a
                key={item.id}
                href={item.href}
                aria-current={item.id === section ? "page" : undefined}
                className={cn(
                  "underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus",
                  item.id === section ? "font-semibold underline" : "text-muted-foreground hover:text-foreground hover:underline",
                )}
              >
                {item.label}
              </a>
            ))}
          </nav>
        </header>
        {children}
      </main>
    </div>
  );
}
