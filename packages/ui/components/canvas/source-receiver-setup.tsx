"use client";

import { useState } from "react";
import { ChevronDownIcon, ChevronRightIcon, ExternalLinkIcon } from "lucide-react";
import { setupMode } from "@/lib/stack/source-setup";
import type { GithubEndpoint, GithubSetup } from "@/lib/stack/types";
import { cn } from "@/lib/utils";
import { CopyButton, NodeLink } from "./primitives";
import { useStack } from "./provider";
import { HookDiagnose } from "./source-hook-diagnose";
import { HookSetup } from "./source-hook-setup";
import { EditReceiver, SecretControls } from "./source-receiver-controls";
import { RequestList, useRemoteRequests } from "./source-requests";
import { sourceChip, sourceHint, sourceLabel } from "./source-shared";

/** A disclosure whose body is unmounted while closed, unless it must keep what the person built in it. A secret must never stay behind a closed panel. */
function Group({ title, keepMounted = false, children }: { title: string; keepMounted?: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = `group-${title.replace(/\W+/g, "-").toLowerCase()}`;
  return (
    <div className="rounded-lg border border-dashed">
      <button type="button" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left text-[0.72rem] font-medium text-muted-foreground select-none hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
        {open ? <ChevronDownIcon className="size-3.5" /> : <ChevronRightIcon className="size-3.5" />}{title}
      </button>
      {open || keepMounted ? <div id={id} hidden={!open} className="flex flex-col gap-2.5 border-t border-dashed p-2.5">{children}</div> : null}
    </div>
  );
}

/**
 * Everything a person can do to one receiver beyond reading it, in the order of a setup: settings, then the hook at GitHub (automated for a
 * github.com repository or organization, by hand for every other target), then probing and GitHub's attempts. Local operator only: the
 * remote UI never renders this.
 */
export function ReceiverSetupControls({ endpoint, setup }: { endpoint: GithubEndpoint; setup: GithubSetup | null }) {
  const { status } = useStack();
  const requests = useRemoteRequests(endpoint.id);
  const mode = setupMode(endpoint.target, endpoint.githubHost);
  return (
    <div className="flex flex-col gap-2">
      <Group title="Settings" keepMounted><EditReceiver endpoint={endpoint} /></Group>
      {mode.automated ? (
        <>
          <Group title="Hook at GitHub" keepMounted><HookSetup endpoint={endpoint} setup={setup} requests={requests} /></Group>
          <Group title="Probe and delivery attempts" keepMounted><HookDiagnose endpoint={endpoint} requests={requests} /></Group>
          <Group title="Secret"><SecretControls endpoint={endpoint} /></Group>
        </>
      ) : <Group title="Set up by hand"><ManualSetup endpoint={endpoint} setup={setup} reason={mode.reason} /></Group>}
      <RequestList requests={requests} connected={status.source === "open"} />
    </div>
  );
}

/** A GitHub settings page as a deliberate link, only when it is an https URL on the receiver's own GitHub host. */
const settingsLink = (url: string, host: string): string | null => {
  try { const parsed = new URL(url); return parsed.protocol === "https:" && parsed.hostname.toLowerCase() === host.toLowerCase() ? parsed.href : null; } catch { return null; }
};

const eventAdvice: Record<string, string> = {
  enterprise: "Select the events your enterprise hook offers.",
  app: "Select events in the App's webhook settings; they are limited to the permissions the App has and is granted by each installation.",
  marketplace: "Marketplace webhooks send purchase events.",
  sponsors_listing: "Sponsors webhooks send sponsorship events.",
  repository: "Select all events, or the ones you need.", organization: "Select all events, or the ones you need.",
};

/**
 * Manual setup for what Stack does not configure for you: App, enterprise, Marketplace and Sponsors webhooks, and anything on a GitHub
 * Enterprise Server host. The exact URL and settings to enter come first; the secret is revealed last, on purpose.
 */
function ManualSetup({ endpoint, setup, reason }: { endpoint: GithubEndpoint; setup: GithubSetup | null; reason: string }) {
  const link = setup ? settingsLink(setup.settingsUrl, endpoint.githubHost) : null;
  return (
    <section aria-label="Manual setup" className="flex flex-col gap-3">
      <p className={sourceHint}>{reason} Stack does not sign in, register Apps, install anything or change GitHub for this receiver.</p>
      {!setup ? <p className={sourceHint}>Reading setup…</p> : (
        <>
          <div className="flex flex-col gap-1">
            <span className={sourceLabel}>GitHub settings page</span>
            <div className="group/row flex min-w-0 items-center gap-2 text-[0.72rem]">
              <span className="min-w-0 truncate font-mono text-[0.68rem]" title={setup.settingsUrl}>{setup.settingsUrl}</span>
              <CopyButton value={setup.settingsUrl} label="settings URL" className="opacity-100" />
            </div>
            {link ? (
              <a href={link} target="_blank" rel="noopener noreferrer" className="inline-flex w-fit items-center gap-1 rounded-sm text-[0.72rem] font-medium underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-ring">
                <ExternalLinkIcon aria-hidden className="size-3.5" />Open on GitHub (new tab)
              </a>
            ) : <span className={sourceHint}>This address is not an https page on {endpoint.githubHost}, so it is shown as text only.</span>}
          </div>
          <div className="flex flex-col gap-1">
            <span className={sourceLabel}>Enter exactly this</span>
            {endpoint.webhookUrl ? (
              <ul aria-label="Settings to enter" className="flex flex-col gap-1 text-[0.72rem]">
                <li className="flex min-w-0 items-center gap-2"><span className="w-24 shrink-0 text-muted-foreground">Payload URL</span><code data-webhook-url className="min-w-0 truncate font-mono text-[0.68rem]" title={endpoint.webhookUrl}>{endpoint.webhookUrl}</code><CopyButton value={endpoint.webhookUrl} label="webhook URL" className="opacity-100" /></li>
                <li className="flex gap-2"><span className="w-24 shrink-0 text-muted-foreground">Content type</span><span><code className="font-mono">application/json</code></span></li>
                <li className="flex gap-2"><span className="w-24 shrink-0 text-muted-foreground">TLS</span><span>Enable SSL verification</span></li>
                <li className="flex gap-2"><span className="w-24 shrink-0 text-muted-foreground">Secret</span><span>The secret revealed below</span></li>
                <li className="flex gap-2"><span className="w-24 shrink-0 text-muted-foreground">Events</span><span className="text-pretty">{eventAdvice[endpoint.target.kind] ?? "Select the events you need."}</span></li>
                <li className="flex gap-2"><span className="w-24 shrink-0 text-muted-foreground">Active</span><span>Yes</span></li>
              </ul>
            ) : <p role="status" className="text-[0.72rem] text-warning">No public HTTPS origin is set, so there is no webhook URL to enter yet. Set the public origin under Settings first.</p>}
          </div>
          <div className="flex flex-col gap-1">
            <span className={sourceLabel}>Events</span>
            <p className="text-[0.72rem] text-pretty text-muted-foreground">The catalog lists every event and action for this hook type{endpoint.githubHost.toLowerCase() === "github.com" ? "" : " and each GitHub Enterprise Server version"}, with permission guidance. See the Catalog window in this space, or the{" "}
              <NodeLink node={{ kind: "operation", pkg: "source", id: "github_event_catalog" }} label="github_event_catalog" className="font-mono font-medium">github_event_catalog</NodeLink> reference. It is guidance, not an allowlist.</p>
          </div>
          <div className="flex flex-col gap-1">
            <span className={sourceLabel}>Steps</span>
            <ol aria-label="Setup steps from the owner" className="flex flex-col gap-2">
              {setup.steps.map((step, index) => (
                <li key={step.id} className="flex flex-col gap-0.5 text-[0.72rem]">
                  <span className="flex items-baseline gap-2"><span className="tabular-nums text-muted-foreground">{index + 1}</span><span className="font-medium">{step.title}</span><span className={cn(sourceChip, "ml-auto shrink-0")}>{step.state}</span></span>
                  <span className="pl-4 text-pretty text-muted-foreground">{step.detail}</span>
                </li>
              ))}
            </ol>
          </div>
        </>
      )}
      <div className="flex flex-col gap-1">
        <span className={sourceLabel}>Then, the secret</span>
        <SecretControls endpoint={endpoint} />
      </div>
    </section>
  );
}
