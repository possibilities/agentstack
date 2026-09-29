"use client";

import { useCallback, useEffect, useState } from "react";
import { ArrowLeftIcon, ArrowRightIcon, ExternalLinkIcon, EyeIcon, LinkIcon, MonitorIcon, PencilIcon, TriangleAlertIcon } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { asText, base64ToBytes, contentHref, defaultRoutes, fillRoute, formatSize, hexDump, imagePreviewLimit, peekBytes } from "@/lib/stack/content";
import type { ContentArtifact, ContentBacklinks, ContentDocumentBody, ContentItem, ContentLinks } from "@/lib/stack/types";
import { cn } from "@/lib/utils";
import { useContentActions } from "./content-actions";
import { ContentMarkdown, IsoTime, KindIcon, TagChip, useContentRead } from "./content-shared";
import { CopyButton, Empty, Row } from "./primitives";
import { useStack, useStore } from "./provider";
import { Section, Window } from "./window";

/** This page's hostname, read after hydration: the server render never offers Content origin links. */
function useHostname(): string | null {
  const [hostname, setHostname] = useState<string | null>(null);
  useEffect(() => setHostname(window.location.hostname), []);
  return hostname;
}

/** A link to a Content origin, or a plain explanation when this page can’t reach one. */
function OriginLink({ which, path, label, download }: { which: "document" | "artifact"; path: string; label: string; download?: boolean }) {
  const { contentOrigins, remote } = useStack();
  const hostname = useHostname();
  const [error, setError] = useState<string | null>(null);
  const href = contentHref(contentOrigins, which, path, hostname);
  if (remote) return <span className="inline-flex flex-col gap-1">
    <Button size="xs" variant="outline" disabled={!remote.scopes.includes("content:read")} title={!remote.scopes.includes("content:read") ? "Opening Content requires content:read on this browser's Access grant" : undefined} onClick={() => {
      setError(null);
      const tab = window.open("about:blank", "_blank");
      if (!tab) { setError("Allow pop-ups to open Content in a new tab."); return; }
      tab.opener = null;
      void fetch("/v1/content/handoff", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ origin: which === "document" ? "documents" : "artifacts", path }), cache: "no-store" })
        .then(async response => {
          const result = await response.json();
          if (!response.ok) throw new Error(result.error?.message ?? "Content handoff refused");
          tab.location.replace(`${remote.contentOrigins[which]}/session#${result.data.handoff}`);
        }).catch((cause: Error) => { tab.close(); setError(cause.message); });
    }}><ExternalLinkIcon data-icon="inline-start" />{label}</Button>
    {error ? <span role="alert" className="text-xs text-destructive">{error}</span> : null}
  </span>;
  if (!href) return null;
  return (
    <a href={href} target="_blank" rel="noreferrer noopener" {...(download ? { download: "" } : {})} className={buttonVariants({ size: "xs", variant: "outline" })}>
      <ExternalLinkIcon data-icon="inline-start" />{label}
    </a>
  );
}

/** Explains when Content’s origins are out of reach: remote pages need an Access Content handoff this page can’t mint. */
function OpenLocally() {
  const { contentOrigins, remote } = useStack();
  const hostname = useHostname();
  if (remote || !hostname || contentHref(contentOrigins, "artifact", "/", hostname)) return null;
  return (
    <p className="flex items-start gap-1.5 rounded-lg border border-dashed px-2.5 py-2 text-[0.7rem] text-pretty text-muted-foreground">
      <MonitorIcon className="mt-px size-3.5 shrink-0" />
      {contentOrigins ? "Open this on the Stack machine to view it in a browser tab. Remote viewing needs an Access Content handoff, which this page can’t request."
        : "This server doesn’t know Content’s HTTP address, so there is no browser link. Its text and metadata still show here."}
    </p>
  );
}

/** Renders the selection: documents as Markdown, images inline, other items as metadata and a peek. Artifacts open on their own origin. */
export function ContentPreviewWindow() {
  const { selection } = useContentActions();
  const { status, endpoints } = useStack();
  const frame = (subtitle: string | undefined, body: React.ReactNode, empty = false, updatedAt: number | null = null, error: string | null = null, actions?: React.ReactNode) => (
    <Window id="content-preview" title="Preview" subtitle={subtitle} icon={EyeIcon} accent="content" status={status.content} endpoint={endpoints.content}
      updatedAt={updatedAt} error={error} empty={empty} actions={actions}>{body}</Window>
  );
  if (!selection) return frame(undefined, <Empty icon={EyeIcon} title="Choose something to preview" />, true);
  switch (selection.kind) {
    case "document": return <DocumentPreview key={selection.slug} slug={selection.slug} frame={frame} />;
    case "item": return <ItemPreview key={selection.id} id={selection.id} frame={frame} />;
    case "artifact": return <ArtifactPreview key={`${selection.name}:${selection.version ?? ""}`} name={selection.name} version={selection.version} frame={frame} />;
  }
}

