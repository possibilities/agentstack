import { shortId } from "./derive";
import type { ProcActor, ProcAuthority, ProcExecutionState, ProcOutputLine, ProcRun, ProcScheduleListItem, ProcStatus } from "./types";

/** The one protected system schedule: Brain's due-Source wake-up. */
export const brainScheduleId = "00000000-0000-4000-8000-000000000001";

const basename = (path: string): string => path.replace(/\/+$/, "").split("/").pop() || path;

/** A schedule's human name: its label, the system task's name, or its target. */
export function scheduleTitle(schedule: Pick<ProcScheduleListItem, "id" | "label" | "action">): string {
  if (schedule.label) return schedule.label;
  if (schedule.id === brainScheduleId) return "Brain source sync";
  const action = schedule.action;
  const title = action.type === "api" ? `${action.package}.${action.operation}`
    : `${basename(action.process.command)}${action.process.args.length ? ` ${action.process.args[0]}` : ""}`;
  return title.length > 60 ? `${title.slice(0, 59)}…` : title;
}

/** A run's human name: its label, its executable's basename, or a short ID. */
export function runTitle(run: Pick<ProcRun, "id" | "label" | "command">): string {
  if (run.label) return run.label;
  if (run.command) return basename(run.command);
  return `Process run ${shortId(run.id)}`;
}

export type ProcOwner = { kind: "operator" } | { kind: "system" } | { kind: "bot"; botId: string; threadId: string } | { kind: "unattributed" };

/** Who owns a record: operator, system, a Bot's durable root, or nothing (pre-attribution). */
export function ownerOf(actor: ProcAuthority | ProcActor | null): ProcOwner {
  if (!actor || actor.kind === "legacy_unknown") return { kind: "unattributed" };
  if (actor.kind === "bot") return { kind: "bot", botId: actor.botId, threadId: actor.mainThreadId };
  return actor.kind === "system" ? { kind: "system" } : { kind: "operator" };
}

export function ownerLabel(owner: ProcOwner): string {
  return owner.kind === "operator" ? "Operator" : owner.kind === "system" ? "System" : owner.kind === "bot" ? owner.botId : "Unattributed";
}

