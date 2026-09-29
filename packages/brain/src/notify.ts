import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { socketCall, socketPath } from "@stack/api";
import { brainEnvironment, brainStateRoot } from "./paths.js";
import { dirname, join } from "node:path";

/**
 * Operator notification.
 *
 * Stack Brain acknowledges a submission at Admission, long before extraction and
 * indexing decide whether it succeeded. When a job reaches a stranded terminal
 * state there is no request left to fail and no reader watching the ledger, so
 * the ingress that accepted the link records a durable notification.
 *
 * Delivery is best-effort by design: the ingestion outcome is the product and a
 * notification only carries it. An unavailable notify Package API is never an
 * ingestion error.
 */

interface NotifySignal {
  id: string;
  title: string;
  message: string;
  source: string;
  group: string;
}

const DOCTOR_SOURCE = "stack.brain.doctor";
// One open stranded notice at a time: a higher count replaces the one the operator has not dismissed.
const STRANDED_GROUP = "stack.brain.stranded";

export function defaultNotifyStatePath(home?: string): string {
  return join(brainStateRoot(brainEnvironment(), home), "doctor-notify.json");
}

function noticeId(path: string, previous: NotifyState | null, stranded: number): string {
  // A lost socket response may follow a committed send. Derive the same UUID
  // until the baseline advances, then use a new ID for the next increase.
  const hex = createHash("sha256").update(JSON.stringify([path, previous?.notified_at ?? null, stranded])).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

const sendNotice = (signal: NotifySignal): Promise<unknown> =>
  socketCall(socketPath("notify", brainEnvironment()), "tools/call", { name: "notification_send", arguments: signal }, { timeoutMs: 3_000 });

interface NotifyState {
  stranded: number;
  notified_at: string;
}

function readState(path: string): NotifyState | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(
      readFileSync(path, "utf8"),
    ) as Partial<NotifyState>;
    if (typeof parsed.stranded !== "number") return null;
    return {
      stranded: parsed.stranded,
      notified_at:
        typeof parsed.notified_at === "string" ? parsed.notified_at : "",
    };
  } catch {
    return null;
  }
}

function writeState(path: string, state: NotifyState): void {
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  } catch {
    // A state file we cannot persist costs a repeat notification, not an error.
  }
}

export interface StrandedNotifyResult {
  notified: boolean;
  reason: "unchanged" | "increased" | "cleared" | "notify_unavailable";
  stranded: number;
  previous: number | null;
}

/**
 * Notify only when the stranded count moves.
 *
 * A periodic health check runs far more often than ingestion fails, so posting
 * on every unhealthy report would train the operator to ignore the one that
 * matters. Growth is news; a steady backlog the operator has already seen is
 * not. Recovery to zero resets the baseline silently so the next failure
 * notifies again.
 */
export async function notifyStranded(
  stranded: number,
  options: { statePath?: string; now?: Date; send?: (signal: NotifySignal) => Promise<unknown> } = {},
): Promise<StrandedNotifyResult> {
  const path = options.statePath ?? defaultNotifyStatePath();
  const now = options.now ?? new Date();
  const previousState = readState(path);
  const previous = previousState?.stranded ?? null;

  if (stranded === 0) {
    if (previous !== null && previous !== 0)
      writeState(path, { stranded: 0, notified_at: now.toISOString() });
    return { notified: false, reason: "cleared", stranded, previous };
  }

  if (previous !== null && stranded <= previous)
    return { notified: false, reason: "unchanged", stranded, previous };

  const id = noticeId(path, previousState, stranded);
  try {
    const result = await (options.send ?? sendNotice)({
      id,
      title: "Stack Brain ingestion stranded",
      message: stranded === 1 ? "1 submitted link never became searchable." : `${stranded} submitted links never became searchable.`,
      source: DOCTOR_SOURCE,
      group: STRANDED_GROUP,
    });
    if (!result || typeof result !== "object" || (result as { id?: unknown }).id !== id) throw new Error("notify did not confirm the notification ID");
  } catch {
    return { notified: false, reason: "notify_unavailable", stranded, previous };
  }

  writeState(path, { stranded, notified_at: now.toISOString() });
  return { notified: true, reason: "increased", stranded, previous };
}