type Frame = (subtitle: string | undefined, body: React.ReactNode, empty?: boolean, updatedAt?: number | null, error?: string | null, actions?: React.ReactNode) => React.ReactNode;

function DocumentPreview({ slug, frame }: { slug: string; frame: Frame }) {
  const actions = useContentActions();
  const { contentRoutes } = useStack();
  const document = useContentRead<ContentDocumentBody>("get", { ref: slug });
  const links = useContentRead<ContentLinks>("links", { ref: slug });
  const backlinks = useContentRead<ContentBacklinks>("backlinks", { ref: slug });
  const show = useCallback((target: string) => actions.preview({ kind: "document", slug: target }), [actions]);
  const path = fillRoute(contentRoutes.data?.documentPath ?? defaultRoutes.documentPath, { slug });
  if (!document.data) return frame(`document · ${slug}`, <Empty icon={EyeIcon} title={document.error ?? "Loading…"} />, true, document.at, document.error);
  const outgoing = links.data?.outgoing ?? [];
  const dangling = (links.data?.dangling ?? []) as Array<{ target?: string; reason?: string }>;
  const incoming = backlinks.data?.incoming ?? [];
  return frame(`document · ${slug}`, (
    <>
      <div className="flex flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-1">
          {(document.data.tags ?? []).map((tag) => <TagChip key={tag} tag={tag} />)}
          {document.data.updated ? <span className="text-[0.66rem] text-muted-foreground">Edited <IsoTime at={document.data.updated} /></span> : null}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Button size="xs" variant="outline" onClick={() => actions.open({ kind: "document", slug })}><PencilIcon data-icon="inline-start" />Edit</Button>
          <OriginLink which="document" path={path} label="Open page" />
          <span className="flex items-center gap-0.5 font-mono text-[0.66rem] text-muted-foreground">{path}<CopyButton value={path} label="link path" className="opacity-100" /></span>
        </div>
      </div>
      <ContentMarkdown text={document.data.content ?? ""} onDocument={show} />
      <Section title="Links" aside={<span className="text-[0.65rem] text-muted-foreground tabular-nums">{outgoing.length} out · {incoming.length} in</span>}>
        {outgoing.length + dangling.length + incoming.length === 0 ? <p className="px-0.5 text-[0.7rem] text-muted-foreground">No links to or from this document.</p> : (
          <ul className="flex flex-col gap-0.5 text-[0.76rem]">
            {outgoing.map((link) => (
              <li key={`out:${link.to}:${link.kind}`}>
                <button type="button" onClick={() => show(link.to)} className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring">
                  <ArrowRightIcon className="size-3 shrink-0 text-muted-foreground" aria-label="Links to" />
                  <span className="truncate">{link.title}</span>
                  <span className="ml-auto shrink-0 text-[0.64rem] text-muted-foreground">{link.kind}</span>
                </button>
              </li>
            ))}
            {dangling.map((link, index) => (
              <li key={`dangling:${index}`} className="flex items-center gap-1.5 px-1.5 py-1 text-muted-foreground">
                <TriangleAlertIcon className="size-3 shrink-0 text-warning" aria-label="Dangling link" />
                <span className="truncate font-mono text-[0.7rem]">{link.target ?? JSON.stringify(link)}</span>
                <span className="ml-auto shrink-0 text-[0.64rem]">{link.reason ?? "dangling"}</span>
              </li>
            ))}
            {incoming.map((link) => (
              <li key={`in:${link.from}:${link.kind}`}>
                <button type="button" onClick={() => show(link.from)} className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring">
                  <ArrowLeftIcon className="size-3 shrink-0 text-muted-foreground" aria-label="Linked from" />
                  <span className="truncate">{link.title}</span>
                  <span className="ml-auto shrink-0 text-[0.64rem] text-muted-foreground">{link.kind}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </>
  ), false, document.at, document.error);
}

type ItemRead = ContentItem & { content: string | null; base64: string | null };

function ItemPreview({ id, frame }: { id: string; frame: Frame }) {
  const actions = useContentActions();
  const read = useContentRead<ItemRead>("item_get", { id, includeData: true });
  const item = read.data;
  if (!item) return frame("item", <Empty icon={EyeIcon} title={read.error ?? "Loading…"} />, true, read.at, read.error);
  return frame(`item · ${item.kind}`, (
    <>
      <div className="flex flex-col gap-1.5">
        <div className="flex min-w-0 items-center gap-1.5">
          <KindIcon kind={item.kind} />
          <span className="truncate text-[0.9rem] font-semibold tracking-tight">{item.name}</span>
          <span className="ml-auto shrink-0 rounded bg-muted px-1.5 py-px text-[0.64rem] text-muted-foreground">{item.collection ?? "ungrouped"}</span>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {item.kind === "document" ? <Button size="xs" variant="outline" onClick={() => actions.open({ kind: "item", id, itemKind: item.kind })}><PencilIcon data-icon="inline-start" />Edit</Button> : null}
          <OriginLink which="artifact" path={item.url} label={item.kind === "file" ? "Download" : "Open"} download={item.kind === "file"} />
          <span className="flex items-center gap-0.5 font-mono text-[0.66rem] text-muted-foreground">{item.url}<CopyButton value={item.url} label="item link path" className="opacity-100" /></span>
        </div>
        <dl className="flex flex-col rounded-lg border bg-background/50 px-2.5 py-1">
          <Row label="Media type" mono>{item.mediaType}</Row>
          <Row label="Size">{formatSize(item.bytes)}</Row>
          <Row label="Revision" mono>{item.revision}</Row>
          <Row label="Updated"><IsoTime at={item.updatedAt} /></Row>
          <Row label="Digest" mono copy={item.digest}>{item.digest.slice(0, 16)}…</Row>
        </dl>
      </div>
      {item.kind === "image" ? <ImageBody item={item} /> : item.kind === "document" ? <TextBody item={item} /> : <PeekBody item={item} />}
      <OpenLocally />
    </>
  ), false, read.at, read.error);
}

/** Read an item's bytes through the Package API in bounded chunks. */
function useItemBytes(item: ItemRead, limit: number): { bytes: Uint8Array | null; error: string | null } {
  const store = useStore();
  const [state, setState] = useState<{ key: string; bytes: Uint8Array | null; error: string | null } | null>(null);
  const key = `${item.id}:${item.revision}:${limit}`;
  useEffect(() => {
    if (item.base64 !== null && item.bytes <= limit) { setState({ key, bytes: base64ToBytes(item.base64), error: null }); return; }
    let live = true;
    (async () => {
      const parts: Uint8Array[] = [];
      let total = 0;
      for (let offset: number | null = 0; offset !== null && total < limit;) {
        const chunk: { base64: string; nextOffset: number | null } = await store.call("content", "item_read", { id: item.id, offset, length: Math.min(262_144, limit - total), expectedRevision: item.revision });
        const part = base64ToBytes(chunk.base64);
        parts.push(part);
        total += part.length;
        offset = chunk.nextOffset;
      }
      const joined = new Uint8Array(total);
      let at = 0;
      for (const part of parts) { joined.set(part, at); at += part.length; }
      return joined;
    })().then((bytes) => { if (live) setState({ key, bytes, error: null }); }, (error) => { if (live) setState({ key, bytes: null, error: error instanceof Error ? error.message : String(error) }); });
    return () => { live = false; };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return state?.key === key ? state : { bytes: null, error: null };
}

function ImageBody({ item }: { item: ItemRead }) {
  const tooLarge = item.bytes > imagePreviewLimit;
  const { bytes, error } = useItemBytes(item, tooLarge ? 0 : imagePreviewLimit);
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!bytes || tooLarge) return;
    // An image element never runs scripts, and the blob keeps the allowlisted raster type.
    const next = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: item.mediaType }));
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [bytes, item.mediaType, tooLarge]);
  if (tooLarge) return <p className="px-0.5 text-[0.72rem] text-muted-foreground">At {formatSize(item.bytes)} this image is too large to preview here.</p>;
  if (error) return <p role="alert" className="px-0.5 text-[0.72rem] text-destructive">{error}</p>;
  // eslint-disable-next-line @next/next/no-img-element
  return url ? <img src={url} alt={item.name} className="max-h-[32rem] w-full rounded-lg border bg-[repeating-conic-gradient(var(--muted)_0_25%,transparent_0_50%)] bg-[length:16px_16px] object-contain" />
    : <p className="px-0.5 text-[0.72rem] text-muted-foreground">Loading image…</p>;
}

function TextBody({ item }: { item: ItemRead }) {
  const actions = useContentActions();
  const { bytes, error } = useItemBytes(item, item.content !== null ? 0 : 262_144);
  const text = item.content ?? (bytes ? new TextDecoder().decode(bytes) : null);
  if (error) return <p role="alert" className="px-0.5 text-[0.72rem] text-destructive">{error}</p>;
  if (text === null) return <p className="px-0.5 text-[0.72rem] text-muted-foreground">Loading text…</p>;
  const partial = item.content === null && item.bytes > 262_144;
  return (
    <>
      {partial ? <p className="px-0.5 text-[0.68rem] text-muted-foreground">Showing the first 256 KB of {formatSize(item.bytes)}.</p> : null}
      {item.mediaType === "text/markdown"
        ? <ContentMarkdown text={text} onDocument={(slug) => actions.preview({ kind: "document", slug })} />
        : <pre className="rounded-lg border bg-background/60 px-2.5 py-2 font-mono text-[0.72rem] leading-relaxed break-words whitespace-pre-wrap">{text}</pre>}
    </>
  );
}

function PeekBody({ item }: { item: ItemRead }) {
  const { bytes, error } = useItemBytes(item, Math.min(peekBytes, Math.max(1, item.bytes)));
  if (item.bytes === 0) return <p className="px-0.5 text-[0.72rem] text-muted-foreground">This file is empty.</p>;
  if (error) return <p role="alert" className="px-0.5 text-[0.72rem] text-destructive">{error}</p>;
  if (!bytes) return <p className="px-0.5 text-[0.72rem] text-muted-foreground">Reading the first bytes…</p>;
  const view = bytes.subarray(0, peekBytes);
  const text = asText(view);
  return (
    <Section title={text !== null ? "First bytes as text" : "First bytes"} aside={<span className="text-[0.65rem] text-muted-foreground tabular-nums">{formatSize(view.length)} of {formatSize(item.bytes)}</span>}>
      <pre className={cn("max-h-80 overflow-auto rounded-lg border bg-background/60 px-2.5 py-2 font-mono text-[0.7rem] leading-relaxed", text !== null && "break-words whitespace-pre-wrap")}>
        {text ?? hexDump(view)}
      </pre>
    </Section>
  );
}

function ArtifactPreview({ name, version, frame }: { name: string; version?: string; frame: Frame }) {
  const { remote } = useStack();
  const latest = useContentRead<ContentArtifact>("artifacts_show", version ? null : { name });
  const versions = useContentRead<{ versions: ContentArtifact[] }>("artifacts_versions", version ? { name } : null);
  const artifact = version ? versions.data?.versions.find((item) => item.version === version) ?? null : latest.data;
  const read = version ? versions : latest;
  if (!artifact) return frame(`artifact · ${name}`, <Empty icon={EyeIcon} title={read.error ?? (read.data ? "That version no longer exists" : "Loading…")} />, true, read.at, read.error);
  const tombstoned = Boolean(artifact.deleted);
  return frame(`artifact · ${artifact.kind}`, (
    <>
      <div className="flex flex-col gap-1.5">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-[0.9rem] font-semibold tracking-tight">{artifact.title || artifact.name}</span>
          {tombstoned ? <span className="shrink-0 rounded bg-destructive/10 px-1.5 py-px text-[0.64rem] font-medium text-destructive">tombstoned</span>
            : artifact.latest ? <span className="shrink-0 rounded bg-success/15 px-1.5 py-px text-[0.64rem] font-medium text-success">latest</span> : null}
        </div>
        <div className="flex flex-wrap items-center gap-1">{(artifact.tags ?? []).map((tag) => <TagChip key={tag} tag={tag} />)}</div>
        {!tombstoned ? (
          <div className="flex flex-wrap items-center gap-1.5">
            <OriginLink which="artifact" path={artifact.version_url} label="Open this version" />
             {artifact.latest || !version ? <OriginLink which="artifact" path={remote ? artifact.version_url : artifact.url} label="Open latest" /> : null}
          </div>
        ) : null}
        <dl className="flex flex-col rounded-lg border bg-background/50 px-2.5 py-1">
          <Row label="Name" mono>{artifact.name}</Row>
          <Row label="Kind">{artifact.kind}</Row>
          <Row label="Version" mono copy={artifact.version}>{artifact.version.slice(0, 16)}…</Row>
          {typeof artifact.files === "number" ? <Row label="Files">{artifact.files}</Row> : null}
          {typeof artifact.bytes === "number" ? <Row label="Size">{formatSize(artifact.bytes)}</Row> : null}
          {artifact.media_type ? <Row label="Media type" mono>{artifact.media_type}</Row> : null}
          {artifact.created_at ? <Row label="Published"><IsoTime at={artifact.created_at} /></Row> : null}
          <Row label="Citation" mono copy={artifact.version_url}><LinkIcon className="mr-1 inline size-3" />{artifact.version_url}</Row>
          <Row label="Latest" mono copy={artifact.url}>{artifact.url}</Row>
          {tombstoned ? <Row label="Reason">{artifact.deleted_reason ?? "—"}</Row> : null}
        </dl>
      </div>
      <p className="px-0.5 text-[0.7rem] text-pretty text-muted-foreground">
        Artifacts run their own scripts, so they open only on their isolated Artifact origin in a new tab. That origin refuses to be embedded, and this page never renders their bytes.
      </p>
      <OpenLocally />
    </>
  ), false, read.at, read.error);
}