/** A schedule's interval in words; null is a one-shot. */
export function cadence(everyMs: number | null): string {
  if (everyMs === null) return "once";
  const seconds = everyMs / 1_000;
  if (seconds < 60) return `every ${seconds} s`;
  const minutes = everyMs / 60_000;
  if (minutes < 60) return `every ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = Math.round(minutes % 60);
    return `every ${hours} h${rest ? ` ${rest} min` : ""}`;
  }
  const days = Math.floor(hours / 24);
  const rest = hours % 24;
  return `every ${days} d${rest ? ` ${rest} h` : ""}`;
}

export type ProcScheduleGroup = "attention" | "held" | "upcoming" | "off" | "removed";

export const procScheduleGroups: Array<{ id: ProcScheduleGroup; title: string }> = [
  { id: "attention", title: "Needs you" },
  { id: "held", title: "Held" },
  { id: "upcoming", title: "Upcoming" },
  { id: "off", title: "Off" },
  { id: "removed", title: "Removed" },
];

export function scheduleGroup(schedule: ProcScheduleListItem): ProcScheduleGroup {
  if (schedule.removedAt) return "removed";
  const owner = schedule.authority?.kind;
  if (schedule.authority === null || (schedule.blockedReason && schedule.retryAt === null)
    || (schedule.enabled && (owner === "operator" || owner === "system") && (schedule.recent[0]?.state === "failed" || schedule.recent[0]?.state === "unknown")))
    return "attention";
  if (schedule.blockedReason && schedule.retryAt !== null) return "held";
  if (schedule.enabled && schedule.nextAt) return "upcoming";
  return "off";
}

export type ProcScheduleFilter = { owner?: string; kind?: "api" | "process" };

export function filterSchedules<T extends ProcScheduleListItem>(list: T[], filter: ProcScheduleFilter): T[] {
  return list.filter((schedule) => {
    if (filter.kind && schedule.action.type !== filter.kind) return false;
    if (!filter.owner) return true;
    const owner = ownerOf(schedule.authority);
    const key = owner.kind === "bot" ? owner.botId : owner.kind;
    return key === filter.owner;
  });
}

export function groupSchedules<T extends ProcScheduleListItem>(list: T[]): Map<ProcScheduleGroup, T[]> {
  const groups = new Map<ProcScheduleGroup, T[]>(procScheduleGroups.map(({ id }) => [id, []]));
  for (const schedule of list) groups.get(scheduleGroup(schedule))!.push(schedule);
  for (const [group, members] of groups) {
    if (group === "upcoming") members.sort((a, b) => Date.parse(a.nextAt ?? "") - Date.parse(b.nextAt ?? ""));
    else if (group === "removed") members.sort((a, b) => Date.parse(b.removedAt!) - Date.parse(a.removedAt!));
    else members.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  }
  return groups;
}

export type ProcRunGroup = "running" | "attention" | "finished";

export const procRunGroups: Array<{ id: ProcRunGroup; title: string }> = [
  { id: "running", title: "Running" },
  { id: "attention", title: "Needs a look" },
  { id: "finished", title: "Finished" },
];

const activeRunStates = new Set<ProcRun["state"]>(["starting", "running"]);
export const isActiveRun = (run: Pick<ProcRun, "state">): boolean => activeRunStates.has(run.state);

/** A terminal run worth a look: failed, unknown, or a non-zero exit, in the last day. */
function runNeedsLook(run: ProcRun, now: number): boolean {
  if (isActiveRun(run)) return false;
  const bad = run.state === "failed" || run.state === "unknown" || (run.state === "exited" && run.exitCode !== 0);
  if (!bad) return false;
  const finished = run.finishedAt ? Date.parse(run.finishedAt) : null;
  return finished !== null && now - finished <= 86_400_000;
}

export function groupRuns<T extends ProcRun>(list: T[], now: number): Map<ProcRunGroup, T[]> {
  const groups = new Map<ProcRunGroup, T[]>(procRunGroups.map(({ id }) => [id, []]));
  for (const run of list) {
    groups.get(isActiveRun(run) ? "running" : runNeedsLook(run, now) ? "attention" : "finished")!.push(run);
  }
  for (const members of groups.values()) members.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
  return groups;
}

export type ProcRunFilter = { owner?: string };

export function filterRuns<T extends ProcRun>(list: T[], filter: ProcRunFilter): T[] {
  return list.filter((run) => {
    if (!filter.owner) return true;
    const owner = ownerOf(run.createdBy);
    const key = owner.kind === "bot" ? owner.botId : owner.kind;
    return key === filter.owner;
  });
}

/** Plain words for a schedule's blocked reason; unknown codes pass through. */
export function blockedCopy(reason: string): string {
  const copy: Record<string, string> = {
    bot_service_unavailable: "Bots service unreachable",
    bot_removed: "Its Bot was removed",
    bot_root_changed: "Its Bot's main thread changed",
    bot_not_running: "Waiting for its Bot to run",
    bot_instance_changed: "Its Bot restarted during authorization",
    bot_thread_unavailable: "Its Bot thread is unavailable",
    target_mcp_unavailable: "Target package isn't reachable over MCP",
    target_not_mcp_exposed: "Target operation is no longer offered to Bots",
    target_unavailable: "Target package isn't running",
    target_operation_unavailable: "Target operation no longer exists",
    recursive_schedule_refused: "Proc can't schedule itself",
    authorization_unavailable: "Authorization check failed",
    legacy_reauthorization_required: "Created before attribution; needs your reauthorization",
  };
  return copy[reason] ?? reason;
}

/** Plain words for an execution's or run's error code; unknown codes pass through. */
export function errorCopy(code: string): string {
  const copy: Record<string, string> = {
    call_outcome_unknown: "Sent, but no reply arrived. It may have taken effect; Proc won't retry.",
    dispatch_interrupted: "Interrupted by a Proc restart; the outcome is unknown.",
    service_interrupted: "Interrupted by a Proc restart; the outcome is unknown.",
    service_closing_before_dispatch: "Proc was shutting down, so it was never sent.",
    proc_capacity: "All process slots were busy.",
    process_admission_failed: "The process couldn't be admitted.",
    process_timeout: "Stopped after its timeout.",
    spawn_failed: "The command couldn't start.",
    guardian_failed: "Proc lost its process guardian; the outcome is unknown.",
    guardian_unavailable: "Proc lost its process guardian; the outcome is unknown.",
    guardian_lost: "Proc lost its process guardian; the outcome is unknown.",
    group_cleanup_failed: "Some child processes couldn't be cleaned up.",
  };
  return copy[code] ?? code;
}

export type ProcTone = "success" | "warning" | "destructive" | "muted" | "info";

export const executionView: Record<ProcExecutionState, { word: string; tone: ProcTone }> = {
  running: { word: "Running", tone: "info" },
  completed: { word: "Completed", tone: "success" },
  failed: { word: "Failed", tone: "destructive" },
  refused: { word: "Not sent", tone: "muted" },
  unknown: { word: "Unknown", tone: "warning" },
};

/** A run's word and tone: a word first, the tone reinforces it. */
export function runView(run: Pick<ProcRun, "state" | "exitCode" | "error">): { word: string; tone: ProcTone } {
  switch (run.state) {
    case "starting": return { word: "Starting", tone: "info" };
    case "running": return { word: "Running", tone: "info" };
    case "exited": return run.exitCode === 0 ? { word: "Exited 0", tone: "success" } : { word: `Exited ${run.exitCode ?? "?"}`, tone: "destructive" };
    case "failed": return run.error === "process_timeout" ? { word: "Timed out", tone: "destructive" } : { word: "Failed", tone: "destructive" };
    case "cancelled": return { word: "Stopped", tone: "muted" };
    case "unknown": return { word: "Unknown", tone: "warning" };
  }
}

/**
 * What the Proc space flags: only what a human owns. A schedule needing
 * reauthorization, a blocked operator or system schedule, an operator or system
 * schedule whose last run failed, full capacity, or a dropped channel. Bot-owned
 * failures stay visible in the lists but never flag the space.
 */
export function procAttention(state: {
  status: Record<string, string | undefined>;
  procSchedules?: { data: ProcScheduleListItem[] | null } | undefined;
  procStatus?: { data: ProcStatus | null } | undefined;
}): string[] {
  const attention: string[] = [];
  if (state.status.proc === "closed") attention.push("proc reconnecting");
  for (const schedule of state.procSchedules?.data ?? []) {
    if (schedule.removedAt) continue;
    const title = scheduleTitle(schedule);
    const owner = schedule.authority?.kind;
    if (schedule.authority === null && !schedule.system) attention.push(`${title} needs reauthorization`);
    else if (schedule.blockedReason && schedule.retryAt === null && schedule.authority !== null) attention.push(`${title}: ${blockedCopy(schedule.blockedReason)}`);
    if (schedule.enabled && (owner === "operator" || owner === "system")
      && (schedule.recent[0]?.state === "failed" || schedule.recent[0]?.state === "unknown"))
      attention.push(`${title} last run ${schedule.recent[0]!.state}`);
  }
  const status = state.procStatus?.data;
  if (status && status.running >= status.capacity) attention.push(`All ${status.capacity} process slots busy`);
  return [...new Set(attention)];
}

export type ProcDisplayLine = { seq: number; stream: "stdout" | "stderr"; text: string; partial: boolean };

/**
 * Consecutive same-stream chunks merge while the earlier one is partial, so a
 * long written line shows as one row keyed by its first seq. A trailing partial
 * stays partial; it is replaced when its continuation arrives.
 */
export function joinPartials(lines: readonly ProcOutputLine[]): ProcDisplayLine[] {
  const joined: ProcDisplayLine[] = [];
  for (const line of lines) {
    const last = joined.at(-1);
    if (last && last.partial && last.stream === line.stream) {
      last.text += line.text;
      last.partial = line.partial;
    } else joined.push({ seq: line.seq, stream: line.stream, text: line.text, partial: line.partial });
  }
  return joined;
}

/** Strip ANSI CSI and OSC escapes and other C0 control characters except tab. */
export function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[@-Z\\-_]/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
}

/** A missing line range; `afterSeq` places it in the stream, `to` null means an unbounded gap. */
export type OutputGap = { afterSeq: number; from: number; to: number | null };

/**
 * Missing line ranges the server flagged (`gap`) plus any seq jumps inside the
 * page. A flagged page with no lines means everything after `after` was dropped,
 * so its range is unbounded.
 */
export function lineGaps(after: number, lines: readonly ProcOutputLine[], flagged: boolean): OutputGap[] {
  const gaps: OutputGap[] = [];
  const first = lines[0];
  if (flagged) {
    if (!first) gaps.push({ afterSeq: after, from: after + 1, to: null });
    else if (first.seq > after + 1) gaps.push({ afterSeq: after, from: after + 1, to: first.seq - 1 });
  }
  for (let index = 1; index < lines.length; index++) {
    if (lines[index]!.seq > lines[index - 1]!.seq + 1) gaps.push({ afterSeq: lines[index - 1]!.seq, from: lines[index - 1]!.seq + 1, to: lines[index]!.seq - 1 });
  }
  return gaps;
}

/** Byte counts in words for the output-limit banner. */
export function formatLimitBytes(bytes: number): string {
  return bytes >= 1_000_000 ? `${bytes / 1_000_000} MB` : bytes >= 1_000 ? `${bytes / 1_000} KB` : `${bytes} B`;
}
