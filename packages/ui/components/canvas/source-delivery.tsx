"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { FileJsonIcon, PackageOpenIcon } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { formatBytes } from "@/lib/stack/resources";
import {
  addChunk, contentTypeLabel, deliveryName, payloadChunkChars, payloadComplete, payloadRenderChars, payloadText, targetKinds, targetLabel, verifyDigest, type DigestResult, type PayloadLoad,
} from "@/lib/stack/source";
import type { GithubDelivery, GithubPayloadChunk } from "@/lib/stack/types";
import { cn } from "@/lib/utils";
import { ContentCleared, CopyButton, Empty, NodeLink, StatusDot } from "./primitives";
import { useStack, useStore, useWorkbench } from "./provider";
import { sourceChip, sourceHint, sourceLabel, sourceUnavailable, Stamp, UntrustedNote, Word } from "./source-shared";
import { Section, Window } from "./window";

const parseSequence = (key: string | undefined): number | null => {
  const match = key?.match(/^github-delivery:([1-9]\d{0,15})$/);
  return match && Number.isSafeInteger(Number(match[1])) ? Number(match[1]) : null;
};

/**
 * One delivery: what Stack observed, the entities it names, the receiver it came through and the digest of its
 * original body. The body itself is read in bounded chunks and drawn as escaped text; nothing in it is interpreted,
 * rendered as markup or followed. Opening a delivery by link reads it directly, wherever the ledger is.
 */
export function DeliveryWindow() {
  const store = useStore();
  const { flash } = useWorkbench();
  const { status, endpoints, sourceSelected: sequence, sourceDeliveries, sourceEndpoints } = useStack();
  // A link to a delivery shows it, even one outside every page the ledger has read.
  useEffect(() => {
    const linked = parseSequence(flash?.key);
    if (linked !== null) store.selectSourceDelivery(linked);
  }, [flash?.seq, flash?.key, store]);
  const held = sequence !== null ? sourceDeliveries[String(sequence)] : undefined;
  const delivery = held?.data ?? null;
  const node = sequence !== null ? { kind: "github-delivery" as const, id: String(sequence) } : undefined;
  const unavailable = sourceUnavailable(endpoints, status);
  const missing = held?.error && /not_found/i.test(held.error);
  return (
    <Window id="source-delivery" title="Delivery" subtitle={delivery ? `#${delivery.sequence} · ${deliveryName(delivery)}` : sequence !== null ? `#${sequence}` : undefined} icon={FileJsonIcon} accent="source"
      node={node} reveal={node} status={endpoints.source ? status.source : undefined} endpoint={endpoints.source} updatedAt={held?.at} error={missing ? null : held?.error} empty={!endpoints.source || !delivery}>
      {!endpoints.source ? <Empty icon={FileJsonIcon} title="Source isn't served by this server" />
        : sequence === null ? <Empty icon={PackageOpenIcon} title="Open a delivery from the ledger" hint="A link to a delivery reads it directly, even when it is not in the loaded page." />
        : missing ? <Empty icon={FileJsonIcon} title={`Delivery #${sequence} does not exist`} hint="Local sequences are assigned on arrival; this one has not been assigned." />
        : !delivery ? (held?.error ? <Alert variant="destructive"><AlertTitle>Delivery #{sequence} could not be read</AlertTitle><AlertDescription>{held.error}</AlertDescription></Alert>
          : <Empty icon={FileJsonIcon} title={unavailable ?? `Reading delivery #${sequence}…`} />)
        : <DeliveryView key={delivery.sequence} delivery={delivery} receiver={sourceEndpoints.data?.find((endpoint) => endpoint.id === delivery.endpointId) ?? null} />}
    </Window>
  );
}

