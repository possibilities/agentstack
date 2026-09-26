import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { brainEnvironment, brainStateRoot } from "./paths.js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { findExecutable } from "./executable.js";

/**
 * Operator notification.
 *
 * AgentStack Brain acknowledges a submission at Admission, long before extraction and
 * indexing decide whether it succeeded. When a job reaches a stranded terminal
 * state there is no request left to fail and no reader watching the ledger, so
 * the ingress that accepted the link owes the operator an out-of-band signal.
 *
 * Delivery is best-effort by design: the ingestion outcome is the product and a
 * notification only carries it. A missing notifier is never an error.
 */

export interface NotifySignal {
  title: string;
  message: string;
  group?: string;
  /** Command to run in a terminal when the notification is clicked. */
  terminal?: string;
}

const DOCTOR_NOTIFY_GROUP = "io.arthack.agentstack.brain.doctor";

export function defaultNotifyStatePath(home?: string): string {
  return join(brainStateRoot(brainEnvironment(), home), "doctor-notify.json");
}

/**
 * Post a notification through terminal-notifier.
 *
 * -ignoreDnD gets the signal through do-not-disturb, and -execute carries the
 * click-through command so the notification is actionable rather than only
 * informative. Returns the notifier used, or null when it is not installed.
 */
export function notifyOperator(signal: NotifySignal): string | null {
  const notifier = findExecutable("terminal-notifier");
  if (notifier === null) return null;
  const args = [
    "-title",
    signal.title,
    "-message",
    signal.message,
    "-ignoreDnD",
  ];
  if (signal.group !== undefined) args.push("-group", signal.group);
  if (signal.terminal !== undefined) args.push("-execute", signal.terminal);
  runQuietly(notifier, args);
  return notifier;
}

function runQuietly(command: string, args: string[]): void {
  try {
    spawnSync(command, args, { stdio: "ignore", timeout: 10_000 });
  } catch {
    // The caller's outcome is the product; a notification only carries it.
  }
}

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
  reason: "unchanged" | "increased" | "cleared" | "no_notifier";
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
export function notifyStranded(
  stranded: number,
  options: { statePath?: string; now?: Date } = {},
): StrandedNotifyResult {
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

  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const command = `${quote(process.execPath)} ${quote(fileURLToPath(new URL("./cli.js", import.meta.url)))} --db ${quote(join(brainStateRoot(), "research.db"))}`;
  const delivered = notifyOperator({
    title: "AgentStack Brain ingestion stranded",
    message:
      stranded === 1
        ? "1 submitted link never became searchable."
        : `${stranded} submitted links never became searchable.`,
    group: DOCTOR_NOTIFY_GROUP,
    terminal:
      `${command} jobs list --state blocked; ${command} jobs list --state failed`,
  });
  if (delivered === null)
    return { notified: false, reason: "no_notifier", stranded, previous };

  writeState(path, { stranded, notified_at: now.toISOString() });
  return { notified: true, reason: "increased", stranded, previous };
}
