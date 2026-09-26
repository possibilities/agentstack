import { setTimeout as sleep } from "node:timers/promises";
import { brainSignal } from "./paths.js";
import { optBoolean, optNumber, optString, parseOptions } from "./args.js";
import { ResearchCache } from "./db.js";
import { CliError } from "./errors.js";
import { formatList, writeByFormat, setCommandExitCode } from "./format.js";
import type { SourceSyncAdmission, SourceSyncWaitResult } from "./source-types.js";
import {
  DEFAULT_SOURCE_MANIFEST_PATH,
  latestSourceRunStatus,
  listSources,
  readSourceManifest,
  SourceRegistry,
  showSource,
  sourceRunStatus,
  sourceStatuses,
} from "./sources.js";
import { ResearchStore } from "./store.js";
import type { GlobalOptions } from "./types.js";

const ACTIVE_JOB_STATES = new Set(["queued", "running", "retry_wait"]);

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new CliError("bad_integer", `--${name} must be positive`, {
      exitCode: 2,
    });
  }
  return value;
}

export async function runSourceCommands(
  dbPath: string,
  argv: string[],
  globals: GlobalOptions,
): Promise<void> {
  const subcommand = argv[0]?.startsWith("--") ? "list" : (argv[0] ?? "list");
  const args =
    argv[0]?.startsWith("--") || argv.length === 0 ? argv : argv.slice(1);
  if (subcommand === "list") {
    const opts = parseOptions(args, {
      limit: { type: "number", default: 500 },
    });
    if (opts._.length !== 0) {
      throw new CliError(
        "unexpected_args",
        "sources list accepts no positional arguments",
        { exitCode: 2 },
      );
    }
    const limit = positiveInteger(optNumber(opts, "limit") ?? 500, "limit");
    if (limit > 1_000) {
      throw new CliError("bad_integer", "--limit must not exceed 1000", {
        exitCode: 2,
      });
    }
    const cache = new ResearchCache(dbPath);
    try {
      const data = listSources(cache.db).slice(0, limit);
      writeByFormat("sources list", data, globals, (value) =>
        formatList(
          value.map((source) => ({
            id: source.id,
            kind: source.kind,
            enabled: source.enabled,
            paused: source.paused,
            health: source.executable ? "supported" : "unsupported",
          })),
          ["id", "kind", "enabled", "paused", "health"],
        ),
      );
    } finally {
      cache.close();
    }
    return;
  }
  if (subcommand === "show") {
    const opts = parseOptions(args, {});
    const [sourceId] = opts._;
    if (opts._.length !== 1 || sourceId === undefined) {
      throw new CliError(
        "bad_source_id",
        "sources show requires exactly one stable source ID",
        { exitCode: 2 },
      );
    }
    const cache = new ResearchCache(dbPath);
    try {
      const data = showSource(cache.db, sourceId);
      writeByFormat(
        "sources show",
        data,
        globals,
        (value) => `${JSON.stringify(value, null, 2)}\n`,
      );
    } finally {
      cache.close();
    }
    return;
  }
  if (subcommand === "status") {
    const opts = parseOptions(args, {});
    if (opts._.length > 1) {
      throw new CliError(
        "bad_source_id",
        "sources status accepts at most one stable source ID",
        { exitCode: 2 },
      );
    }
    const cache = new ResearchCache(dbPath);
    try {
      const data = sourceStatuses(cache.db, { sourceId: opts._[0] });
      writeByFormat(
        "sources status",
        data,
        globals,
        (value) => `${JSON.stringify(value, null, 2)}\n`,
      );
    } finally {
      cache.close();
    }
    return;
  }
  if (subcommand === "sync") {
    const opts = parseOptions(args, {
      due: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      limit: { type: "number", default: 1000 },
      wait: { type: "boolean", default: false },
      "wait-timeout-seconds": { type: "number", default: 300 },
      "wait-timeout-ok": { type: "boolean", default: false },
      "wait-poll-ms": { type: "number", default: 250 },
    });
    const due = optBoolean(opts, "due");
    const [namedSource] = opts._;
    if (
      opts._.length > 1 ||
      (!due && (opts._.length !== 1 || namedSource === undefined))
    ) {
      throw new CliError(
        "bad_source_sync",
        "sources sync requires one stable source ID, optionally with --due, or --due by itself",
        { exitCode: 2 },
      );
    }
    const dryRun = optBoolean(opts, "dry-run");
    const wait = optBoolean(opts, "wait");
    const waitTimeoutOk = optBoolean(opts, "wait-timeout-ok");
    if (waitTimeoutOk && !wait) {
      throw new CliError(
        "bad_source_sync",
        "sources sync --wait-timeout-ok requires --wait",
        { exitCode: 2 },
      );
    }
    if (dryRun && wait) {
      throw new CliError(
        "bad_source_sync",
        "sources sync --wait cannot be combined with --dry-run",
        { exitCode: 2 },
      );
    }
    const waitTimeoutSeconds = optNumber(opts, "wait-timeout-seconds") ?? 300;
    const waitPollMs = optNumber(opts, "wait-poll-ms") ?? 250;
    if (
      !Number.isFinite(waitTimeoutSeconds) ||
      waitTimeoutSeconds <= 0 ||
      waitTimeoutSeconds > 3_600
    ) {
      throw new CliError(
        "bad_source_sync",
        "--wait-timeout-seconds must be greater than zero and at most 3600",
        { exitCode: 2 },
      );
    }
    if (
      !Number.isInteger(waitPollMs) ||
      waitPollMs < 25 ||
      waitPollMs > 5_000
    ) {
      throw new CliError(
        "bad_source_sync",
        "--wait-poll-ms must be an integer from 25 through 5000",
        { exitCode: 2 },
      );
    }
    const store = new ResearchStore(dbPath);
    let admissions: SourceSyncAdmission[];
    try {
      const registry = new SourceRegistry(store);
      admissions =
        namedSource === undefined
          ? registry.syncDueSources({
              dryRun,
              limit: positiveInteger(
                optNumber(opts, "limit") ?? 1_000,
                "limit",
              ),
            })
          : [
              registry.syncSource({
                sourceId: namedSource,
                dueOnly: due,
                dryRun,
              }),
            ];
    } finally {
      store.close();
    }
    if (!wait) {
      writeByFormat(
        "sources sync",
        admissions,
        globals,
        (value) => `${JSON.stringify(value, null, 2)}\n`,
        { readOnly: dryRun },
      );
      return;
    }

    const deadline = Date.now() + waitTimeoutSeconds * 1_000;
    const cache = new ResearchCache(dbPath);
    let results: SourceSyncWaitResult[] = [];
    try {
      for (;;) {
        results = admissions.map((admission) => ({
          admission,
          execution:
            admission.run_id !== null
              ? sourceRunStatus(cache.db, admission.run_id)
              : admission.status === "not_due"
                ? latestSourceRunStatus(cache.db, admission.source_id)
                : null,
          timed_out: false,
        }));
        if (
          results.every(
            (result) =>
              result.execution === null ||
              (result.execution.job === null
                ? result.execution.terminal
                : !ACTIVE_JOB_STATES.has(result.execution.job.state)),
          )
        ) {
          break;
        }
        if (Date.now() >= deadline || brainSignal()?.aborted) {
          results = results.map((result) => ({
            ...result,
            timed_out:
              result.execution !== null &&
              (result.execution.job === null
                ? !result.execution.terminal
                : ACTIVE_JOB_STATES.has(result.execution.job.state)),
          }));
          break;
        }
        await sleep(
          Math.min(waitPollMs, Math.max(1, deadline - Date.now())),
          undefined, { signal: brainSignal() },
        ).catch((error) => { if (!brainSignal()?.aborted) throw error; });
      }
    } finally {
      cache.close();
    }
    writeByFormat(
      "sources sync",
      results,
      globals,
      (value) => `${JSON.stringify(value, null, 2)}\n`,
      { readOnly: false },
    );
    if (results.some((result) => result.timed_out) && !waitTimeoutOk) {
      setCommandExitCode(124);
    } else if (
      results.some(
        (result) =>
          !result.timed_out &&
          ((result.execution === null &&
            result.admission.status !== "not_due") ||
            (result.execution !== null &&
              result.execution.outcome !== "success")),
      )
    ) {
      setCommandExitCode(1);
    }
    return;
  }
  if (subcommand === "pause" || subcommand === "resume") {
    const opts = parseOptions(args, {
      actor: { type: "string", default: "operator" },
      reason: { type: "string" },
    });
    const [sourceId] = opts._;
    if (opts._.length !== 1 || sourceId === undefined) {
      throw new CliError(
        "bad_source_id",
        `sources ${subcommand} requires exactly one stable source ID`,
        { exitCode: 2 },
      );
    }
    const store = new ResearchStore(dbPath);
    try {
      const input = {
        sourceId,
        actor: optString(opts, "actor"),
        reason: optString(opts, "reason"),
      };
      const registry = new SourceRegistry(store);
      const source =
        subcommand === "pause"
          ? registry.pauseSource(input)
          : registry.resumeSource(input);
      const data = {
        id: source.identifier,
        paused: Boolean(source.paused),
        enabled: Boolean(source.enabled),
        audit_action: subcommand === "pause" ? "paused" : "resumed",
      };
      writeByFormat(
        `sources ${subcommand}`,
        data,
        globals,
        (value) => `${JSON.stringify(value, null, 2)}\n`,
        { readOnly: false },
      );
    } finally {
      store.close();
    }
    return;
  }
  if (subcommand === "apply") {
    const opts = parseOptions(args, {
      manifest: { type: "string" },
      overlay: { type: "string" },
      actor: { type: "string", default: "operator" },
      reason: { type: "string" },
    });
    if (opts._.length !== 0) {
      throw new CliError(
        "unexpected_args",
        "sources apply accepts no positional arguments",
        { exitCode: 2 },
      );
    }
    const manifestPath =
      optString(opts, "manifest") ?? DEFAULT_SOURCE_MANIFEST_PATH;
    const overlayPath = optString(opts, "overlay");
    const manifest = readSourceManifest(manifestPath, overlayPath);
    const store = new ResearchStore(dbPath);
    try {
      const registry = new SourceRegistry(store);
      const data = registry.applySourceManifest(manifest, {
        actor: optString(opts, "actor"),
        reason: optString(opts, "reason"),
      });
      writeByFormat(
        "sources apply",
        data,
        globals,
        (value) => `${JSON.stringify(value, null, 2)}\n`,
        { readOnly: false },
      );
    } finally {
      store.close();
    }
    return;
  }
  throw new CliError(
    "bad_sources_command",
    "sources requires one of: list, show, status, sync, pause, resume, apply",
    { exitCode: 2 },
  );
}