function DeliveryView({ delivery, receiver }: { delivery: GithubDelivery; receiver: { id: string; label: string; target: Parameters<typeof targetLabel>[0] } | null }) {
  const cleared = delivery.payloadClearedAt !== null;
  const fields: [string, string | number | null][] = [
    ["Repository", delivery.repository], ["Repository ID", delivery.repositoryId], ["Organization", delivery.organization], ["Enterprise", delivery.enterprise], ["Sender", delivery.sender],
    ["Installation", delivery.installationId], ["Ref", delivery.ref], ["Commit", delivery.sha],
  ];
  return (
    <>
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
          <span className="font-mono text-[1.02rem] font-semibold">{deliveryName(delivery)}</span>
          {!delivery.knownEvent ? <span className={sourceChip} title="Not in the pinned official catalog; it was still accepted">not in catalog</span> : null}
          <span className="ml-auto text-[0.72rem] text-muted-foreground tabular-nums">#{delivery.sequence}</span>
        </div>
        <p className="flex flex-wrap items-baseline gap-x-3 text-[0.74rem] text-muted-foreground">
          <span>Received <Stamp at={delivery.receivedAt} /></span>
          <span>{contentTypeLabel(delivery.contentType)}</span>
          <span className="tabular-nums">{formatBytes(delivery.payloadBytes)} · {delivery.payloadBytes.toLocaleString("en-US")} bytes</span>
        </p>
      </div>
      <Section title="Summary">
        <dl className="flex flex-col gap-1 text-[0.78rem]">
          <Line label="Receiver">
            <NodeLink node={{ kind: "github-receiver", id: delivery.endpointId }} label={receiver?.label ?? "receiver"} className="font-medium">{receiver?.label ?? `${delivery.endpointId.slice(0, 8)}…`}</NodeLink>
            {receiver && targetLabel(receiver.target) !== targetKinds[receiver.target.kind] ? <span className="ml-1.5 font-mono text-[0.68rem] text-muted-foreground">{targetLabel(receiver.target)}</span> : null}
          </Line>
          <Line label="Delivery GUID" copy={delivery.deliveryId}><span className="font-mono text-[0.72rem]" title={delivery.deliveryId}>{delivery.deliveryId}</span></Line>
          {fields.filter(([, value]) => value !== null).map(([label, value]) => <Line key={label} label={label}><span className="font-mono text-[0.74rem]">{String(value)}</span></Line>)}
          <Line label="Hook"><span className="font-mono text-[0.74rem]">{delivery.hookId ?? "—"}{delivery.targetType ? ` · ${delivery.targetType}${delivery.targetId ? ` ${delivery.targetId}` : ""}` : ""}</span></Line>
        </dl>
        <p className={sourceHint}>Event, delivery and hook headers are observed metadata. Only the body bytes were authenticated by the receiver&rsquo;s signature, and the sequence is Stack&rsquo;s arrival order, not GitHub&rsquo;s.</p>
      </Section>
      <Section title="Entities" aside={<span className="text-[0.68rem] text-muted-foreground tabular-nums">{delivery.entities.length}</span>}>
        {delivery.entities.length ? (
          <ul className="flex flex-col gap-1.5">
            {delivery.entities.map((entity, index) => (
              <li key={`${entity.kind}:${entity.id}:${index}`} className="flex flex-col gap-0.5 rounded-lg border px-2.5 py-1.5 text-[0.76rem]">
                <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                  <span className={sourceChip}>{entity.kind}</span>
                  {entity.number !== null ? <span className="font-mono tabular-nums">#{entity.number}</span> : entity.id !== null ? <span className="font-mono">{String(entity.id)}</span> : null}
                  {entity.state ? <span className="text-muted-foreground">{entity.state}</span> : null}
                  {entity.conclusion ? <span className="text-muted-foreground">· {entity.conclusion}</span> : null}
                </span>
                {entity.title ? <span className="text-pretty break-words">{entity.title}</span> : null}
                {entity.url ? <span className="flex min-w-0 items-center gap-1 font-mono text-[0.68rem] text-muted-foreground"><span className="min-w-0 truncate" title={entity.url}>{entity.url}</span><CopyButton value={entity.url} label="URL" /></span> : null}
              </li>
            ))}
          </ul>
        ) : <p className={sourceHint}>No top-level entity was named in this payload.</p>}
        <UntrustedNote />
      </Section>
      <Section title="Digest">
        <dl className="flex flex-col gap-1 text-[0.78rem]">
          <Line label="SHA-256 of the body" copy={delivery.payloadSha256}><span className="font-mono text-[0.68rem]" title={delivery.payloadSha256}>{delivery.payloadSha256}</span></Line>
          <Line label="Original payload">{cleared ? <Word tone="muted">Cleared</Word> : <Word tone="success">Retained</Word>}</Line>
        </dl>
      </Section>
      <Section title="Original payload">
        {cleared ? (
          <div className="flex flex-col gap-1">
            <p className="text-[0.8rem]"><ContentCleared at={delivery.payloadClearedAt} label="Original payload cleared" /></p>
            <p className={sourceHint}>The summary, digest, duplicate fence, watch matches and acknowledgements remain. GitHub redelivering this delivery does not restore the body.</p>
          </div>
        ) : <PayloadReader delivery={delivery} />}
      </Section>
    </>
  );
}

function Line({ label, copy, children }: { label: string; copy?: string; children: React.ReactNode }) {
  return (
    <div className="group/row flex min-h-6 items-baseline gap-3">
      <dt className="w-28 shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 flex-1 truncate">{children}</dd>
      {copy ? <CopyButton value={copy} label={label.toLowerCase()} className="-mr-1.5 self-center" /> : null}
    </div>
  );
}

type Reading = { load: PayloadLoad | null; busy: boolean; error: string | null; notice: string | null; digest: DigestResult | "checking" | null };

/** Bounded chunks of the original body. The digest is checked once, over the whole reconstruction, never per chunk. */
function PayloadReader({ delivery }: { delivery: GithubDelivery }) {
  const store = useStore();
  const { status } = useStack();
  const [reading, setReading] = useState<Reading>({ load: null, busy: false, error: null, notice: null, digest: null });
  const run = useRef(0);
  const stop = useRef(false);
  const live = useRef(reading.load);
  live.current = reading.load;
  const open = status.source === "open";

  const read = useCallback(async (all: boolean) => {
    const mine = ++run.current;
    stop.current = false;
    setReading((held) => ({ ...held, busy: true, error: null, digest: held.load && payloadComplete(held.load) ? held.digest : null }));
    let current = live.current;
    try {
      let restarted = false;
      for (;;) {
        const offset = current && !current.cleared ? current.loaded : 0;
        const chunk = await store.call<GithubPayloadChunk>("source", "github_delivery_payload", { sequence: delivery.sequence, offset, limit: payloadChunkChars });
        if (mine !== run.current) return;
        const next = addChunk(current, chunk, offset);
        if (!next) { current = null; restarted = true; setReading((held) => ({ ...held, load: null, digest: null, notice: "The body changed while it was being read, so reading started over." })); continue; }
        current = next;
        setReading((held) => ({ ...held, load: next, notice: next.cleared ? "The original payload was cleared; what was loaded has been discarded." : restarted ? held.notice : null }));
        if (next.cleared || next.nextOffset === null || !all || stop.current) break;
      }
      if (mine === run.current) setReading((held) => ({ ...held, busy: false }));
    } catch (failure) {
      if (mine === run.current) setReading((held) => ({ ...held, busy: false, error: failure instanceof Error ? failure.message : String(failure) }));
    }
  }, [store, delivery.sequence]);

  // The whole body, once complete: SHA-256 over its UTF-8 bytes against the receipt's digest.
  const complete = payloadComplete(reading.load);
  useEffect(() => {
    if (!complete || !live.current) return;
    let current = true;
    const text = payloadText(live.current);
    setReading((held) => ({ ...held, digest: "checking" }));
    void verifyDigest(text, delivery.payloadSha256).then((result) => { if (current) setReading((held) => ({ ...held, digest: result })); });
    return () => { current = false; };
  }, [complete, delivery.payloadSha256]);
  // A cleanup that lands while a body is open replaces this reader with the cleared marker, which discards the loaded text; leaving also ends any read.
  useEffect(() => () => { run.current++; }, []);

  const { load } = reading;
  const text = load && !load.cleared ? payloadText(load) : "";
  const total = load?.total ?? delivery.payloadBytes;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {!load ? (
          <Button size="sm" variant="outline" disabled={!open || reading.busy} onClick={() => void read(false)}>
            {reading.busy ? <Spinner data-icon="inline-start" /> : null}Read original body
          </Button>
        ) : !complete && !load.cleared ? (
          <>
            <Button size="sm" variant="outline" disabled={!open || reading.busy} onClick={() => void read(false)}>Load next chunk</Button>
            <Button size="sm" variant="outline" disabled={!open || reading.busy} onClick={() => void read(true)}>Load the rest</Button>
            {reading.busy ? <Button size="sm" variant="ghost" onClick={() => { stop.current = true; }}>Stop after this chunk</Button> : null}
          </>
        ) : null}
        {reading.busy ? <Spinner /> : null}
        {load && !load.cleared ? <span className="ml-auto text-[0.72rem] text-muted-foreground tabular-nums" aria-live="polite">{load.loaded.toLocaleString("en-US")} of {load.total.toLocaleString("en-US")} characters</span> : null}
      </div>
      {!load ? <p className={sourceHint}>{total ? `The body is ${delivery.payloadBytes.toLocaleString("en-US")} bytes. It is read in chunks of ${payloadChunkChars.toLocaleString("en-US")} characters, only when you ask.` : "Nothing has been read."}</p> : null}
      {reading.error ? <p role="alert" className="text-[0.72rem] text-destructive">{reading.error}</p> : null}
      {reading.notice ? <p role="status" className="text-[0.72rem] text-warning">{reading.notice}</p> : null}
      {load && !load.cleared ? (
        <>
          <pre tabIndex={0} aria-label="Original payload text" data-payload-text className="max-h-80 overflow-auto rounded-lg bg-muted/60 p-2.5 font-mono text-[0.7rem] leading-relaxed whitespace-pre-wrap break-all focus-visible:outline-2 focus-visible:outline-ring">{text.length > payloadRenderChars ? text.slice(0, payloadRenderChars) : text}</pre>
          {text.length > payloadRenderChars ? <p className={sourceHint}>Showing the first {payloadRenderChars.toLocaleString("en-US")} characters. The rest is held for the digest check but not drawn.</p> : null}
          <p role="status" className="flex items-start gap-1.5 text-[0.72rem]">
            <StatusDot tone={reading.digest === "verified" ? "success" : reading.digest === "mismatch" ? "destructive" : "muted"} className="mt-1" />
            <span className={cn(reading.digest === "mismatch" ? "text-destructive" : "text-muted-foreground")}>
              {reading.digest === "verified" ? <><span className="font-medium text-foreground">Digest verified.</span> SHA-256 over all {load.total.toLocaleString("en-US")} characters matches the receipt.</>
                : reading.digest === "mismatch" ? <><span className="font-medium">Digest does not match.</span> The loaded text&rsquo;s SHA-256 differs from the receipt. The body may not be valid UTF-8, or it changed.</>
                : reading.digest === "unavailable" ? "This browser context offers no SHA-256, so the digest was not checked."
                : reading.digest === "checking" ? "Checking the digest…"
                : "Not verified: the digest is checked only after the whole body is loaded."}
            </span>
          </p>
        </>
      ) : null}
      {delivery.contentType === "application/x-www-form-urlencoded" ? <p className={sourceHint}>This body is form-encoded: the JSON travels percent-encoded in its <code>payload</code> field, shown here exactly as received.</p> : null}
      <p className={sourceLabel}>Untrusted content</p>
      <UntrustedNote />
    </div>
  );
}
