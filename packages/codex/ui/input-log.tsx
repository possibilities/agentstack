import type { InputObservation, InputObservationTarget, InputObservationIssue } from "../src/input-observer";
import { startInputObservation, stopInputObservation } from "./actions";
import type { TreeNode } from "./agent-tree";

type Log = { targets: InputObservationTarget[]; entries: InputObservation[]; issues: InputObservationIssue[] } | null;

function availableThreads(tree: TreeNode[] | null): Array<{ serverId: string; threadId: string; label: string }> {
  if (!tree) return [];
  const items: Array<{ serverId: string; threadId: string; label: string }> = [];
  const walk = (serverId: string, nodes: TreeNode[]) => {
    for (const node of nodes) {
      items.push({ serverId, threadId: node.id, label: node.label });
      walk(serverId, node.children ?? []);
    }
  };
  for (const server of tree) walk(server.id, server.children ?? []);
  return items;
}

function InputRow({ entry }: { entry: InputObservation }) {
  const time = entry.observedAt.replace("T", " ").slice(0, 19) + " UTC";
  return (
    <li className="border-t border-border py-3">
      <details className="group">
        <summary className="grid cursor-pointer list-none grid-cols-[minmax(155px,auto)_minmax(100px,auto)_minmax(0,1fr)] items-baseline gap-x-4 gap-y-1 text-sm marker:hidden hover:text-foreground focus-visible:outline-2 focus-visible:outline-focus max-[700px]:grid-cols-1">
          <time dateTime={entry.observedAt} className="font-mono text-xs text-muted-foreground">{time}</time>
          <span className="font-medium">{entry.disposition} <span className="font-normal text-muted-foreground">· {entry.origin}</span></span>
          <span className="min-w-0 truncate text-muted-foreground">{entry.originalText}</span>
        </summary>
        <div className="mt-3 grid min-w-0 gap-2 pl-1 text-sm">
          <p className="font-mono text-xs text-muted-foreground">{entry.serverId} / {entry.threadId} / {entry.inputId}</p>
          <p className="font-medium">Original input</p>
          <pre className="min-w-0 whitespace-pre-wrap break-words font-sans leading-relaxed">{entry.originalText}</pre>
          {entry.selectedText !== null && entry.selectedText !== entry.originalText ? (
            <><p className="font-medium">Selected input</p><pre className="min-w-0 whitespace-pre-wrap break-words font-sans leading-relaxed">{entry.selectedText}</pre></>
          ) : null}
          {entry.operationId ? <p>Operation <code className="font-mono">{entry.operationId}</code></p> : null}
          {entry.effect ? <p>Effect: {entry.effect.status}. {entry.effect.summary}</p> : null}
        </div>
      </details>
    </li>
  );
}

export function InputLog({ tree, log }: { tree: TreeNode[] | null; log: Log }) {
  const threads = availableThreads(tree);
  const active = new Set((log?.targets ?? []).map((target) => JSON.stringify([target.serverId, target.threadId])));
  const available = threads.filter((thread) => !active.has(JSON.stringify([thread.serverId, thread.threadId])));
  return (
    <section aria-labelledby="input-log-heading" className="mt-8 border-t border-border pt-5">
      <h2 id="input-log-heading" className="text-lg font-[550]">Input middleware</h2>
      <p className="mt-1 max-w-[75ch] text-sm text-muted-foreground">Observe direct typed input and finalized voice handoffs on a loaded thread. The initial handler passes input unchanged; routing decisions can be added later. This process keeps the latest 200 candidates and outcomes in memory.</p>
      {log === null ? <p role="status" className="mt-3 text-sm text-muted-foreground">Observation service unavailable.</p> : (
        <>
          <div className="mt-4 flex flex-wrap items-end gap-3">
            {available.length ? (
              <form action={startInputObservation} className="flex flex-wrap items-end gap-2">
                <label className="grid gap-1 text-sm">Thread
                  <select name="target" className="max-w-[min(70vw,380px)] rounded-md border border-border bg-background px-2 py-1.5 text-foreground">
                    {available.map((thread) => <option key={`${thread.serverId}/${thread.threadId}`} value={JSON.stringify([thread.serverId, thread.threadId])}>{thread.serverId} / {thread.label}</option>)}
                  </select>
                </label>
                <button type="submit" className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-surface focus-visible:outline-2 focus-visible:outline-focus">Observe</button>
              </form>
            ) : null}
            {!threads.length ? <p className="text-sm text-muted-foreground">Load a Codex thread to begin observing.</p> : null}
          </div>
          {log.issues.length ? <ul aria-label="Observation errors" className="mt-3 list-none text-sm text-negative">
            {log.issues.map((issue) => <li key={`${issue.serverId}/${issue.threadId}/${issue.at}`}>{issue.serverId} / {issue.threadId}: {issue.message}</li>)}
          </ul> : null}
          {log.targets.length ? <ul aria-label="Observed threads" className="mt-4 flex flex-wrap gap-2">
            {log.targets.map((target) => <li key={`${target.serverId}/${target.threadId}`}>
              <form action={stopInputObservation} className="flex items-center gap-2 border-b border-border py-1 text-sm">
                <span className="font-mono text-xs">{target.serverId} / {target.threadId}</span>
                <input type="hidden" name="serverId" value={target.serverId} />
                <input type="hidden" name="threadId" value={target.threadId} />
                <button type="submit" className="text-muted-foreground underline underline-offset-2 hover:text-foreground focus-visible:outline-2 focus-visible:outline-focus">Stop</button>
              </form>
            </li>)}
          </ul> : null}
          <div className="mt-5">
            <h3 className="text-base font-[550]">Observed inputs <span className="font-normal text-muted-foreground">({log.entries.length} shown)</span></h3>
            {log.entries.length ? <ol aria-label="Input observations" className="mt-2 list-none p-0">
              {log.entries.map((entry) => <InputRow key={`${entry.serverId}/${entry.threadId}/${entry.inputId}`} entry={entry} />)}
            </ol> : <p className="mt-2 text-sm text-muted-foreground">No input candidates observed yet.</p>}
          </div>
        </>
      )}
    </section>
  );
}
