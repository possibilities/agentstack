"use client";

import { memo, useEffect, useMemo, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { FileIcon, FileTextIcon, ImageIcon } from "lucide-react";
import { linkWikilinks, wikilinkPrefix } from "@/lib/stack/content";
import { markdownBlocks } from "@/lib/stack/markdown-blocks";
import type { ContentItemKind } from "@/lib/stack/types";
import { cn } from "@/lib/utils";
import { contentError } from "./content-actions";
import { useStack, useStore } from "./provider";

/**
 * A read on the content channel, repeated after every content invalidation and reconnect.
 * Pass null args to read nothing. The last value stays visible while a repeat is in flight.
 */
export function useContentRead<T>(name: string, args: Record<string, unknown> | null): { data: T | null; error: string | null; loading: boolean; at: number | null } {
  const store = useStore();
  const { contentGeneration, status } = useStack();
  const key = args ? JSON.stringify([name, args]) : null;
  const [state, setState] = useState<{ key: string | null; data: T | null; error: string | null; at: number | null }>({ key: null, data: null, error: null, at: null });
  useEffect(() => {
    if (!key || status.content !== "open") return;
    let live = true;
    store.call<T>("content", name, args!).then(
      (data) => { if (live) setState({ key, data, error: null, at: Date.now() }); },
      (error) => { if (live) setState((current) => ({ key, data: current.key === key ? current.data : null, error: contentError(error), at: Date.now() })); },
    );
    return () => { live = false; };
  }, [key, contentGeneration, status.content]); // eslint-disable-line react-hooks/exhaustive-deps
  const current = state.key === key ? state : null;
  return { data: current?.data ?? null, error: current?.error ?? null, loading: key !== null && current === null, at: current?.at ?? null };
}

export function KindIcon({ kind, className }: { kind: ContentItemKind; className?: string }) {
  const Icon = kind === "image" ? ImageIcon : kind === "document" ? FileTextIcon : FileIcon;
  return <Icon aria-label={kind} className={cn("size-3.5 shrink-0 text-muted-foreground", className)} />;
}

export function TagChip({ tag, active, onClick }: { tag: string; active?: boolean; onClick?: () => void }) {
  const className = cn("rounded-md px-1.5 py-px text-[0.66rem] font-medium", active ? "bg-pkg-content/15 text-pkg-content" : "bg-muted text-muted-foreground");
  return onClick ? (
    <button type="button" aria-pressed={active} onClick={onClick} className={cn(className, "hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring")}>#{tag}</button>
  ) : <span className={className}>#{tag}</span>;
}

/** Unsaved-draft marker for rows. */
export function UnsavedDot() {
  return <span role="img" aria-label="Unsaved changes" className="size-1.5 shrink-0 rounded-full bg-pkg-content" />;
}

/**
 * Markdown rendered as React elements: raw HTML stays text, images show as links, and wikilinks
 * and `/d/<slug>` links open the named document through `onDocument` instead of navigating.
 */
export const ContentMarkdown = memo(function ContentMarkdown({ text, onDocument }: { text: string; onDocument(slug: string): void }) {
  const blocks = useMemo(() => markdownBlocks(linkWikilinks(text)), [text]);
  const components = useMemo<Components>(() => ({
    a: ({ node: _node, href, children, ...props }) => {
      const target = href?.startsWith(wikilinkPrefix) ? decodeURIComponent(href.slice(wikilinkPrefix.length))
        : href && /^\/d\/[^/?#]+$/.test(href) ? decodeURIComponent(href.slice(3)) : null;
      if (target !== null) {
        return <a href={href} {...props} onClick={(event) => { event.preventDefault(); onDocument(target); }} className="text-pkg-content">{children}</a>;
      }
      return <a href={href} {...props} target="_blank" rel="noreferrer noopener">{children}</a>;
    },
    // Remote images would load from the UI origin; show where they point instead.
    img: ({ src, alt }) => <span className="text-muted-foreground">[image: {alt || (typeof src === "string" ? src : "untitled")}]</span>,
    table: ({ node: _node, ...props }) => <div className="chat-table"><table {...props} /></div>,
  }), [onDocument]);
  return (
    <div className="chat-md content-md text-[0.84rem] break-words text-foreground/90">
      {blocks.map((source, index) => <ReactMarkdown key={index} remarkPlugins={[remarkGfm]} components={components}>{source}</ReactMarkdown>)}
    </div>
  );
});

/** Content writes show conflicts and errors inline in this form. */
export function InlineError({ error }: { error: string | null }) {
  return error ? <p role="alert" className="px-0.5 text-[0.72rem] text-pretty text-destructive">{error}</p> : null;
}

/** Re-render periodically so relative ISO timestamps stay honest. */
export function IsoTime({ at, className }: { at: string | null | undefined; className?: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(timer); }, []);
  if (!at) return null;
  const time = Date.parse(at);
  if (Number.isNaN(time)) return <span className={className}>{at}</span>;
  const seconds = Math.max(0, Math.round((now - time) / 1000));
  const text = seconds < 60 ? "just now" : seconds < 3600 ? `${Math.floor(seconds / 60)}m ago` : seconds < 86_400 ? `${Math.floor(seconds / 3600)}h ago`
    : seconds < 86_400 * 30 ? `${Math.floor(seconds / 86_400)}d ago` : new Date(time).toLocaleDateString();
  return <time dateTime={new Date(time).toISOString()} title={new Date(time).toLocaleString()} suppressHydrationWarning className={cn("tabular-nums", className)}>{text}</time>;
}
