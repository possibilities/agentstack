"use client";

import { useState } from "react";
import { BookOpenIcon, RefreshCwIcon, WrenchIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { relativeTime } from "@/lib/stack/derive";
import { chromeBrowserLabel, codexAvailability, codexStaleMs, type CodexAvailability } from "@/lib/stack/roles";
import type { CodexToolsConnection, CodexToolsProblem, CodexToolsStatus } from "@/lib/stack/types";
import { cn } from "@/lib/utils";
import { errorMessage } from "./auth-actions";
import { NodeCard, NodeTitle, Row } from "./primitives";
import { useNow, useStack, useStore, useWorkbench } from "./provider";
import { Section, Window } from "./window";

const dotTone: Record<CodexAvailability["tone"], string> = {
  ok: "bg-emerald-500", warn: "bg-amber-500", error: "bg-destructive", unknown: "border border-muted-foreground/60 bg-transparent",
};

export function AvailabilityDot({ availability }: { availability: CodexAvailability }) {
  const label = `${availability.label}${availability.stale ? " (may be out of date)" : ""}`;
  return <span role="img" aria-label={label} title={label} className={cn("size-1.5 shrink-0 rounded-full", dotTone[availability.tone], availability.stale && "opacity-50")} />;
}

export function ProblemText({ problem }: { problem: CodexToolsProblem }) {
  return <p className="text-foreground"><span className="font-medium">{problem.message}</span> {problem.recovery}</p>;
}

const runtimeSource: Record<string, string> = { override: "STACK_CODEX_TOOLS_BIN", standalone: "standalone Codex", "chatgpt-app": "ChatGPT app", "codex-app": "Codex app" };

export type CodexTools = {
  data: CodexToolsStatus | null;
  /** False while the read failed or the server connection is closed: held observations are then not current. */
  readable: boolean;
  checking: boolean;
  canCheck: boolean;
  check(chromeBrowser: boolean): void;
  /** One line saying how current the observations are. */
  summary: string;
};

/** The cached observations and the local-only check both views share. */
export function useCodexTools(now: number): CodexTools {
  const { codexTools, status, remote } = useStack();
  const store = useStore();
  const [asking, setAsking] = useState(false);
  const data = codexTools.data;
  const readable = status.serve === "open" && !!data && !codexTools.error;
  const checking = !!data?.checking;
  const checkedAt = data?.checkedAt ? Date.parse(data.checkedAt) : null;
  const summary = !readable
    ? codexTools.error ? `Availability unknown: ${codexTools.error}` : status.serve !== "open" ? "Availability unknown while the server connection is closed." : "Reading availability…"
    : checking ? "Checking the selected Codex installation…"
      : checkedAt === null ? "Not checked since the server started."
        : `Checked ${relativeTime(checkedAt, now)}${now - checkedAt > codexStaleMs ? ", may be out of date" : ""}${data.runtime.source ? ` · ${runtimeSource[data.runtime.source]}` : ""}.`;
  return {
    data, readable, checking, summary,
    // Checks start a desktop runtime, so they stay with local operators.
    canCheck: status.serve === "open" && !remote && !checking && !asking,
    check: (chromeBrowser) => {
      setAsking(true);
      store.checkCodexTools(chromeBrowser).catch((error) => toast.error(errorMessage(error))).finally(() => setAsking(false));
    },
  };
}

export function CheckButton({ tools, chromeBrowser = false, className }: { tools: CodexTools; chromeBrowser?: boolean; className?: string }) {
  const { remote } = useStack();
  return (
    <Button size="xs" variant="outline" className={className} disabled={!tools.canCheck} onClick={() => tools.check(chromeBrowser)}
      title={remote ? "Checks run only from the local UI" : chromeBrowser ? "Ask the Chrome extension which browsers are connected; no page is read" : "List each upstream tool catalog in a temporary Codex runtime"}>
      {chromeBrowser ? null : tools.checking ? <Spinner /> : <RefreshCwIcon />}{chromeBrowser ? "Check browser" : "Check"}
    </Button>
  );
}

/** What one observation says: evidence, recovery and, for Chrome, the separate browser observation. */
export function ConnectionDetails({ connection, tools, now, caveat = true }: { connection: CodexToolsConnection; tools: CodexTools; now: number; caveat?: boolean }) {
  const at = (value: string | null) => value ? ` (${relativeTime(Date.parse(value), now)})` : "";
  if (!tools.readable || tools.checking) return null;
  const { catalog, browser } = connection;
  return (
    <>
      {catalog.evidence ? <p>{catalog.evidence}{at(catalog.checkedAt)}</p> : null}
      {catalog.problem ? <ProblemText problem={catalog.problem} /> : null}
      {caveat && catalog.state === "available" ? <p>A listed catalog does not show that a Bot or Worker connected, that an app or site is approved, or that approvals can be answered.</p> : null}
      {browser && catalog.state === "available" ? (
        <div className="flex flex-col gap-1 rounded-md border bg-background/60 px-2 py-1.5">
          <div className="flex items-center gap-2">
            <span className="font-medium text-foreground">{chromeBrowserLabel(browser)}</span>
            <CheckButton tools={tools} chromeBrowser className="ml-auto" />
          </div>
          {browser.evidence ? <p>{browser.evidence}{at(browser.checkedAt)}</p> : null}
          {/* The heading already states the observation; add only the next step. */}
          {browser.problem ? <p className="text-foreground">{browser.problem.recovery}</p> : null}
          <p>Stack&rsquo;s managed Browser profiles in Browse are separate from this browser.</p>
        </div>
      ) : null}
    </>
  );
}

/** The one-line state a row shows beside its title. */
export function availabilityText(connection: CodexToolsConnection | undefined, tools: CodexTools, now: number): { availability: CodexAvailability; text: string } {
  const availability = codexAvailability(connection, tools.readable, tools.checking, now);
  const browser = connection?.name === "chrome" && tools.readable && !tools.checking && connection.catalog.state === "available" ? ` · ${chromeBrowserLabel(connection.browser)}` : "";
  return { availability, text: `${availability.label}${browser}` };
}

/**
 * System's view of the Codex tool bridges: the server's selected installation, as the last explicit
 * check observed it. Role selection lives in Roles; this card shows no switch.
 */
export function CodexToolsWindow() {
  const { codexTools, status, endpoints } = useStack();
  const { goTo } = useWorkbench();
  const now = useNow(30_000);
  const tools = useCodexTools(now);
  const { data } = tools;
  const available = tools.readable && !tools.checking ? data!.connections.filter((item) => item.catalog.state === "available").length : null;
  return (
    <Window id="codex-tools" title="Codex tools" subtitle="serve" icon={WrenchIcon} accent="server" empty={!data && !codexTools.error}
      status={status.serve} endpoint={endpoints.serve} updatedAt={codexTools.at} error={codexTools.error}
      actions={<CheckButton tools={tools} />}>
      <div className="flex flex-col gap-2.5">
        <div className="flex items-start justify-between gap-3">
          <p role="status" className="text-xs text-pretty text-muted-foreground">{tools.summary}</p>
          {available !== null && data ? (
            <div className="flex shrink-0 flex-col items-end">
              <span className="text-xl leading-none font-semibold tracking-tight tabular-nums">{available}<span className="text-muted-foreground">/{data.connections.length}</span></span>
              <span className="text-[0.68rem] text-muted-foreground">catalogs available</span>
            </div>
          ) : null}
        </div>
        {data && tools.readable ? (
          <dl>
            <Row label="Runtime" hint="The tool runtime the server selected from STACK_CODEX_TOOLS_BIN or the desktop installations. It is separate from Bot and Worker inference accounts.">
              {data.runtime.state === "found" && data.runtime.source ? runtimeSource[data.runtime.source] : data.runtime.state === "not_checked" ? "Not checked" : data.runtime.state === "missing" ? "Not found" : "Misconfigured"}
            </Row>
          </dl>
        ) : null}
        {tools.readable && data?.runtime.problem ? <div className="text-xs"><ProblemText problem={data.runtime.problem} /></div> : null}
        <div className="flex items-center gap-1 text-[0.68rem] text-muted-foreground">
          <span className="text-pretty">Checks list upstream catalogs; they take no desktop action.</span>
          <Button variant="ghost" size="xs" className="ml-auto -mr-1.5 h-5 shrink-0 px-1.5 text-[0.68rem] text-muted-foreground" onClick={() => goTo({ kind: "operation", pkg: "serve", id: "serve_codex_tools" })}><BookOpenIcon data-icon="inline-start" />serve_codex_tools</Button>
        </div>
      </div>
      {data ? (
        <Section title="Connections">
          <div className="-mx-1 flex flex-col">
            {data.connections.map((connection) => {
              const node = { kind: "codex-tool", id: connection.name } as const;
              const { availability, text } = availabilityText(connection, tools, now);
              return (
                <NodeCard key={connection.name} variant="row" node={node} label={`${connection.title} Codex tool`} className="flex flex-col gap-1">
                  <div className="flex items-center gap-2 text-xs">
                    <AvailabilityDot availability={availability} />
                    <NodeTitle node={node} label={`${connection.title} Codex tool`} className="font-medium">{connection.title}</NodeTitle>
                    <span className="font-mono text-[0.64rem] text-muted-foreground">{connection.name}</span>
                    <span className="ml-auto text-right text-[0.68rem] text-muted-foreground">{text}</span>
                  </div>
                  <div className="flex flex-col gap-1 pl-4 text-[0.68rem] text-pretty text-muted-foreground">
                    <ConnectionDetails connection={connection} tools={tools} now={now} caveat={false} />
                  </div>
                </NodeCard>
              );
            })}
          </div>
          <p className="px-1.5 text-[0.66rem] text-pretty text-muted-foreground">
            An available catalog does not show that a Bot or Worker connected, that an app or site is approved, or that approvals can be answered.
            Observations describe the server&rsquo;s installation and reset when it restarts. Each Role selects connections in Roles.
          </p>
        </Section>
      ) : null}
    </Window>
  );
}
