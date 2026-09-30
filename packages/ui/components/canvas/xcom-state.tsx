"use client";

import { useEffect, useRef, useState } from "react";
import { ArchiveIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { localOperation, stateOperations } from "@/lib/stack/state";
import { errorMessage } from "./auth-actions";
import { StateFlowView, useStateFlow } from "./state-flow";
import { Row } from "./primitives";
import { useStack, useStore } from "./provider";
import { Section, Window } from "./window";

type XcomStatus = { paused: boolean; tweets: number; articles: number; unfetched_articles: number; unavailable_articles: number; users: number;
  sync: { running: boolean; mode: "head" | "backfill" | "articles" | null; last_error: string | null };
  head: { cursor: string | null; stop_reason: string | null }; backfill: { cursor: string | null; stop_reason: string | null } };
type Post = { tweet_id: string; author_handle: string | null; created_at: string | null; content: string | null; article_title: string | null };
type Article = { tweet_id: string; author_handle: string | null; title: string; attempted_at: string | null; error: string | null };
type Kind = "posts" | "article_attempts" | "checkpoint";
const hint = "text-[0.68rem] text-pretty text-muted-foreground";
const page = 50;

/**
 * Xcom's archive maintenance, inside System as local operator state. Cleanup requires a persistent pause and a
 * drained sync. Xcom publishes no events, so status is re-read after actions and observed while it drains.
 */
export function XcomStateWindow() {
  const state = useStack();
  const store = useStore();
  const { remote, status, endpoints, xcomGeneration } = state;
  const [data, setData] = useState<XcomStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toggling, setToggling] = useState(false);
  const [draining, setDraining] = useState(false);
  const [kind, setKind] = useState<Kind>("posts");
  const access = localOperation(state, "xcom", "xcom_status");
  const connected = status.xcom === "open";
  const read = () => store.call<XcomStatus>("xcom", "xcom_status").then((value) => { setData(value); setError(null); return value; }, (cause: unknown) => { setError(errorMessage(cause)); return null; });
  // Re-read on (re)connect; Xcom has no change events.
  useEffect(() => { if (!remote && access.available && connected) void read(); }, [xcomGeneration, connected, remote, access.available]);
  // A bounded observation while a paused sync finishes: two-second reads for at most a minute.
  const drain = useRef(0);
  const observe = async () => {
    const mine = ++drain.current;
    setDraining(true);
    for (let attempt = 0; attempt < 30 && mine === drain.current; attempt++) {
      const value = await read();
      if (!value?.sync.running) break;
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    if (mine === drain.current) setDraining(false);
  };
  useEffect(() => () => { drain.current++; }, []);
  const control = (paused: boolean) => {
    setToggling(true);
    store.call<{ paused: boolean; running: boolean }>("xcom", "xcom_control", { paused })
      .then((result) => { if (paused && result.running) void observe(); else void read(); }, (cause) => toast.error(errorMessage(cause)))
      .finally(() => setToggling(false));
  };
  if (remote) {
    return (
      <Window id="xcom-state" title="Xcom" icon={ArchiveIcon} accent="server" empty>
        <div className="flex flex-col items-center gap-1.5 p-6 text-center">
          <ArchiveIcon className="size-5 text-muted-foreground/70" />
          <p className="text-sm font-medium">Available only on the local UI</p>
          <p className="max-w-72 text-[0.72rem] text-pretty text-muted-foreground">The Xcom archive and its controls stay on the Stack machine.</p>
        </div>
      </Window>
    );
  }
  const unavailable = !connected ? "The xcom connection is not open." : !data ? "Reading Xcom status…" : !data.paused ? "Pause Xcom first."
    : data.sync.running ? "Wait for the running sync to finish." : null;
  return (
    <Window id="xcom-state" title="Xcom" subtitle="archive maintenance" icon={ArchiveIcon} accent="server" status={status.xcom} endpoint={endpoints.xcom} error={error} empty={!data}>
      {!access.available ? <p className={hint}>{access.reason}</p> : !data ? <p className={hint}>{error ? `Xcom unavailable: ${error}` : "Reading Xcom status…"}</p> : (
        <div className="flex flex-col gap-2.5">
          <div className="flex items-center gap-3 rounded-xl border px-3 py-2.5">
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="text-sm font-medium">{data.paused ? data.sync.running ? "Pausing: a sync is finishing" : "Paused" : data.sync.running ? `Syncing ${data.sync.mode ?? ""}` : "Admitting scans"}</span>
              <span className={hint}>{data.paused ? "No scans start; late results from an aborted request are fenced." : "Configured or requested scans may fetch from X and spend."}</span>
            </div>
            {toggling || draining ? <Spinner /> : null}
            <Switch checked={!data.paused} disabled={!connected || toggling} aria-label="Admit Xcom scans" onCheckedChange={(on) => control(!on)} />
          </div>
          <dl>
            <Row label="Posts">{data.tweets.toLocaleString()}</Row>
            <Row label="Articles">{data.articles.toLocaleString()} · {data.unfetched_articles} unfetched · {data.unavailable_articles} unavailable</Row>
            <Row label="Authors">{data.users.toLocaleString()}</Row>
          </dl>
          <Section title="Clear archive data" aside={<Button size="xs" variant="ghost" className="-mr-1.5 h-5 text-[0.65rem]" onClick={() => void read()}>Refresh</Button>}>
            <ToggleGroup value={[kind]} onValueChange={(next: string[]) => { if (next.length) setKind(next[0] as Kind); }} spacing={0} size="sm" variant="outline" aria-label="What to clear" className="flex-wrap">
              <ToggleGroupItem value="posts">Posts</ToggleGroupItem>
              <ToggleGroupItem value="article_attempts">Article attempts</ToggleGroupItem>
              <ToggleGroupItem value="checkpoint">Scan checkpoint</ToggleGroupItem>
            </ToggleGroup>
            {kind === "posts" ? <PostsClear unavailable={unavailable} generation={xcomGeneration} onDone={() => void read()} /> : null}
            {kind === "article_attempts" ? <ArticlesClear unavailable={unavailable} generation={xcomGeneration} onDone={() => void read()} /> : null}
            {kind === "checkpoint" ? <CheckpointClear unavailable={unavailable} onDone={() => void read()} /> : null}
          </Section>
        </div>
      )}
    </Window>
  );
}

function useXcomFlow(selection: Record<string, unknown>, slot: string, onDone: (completed: boolean) => void) {
  const store = useStore();
  return useStateFlow({ operations: stateOperations(store.call, "xcom", { plan: "xcom_history_plan", apply: "xcom_history_clear", receipt: "xcom_state_receipt_get" }, selection),
    recoveryKey: `xcom:${slot}`, onReceipt: (receipt) => onDone(receipt.status === "completed") });
}

function useRows<T>(operation: string, generation: number) {
  const store = useStore();
  const [rows, setRows] = useState<{ items: T[]; next: number | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = (offset: number) => store.call<{ results: T[]; next_offset: number | null }>("xcom", operation, { limit: page, offset })
    .then((value) => setRows((held) => ({ items: offset && held ? [...held.items, ...value.results] : value.results, next: value.next_offset })), (cause: unknown) => setError(errorMessage(cause)));
  useEffect(() => { void load(0); }, [generation]);
  return { rows, error, load };
}

function Choice<T extends string>({ label, value, options, disabled, onChange }: { label: string; value: T | null; options: [T, string][]; disabled: boolean; onChange(value: T): void }) {
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-col gap-0.5 text-xs">
      <span className="text-muted-foreground">{label}</span>
      {options.map(([option, text]) => (
        <label key={option} className="flex items-center gap-1.5"><input type="radio" checked={value === option} disabled={disabled} onChange={() => onChange(option)} />{text}</label>
      ))}
    </div>
  );
}

function PostsClear({ unavailable, generation, onDone }: { unavailable: string | null; generation: number; onDone(): void }) {
  const { rows, error, load } = useRows<Post>("xcom_list", generation);
  const [ids, setIds] = useState<string[]>([]);
  const [reimport, setReimport] = useState<"allow" | "suppress" | null>(null);
  const [authors, setAuthors] = useState<"retain" | "remove" | null>(null);
  const flow = useXcomFlow({ kind: "posts", ids, reimport: reimport ?? "allow", orphanAuthors: authors ?? "retain" }, "posts", (completed) => { onDone(); if (completed) setIds([]); void load(0); });
  const locked = flow.flow.phase !== "idle";
  return (
    <div className="flex flex-col gap-1.5">
      <p className={hint}>Removes each selected post with its raw capture, article and search index entry together. Authors other posts share are kept.</p>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      <ul aria-label="Archived posts" className="flex max-h-56 flex-col overflow-auto">
        {rows?.items.map((post) => (
          <li key={post.tweet_id}>
            <label className="flex items-start gap-1.5 py-0.5 text-xs">
              <input type="checkbox" className="mt-0.5 size-3.5 accent-destructive" checked={ids.includes(post.tweet_id)} disabled={locked || (!ids.includes(post.tweet_id) && ids.length >= 100)}
                onChange={() => setIds(ids.includes(post.tweet_id) ? ids.filter((id) => id !== post.tweet_id) : [...ids, post.tweet_id])} />
              <span className="flex min-w-0 flex-col"><span className="font-mono text-[0.66rem] text-muted-foreground">@{post.author_handle ?? "unknown"} · {post.tweet_id}</span>
                <span className="line-clamp-2">{post.article_title ?? post.content ?? ""}</span></span>
            </label>
          </li>
        ))}
      </ul>
      {rows?.next != null ? <Button size="xs" variant="ghost" className="self-start" onClick={() => void load(rows.next!)}>Load more</Button> : null}
      <Choice<"allow" | "suppress"> label="If a later scan sees these posts again" value={reimport} disabled={locked} onChange={setReimport}
        options={[["allow", "Archive them again"], ["suppress", "Keep them out of the archive"]]} />
      <Choice<"retain" | "remove"> label="Authors left with no posts" value={authors} disabled={locked} onChange={setAuthors}
        options={[["retain", "Keep their records"], ["remove", "Remove them"]]} />
      <StateFlowView controls={flow} label={`Prepare removing ${ids.length} post${ids.length === 1 ? "" : "s"}`} applyLabel="Remove these posts"
        unavailable={unavailable ?? (!ids.length ? "Select posts first." : !reimport || !authors ? "Choose reimport and author handling." : null)} />
    </div>
  );
}

function ArticlesClear({ unavailable, generation, onDone }: { unavailable: string | null; generation: number; onDone(): void }) {
  const { rows, error, load } = useRows<Article>("xcom_articles_pending", generation);
  const [ids, setIds] = useState<string[]>([]);
  const flow = useXcomFlow({ kind: "article_attempts", ids }, "article_attempts", (completed) => { onDone(); if (completed) setIds([]); void load(0); });
  const locked = flow.flow.phase !== "idle";
  return (
    <div className="flex flex-col gap-1.5">
      <p className={hint}>Clears the recorded failed fetch attempts for the selected unfetched articles, so they become eligible to try again. The posts stay.</p>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      <ul aria-label="Unfetched articles" className="flex max-h-56 flex-col overflow-auto">
        {rows?.items.map((article) => (
          <li key={article.tweet_id}>
            <label className="flex items-start gap-1.5 py-0.5 text-xs">
              <input type="checkbox" className="mt-0.5 size-3.5 accent-destructive" checked={ids.includes(article.tweet_id)} disabled={locked || (!ids.includes(article.tweet_id) && ids.length >= 100)}
                onChange={() => setIds(ids.includes(article.tweet_id) ? ids.filter((id) => id !== article.tweet_id) : [...ids, article.tweet_id])} />
              <span className="flex min-w-0 flex-col"><span className="line-clamp-1">{article.title}</span>
                <span className="text-[0.66rem] text-muted-foreground">{article.attempted_at ? `last attempt ${article.attempted_at}${article.error ? ` · ${article.error}` : ""}` : "never attempted"}</span></span>
            </label>
          </li>
        ))}
      </ul>
      {rows && !rows.items.length ? <p className={hint}>No unfetched articles.</p> : null}
      {rows?.next != null ? <Button size="xs" variant="ghost" className="self-start" onClick={() => void load(rows.next!)}>Load more</Button> : null}
      <StateFlowView controls={flow} label={`Prepare clearing ${ids.length} attempt record${ids.length === 1 ? "" : "s"}`} applyLabel="Clear these attempts"
        unavailable={unavailable ?? (!ids.length ? "Select articles first." : null)} />
    </div>
  );
}

function CheckpointClear({ unavailable, onDone }: { unavailable: string | null; onDone(): void }) {
  const [scan, setScan] = useState<"head" | "backfill" | null>(null);
  const flow = useXcomFlow({ kind: "checkpoint", scan: scan ?? "head" }, "checkpoint", () => onDone());
  return (
    <div className="flex flex-col gap-1.5">
      <p className={hint}>Resets where one scan resumes. After you resume Xcom, that scan starts over and may fetch and spend again. Archived posts are unchanged.</p>
      <Choice<"head" | "backfill"> label="Scan" value={scan} disabled={flow.flow.phase !== "idle"} onChange={setScan} options={[["head", "Newest-first (head)"], ["backfill", "Backfill"]]} />
      <StateFlowView controls={flow} label="Prepare checkpoint reset" applyLabel="Reset this checkpoint" unavailable={unavailable ?? (!scan ? "Choose a scan." : null)} />
    </div>
  );
}
