"use client";

import { memo, useId, useMemo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { ShieldAlertIcon } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { markdownBlocks } from "@/lib/stack/markdown-blocks";
import type { CallError } from "@/lib/stack/scrape";
import { cn } from "@/lib/utils";
import { useNow } from "./provider";

/** Rendering cost grows with length; the Markdown view and copy keep the whole text. */
export const renderLimit = 200_000;

function linkHost(href: string | undefined): string | null {
  try { return href ? new URL(href).host : null; } catch { return null; }
}

/**
 * Extracted web content is untrusted. Raw HTML stays text, images show where they point instead
 * of loading, and a link opens only on an explicit click, in a new tab without a referrer.
 */
export const ScrapeMarkdown = memo(function ScrapeMarkdown({ text }: { text: string }) {
  const blocks = useMemo(() => markdownBlocks(text.length > renderLimit ? text.slice(0, renderLimit) : text), [text]);
  const components = useMemo<Components>(() => ({
    a: ({ node: _node, href, children, ...props }) => {
      const host = linkHost(href);
      return host
        ? <a href={href} {...props} title={href} target="_blank" rel="noreferrer noopener">{children}</a>
        : <span title={href}>{children}</span>;
    },
    img: ({ src, alt }) => <span className="text-muted-foreground">[image: {alt || (typeof src === "string" ? src : "untitled")}]</span>,
    table: ({ node: _node, ...props }) => <div className="chat-table"><table {...props} /></div>,
  }), []);
  return (
    <div className="chat-md scrape-md text-[0.82rem] break-words text-foreground/90">
      {blocks.map((source, index) => <ReactMarkdown key={index} remarkPlugins={[remarkGfm]} components={components}>{source}</ReactMarkdown>)}
      {text.length > renderLimit ? <p className="text-[0.7rem] text-muted-foreground">Showing the first {renderLimit.toLocaleString()} of {text.length.toLocaleString()} characters.</p> : null}
    </div>
  );
});

/** Seconds since a call started, so a long synchronous call visibly progresses. */
export function Elapsed({ since, className }: { since: number; className?: string }) {
  const now = useNow();
  const seconds = Math.max(0, Math.floor((now - since) / 1_000));
  return <span className={cn("tabular-nums", className)}>{seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`}</span>;
}

/**
 * Consent to unrestricted browser egress (`allowPrivateNetwork`) for one request. Callers clear
 * it after every run, so consent is never remembered.
 */
export function EgressConsent({ checked, onChange, disabled }: { checked: boolean; onChange(value: boolean): void; disabled?: boolean }) {
  const id = useId();
  return (
    <label htmlFor={id} className={cn("flex items-start gap-2 rounded-lg border px-2.5 py-2 text-[0.74rem]", checked ? "border-warning/60 bg-warning/10" : "border-dashed")}>
      <Switch id={id} size="sm" className="mt-0.5" checked={checked} disabled={disabled} onCheckedChange={onChange} />
      <span className="flex flex-col gap-0.5">
        <span className="flex items-center gap-1 font-medium"><ShieldAlertIcon className="size-3.5 text-warning" />Allow browser egress for this request</span>
        <span className="text-muted-foreground text-pretty">Browser pages may reach any destination, including private networks. Clears after each run.</span>
      </span>
    </label>
  );
}

export function CallErrorNote({ error, id }: { error: CallError | null; id?: string }) {
  if (!error) return null;
  return (
    <p id={id} role="alert" className={cn("rounded-lg px-2.5 py-2 text-[0.74rem] text-pretty", error.uncertain ? "bg-warning/10 text-warning" : "bg-destructive/10 text-destructive")}>
      {error.text}{error.uncertain ? " It may still be running; nothing is resent automatically." : ""}
    </p>
  );
}

export const fieldLabel = "px-0.5 text-[0.7rem] font-medium text-muted-foreground";

/** A labelled pre for machine output that can be long. */
export function Raw({ value, className }: { value: string; className?: string }) {
  return <pre className={cn("max-h-96 overflow-auto rounded-lg bg-muted/60 p-2.5 font-mono text-[0.7rem] leading-relaxed whitespace-pre-wrap break-all", className)}>{value}</pre>;
}
