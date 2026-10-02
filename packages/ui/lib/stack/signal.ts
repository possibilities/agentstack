import type { AttentionChunk, AttentionItem, AttentionItemState, AttentionStatus, AttentionUrgency, Bot } from "./types";

/** States that still ask something of their audience. */
export const unresolvedStates: AttentionItemState[] = ["open", "partial", "unclear"];
export const resolvedStates: AttentionItemState[] = ["answered", "satisfied", "declined", "withdrawn", "superseded"];

/** Source polling kinds; they never change attention records and dominate the change log. */
export const readEventKinds = ["source_read", "source_read_failed"];

const urgencyRank: Record<AttentionUrgency, number> = { immediate: 0, soon: 1, routine: 2, unspecified: 3 };

/** Queue order: urgency, then a stated deadline, then the newest item. */
export function queueOrder(a: AttentionItem, b: AttentionItem): number {
  return urgencyRank[a.timing.urgency] - urgencyRank[b.timing.urgency]
    || Number(b.timing.deadline !== null) - Number(a.timing.deadline !== null)
    || b.cursor - a.cursor;
}

export type ConversationRef = { kind: "bot"; botId: string; threadId: string } | { kind: "worker"; workerId: string } | { kind: "other"; id: string };

/** Signal conversation keys: `bot:<botId>:<threadId>` for Bot chats, `worker:<workerId>` for Worker transcripts. */
export function parseConversation(conversation: string): ConversationRef {
  const bot = /^bot:([^:]+):(.+)$/.exec(conversation);
  if (bot) return { kind: "bot", botId: bot[1]!, threadId: bot[2]! };
  const worker = /^worker:(.+)$/.exec(conversation);
  if (worker) return { kind: "worker", workerId: worker[1]! };
  return { kind: "other", id: conversation };
}

/** Whether a conversation is the Bot's sanctioned main thread, the one Fleet chat windows show. */
export function isMainThread(conversation: string, bots: Bot[] | null): boolean {
  const ref = parseConversation(conversation);
  return ref.kind === "bot" && bots?.some((bot) => bot.id === ref.botId && bot.mainThreadId === ref.threadId) === true;
}

export function conversationLabel(conversation: string, bots: Bot[] | null): string {
  const ref = parseConversation(conversation);
  if (ref.kind === "worker") return `Worker ${ref.workerId.slice(0, 8)}`;
  if (ref.kind === "other") return ref.id;
  return `${ref.botId} · ${isMainThread(conversation, bots) ? "main" : `thread ${ref.threadId.slice(0, 8)}`}`;
}

export function jobCounts(status: AttentionStatus | null): Record<string, number> {
  return Object.fromEntries((status?.jobs ?? []).map((row) => [row.state, row.count]));
}

/** Local preconditions only; the plan additionally proves source reads and native inference are drained. */
export function checkpointUnavailable(status: AttentionStatus): string | null {
  if (!status.baselined) return "Establish the first baseline before rebaselining checkpoints.";
  if (status.enabled) return "Pause interpretation before rebaselining checkpoints.";
  if (status.jobs.some((job) => (job.state === "pending" || job.state === "running") && job.count > 0))
    return "Resolve pending and running interpretations first; captured-content clearing is a separate action.";
  return null;
}

/**
 * Read a whole attention_*_read export. Each chunk is fenced by the first
 * chunk's revision; a changed export restarts from zero.
 */
export async function readChunks(read: (args: Record<string, unknown>) => Promise<AttentionChunk>, args: Record<string, unknown>, attempts = 3): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    try {
      let text = "";
      let revision: string | undefined;
      for (;;) {
        const chunk = await read({ ...args, offset: text.length, limit: 32_000, ...(revision ? { revision } : {}) });
        revision = chunk.revision;
        text += chunk.text;
        if (chunk.nextOffset >= chunk.totalChars || !chunk.text) return text;
      }
    } catch (error) {
      if (attempt + 1 >= attempts || !/attention_export_changed/.test(String(error))) throw error;
    }
  }
}

export type Segment = { text: string; start: number; items: string[] };

/** Split text at every evidence boundary so overlapping spans each keep their items. */
export function evidenceSegments(text: string, spans: Array<{ id: string; start: number; end: number }>): Segment[] {
  const valid = spans.filter((span) => span.start >= 0 && span.end > span.start && span.end <= text.length);
  const cuts = [...new Set([0, text.length, ...valid.flatMap((span) => [span.start, span.end])])].sort((a, b) => a - b);
  const segments: Segment[] = [];
  for (let index = 0; index < cuts.length - 1; index++) {
    const start = cuts[index]!;
    const end = cuts[index + 1]!;
    segments.push({ text: text.slice(start, end), start, items: valid.filter((span) => span.start <= start && span.end >= end).map((span) => span.id) });
  }
  return segments;
}

type AnnotatedItem = { summary: string; evidence: { quote: string; occurrence: number }; state: string; attention: { reason: string }; audience: { kind: string } };
export type ItemPair = { quote: string; original: AnnotatedItem | null; replay: AnnotatedItem | null };

/** Pair two interpretations of the same frozen input by their exact evidence quotes. */
export function pairInterpretations(original: AnnotatedItem[], replay: AnnotatedItem[]): ItemPair[] {
  const key = (item: AnnotatedItem) => `${item.evidence.occurrence}\u0000${item.evidence.quote}`;
  const remaining = new Map<string, AnnotatedItem[]>();
  for (const item of replay) remaining.set(key(item), [...(remaining.get(key(item)) ?? []), item]);
  const pairs: ItemPair[] = original.map((item) => {
    const match = remaining.get(key(item))?.shift() ?? null;
    return { quote: item.evidence.quote, original: item, replay: match };
  });
  for (const rest of remaining.values()) for (const item of rest) pairs.push({ quote: item.evidence.quote, original: null, replay: item });
  return pairs;
}

const errorCopy: Record<string, string> = {
  no_available_codex_account: "No enabled Codex Bot account is available",
  attention_settings_conflict: "Defaults changed elsewhere; showing the latest",
  attention_export_changed: "The export changed while reading",
  replay_request_conflict: "That replay key already belongs to another run",
  infer_busy: "Inference is busy",
  codex_rate_limited: "The Codex account is rate limited",
  codex_sign_in_required: "The Codex account needs sign-in",
};

export function signalErrorText(code: string): string {
  const bare = code.replace(/^Error: /, "");
  return errorCopy[bare] ?? errorCopy[bare.split(":")[0]!] ?? bare;
}
