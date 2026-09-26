import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { cpus, freemem, loadavg, totalmem } from "node:os";
import { basename } from "node:path";
import type { ResourceError, ResourceHost } from "./schema.js";

export const maxHostProcesses = 20_000;
export const maxOwnedProcesses = 2_048;
export class CollectionError extends Error {
  constructor(readonly code: ResourceError) { super(code); }
}
export type ProcessReading = {
  id: string; pid: number; ppid: number; birth: string; name: string;
  rssBytes: number; virtualBytes: number; cpuTimeMs: number; threads: number | null;
};
export type Collection = {
  processes: ProcessReading[]; host: ResourceHost; capturedAt: string; monotonicMs: number;
  unreadableProcesses: number; vanishedDuringCollection: number;
  excludedCollectorProcesses: number;
};
export type Collector = (signal: AbortSignal) => Promise<Collection>;

export function processIdentity(pid: number, birth: string): string {
  return `process:${pid}:${createHash("sha256").update(birth).digest("hex").slice(0, 24)}`;
}
function reading(input: Omit<ProcessReading, "id">): ProcessReading {
  if (![input.pid, input.ppid, input.rssBytes, input.virtualBytes, input.cpuTimeMs, input.threads ?? 0].every((v) => Number.isFinite(v) && v >= 0)) {
    throw new CollectionError("collection_failed");
  }
  return { ...input, id: processIdentity(input.pid, input.birth), name: basename(input.name).replace(/[\x00-\x1f\x7f]/g, "?").slice(0, 120) };
}

/** ps CPU time is cumulative self user + system time, never ps's lifetime %CPU. */
export function parseCpuTime(text: string): number {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(text);
  if (!match) throw new CollectionError("collection_failed");
  return ((Number(match[1] ?? 0) * 86400) + (Number(match[2] ?? 0) * 3600) + Number(match[3]) * 60 + Number(match[4])) * 1000;
}

/** LC_ALL=C, fixed lstart fields; the trailing comm may contain spaces. */
export function parseDarwinProcesses(text: string): ProcessReading[] {
  const lines = text.split("\n").filter((line) => line.trim());
  if (lines.length > maxHostProcesses) throw new CollectionError("process_limit");
  return lines.map((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\w+\s+\w+\s+\d+\s+\d+:\d+:\d+\s+\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!match) throw new CollectionError("collection_failed");
    return reading({ pid: Number(match[1]), ppid: Number(match[2]), birth: `darwin:${match[3].replace(/\s+/g, " ")}`,
      rssBytes: Number(match[4]) * 1024, virtualBytes: Number(match[5]) * 1024, cpuTimeMs: parseCpuTime(match[6]),
      threads: null, name: match[7] });
  });
}

/** /proc/PID/stat's comm may contain whitespace, parentheses and newlines. */
export function parseLinuxStat(text: string, bootId: string, ticks: number, pageSize: number): ProcessReading {
  const open = text.indexOf("(");
  const close = text.lastIndexOf(")");
  if (open < 1 || close <= open || ticks <= 0 || pageSize <= 0) throw new CollectionError("collection_failed");
  const fields = text.slice(close + 1).trim().split(/\s+/); // starts at field 3 (state)
  if (fields.length < 22 || !/^\d+$/.test(fields[19])) throw new CollectionError("collection_failed");
  return reading({ pid: Number(text.slice(0, open).trim()), ppid: Number(fields[1]), birth: `linux:${bootId}:${fields[19]}`,
    name: text.slice(open + 1, close), cpuTimeMs: (Number(fields[11]) + Number(fields[12])) * 1000 / ticks,
    threads: Number(fields[17]), virtualBytes: Number(fields[20]), rssBytes: Number(fields[21]) * pageSize });
}

function command(file: string, args: string[], signal: AbortSignal, maxBuffer: number): Promise<{ stdout: string; pid: number | undefined }> {
  return new Promise((resolve, reject) => {
    let closed = false;
    let result: { stdout: string; error: CollectionError | null } | undefined;
    const finish = () => {
      if (!closed || !result) return;
      if (result.error) reject(result.error);
      else resolve({ stdout: result.stdout, pid: child.pid });
    };
    const child = execFile(file, args, { signal, timeout: 3_000, killSignal: "SIGKILL", maxBuffer, encoding: "utf8", env: { ...process.env, LC_ALL: "C" } }, (error, stdout) => {
      const code = (error as NodeJS.ErrnoException | null)?.code;
      result = { stdout, error: !error ? null : new CollectionError(code === "EAGAIN" ? "process_capacity"
        : code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ? "collection_failed" : signal.aborted || error.killed ? "collection_timeout" : "collection_failed") };
      finish();
    });
    // Abort can invoke execFile's callback before close; never leave a collector child behind on shutdown.
    child.once("close", () => { closed = true; finish(); });
  });
}

export function createCollector(platform: NodeJS.Platform = process.platform): Collector {
  let linuxConstants: { ticks: number; pageSize: number; bootId: string } | undefined;
  return async (signal) => {
    signal.throwIfAborted();
    let processes: ProcessReading[];
    let unreadableProcesses = 0;
    let vanishedDuringCollection = 0;
    let excludedCollectorProcesses = 0;
    if (platform === "darwin") {
      const result = await command("/bin/ps", ["-axo", "pid=,ppid=,lstart=,rss=,vsz=,time=,comm="], signal, 8 * 1024 * 1024);
      const all = parseDarwinProcesses(result.stdout);
      processes = all.filter((item) => item.pid !== result.pid);
      excludedCollectorProcesses = all.length - processes.length;
    } else if (platform === "linux") {
      if (!linuxConstants) {
        const [constantRead, bootRead] = await Promise.allSettled([
          command("getconf", ["-a"], signal, 128 * 1024),
          readFile("/proc/sys/kernel/random/boot_id", { encoding: "utf8", signal }),
        ]);
        if (constantRead.status === "rejected") throw constantRead.reason;
        if (bootRead.status === "rejected") throw bootRead.reason;
        const constants = constantRead.value;
        const bootId = bootRead.value;
        const ticks = Number(/^CLK_TCK\s+(\d+)$/m.exec(constants.stdout)?.[1]);
        const pageSize = Number(/^PAGESIZE\s+(\d+)$/m.exec(constants.stdout)?.[1]);
        if (!Number.isSafeInteger(ticks) || ticks <= 0 || !Number.isSafeInteger(pageSize) || pageSize <= 0 || !/^[a-f0-9-]{36}$/.test(bootId.trim())) throw new CollectionError("collection_failed");
        linuxConstants = { ticks, pageSize, bootId: bootId.trim() };
      }
      const constants = linuxConstants;
      const pids = (await readdir("/proc")).filter((name) => /^\d+$/.test(name));
      if (pids.length > maxHostProcesses) throw new CollectionError("process_limit");
      processes = [];
      let cursor = 0;
      // Bounded I/O concurrency, with cancellation checked before every read. No per-PID subprocesses.
      const reads = await Promise.allSettled(Array.from({ length: Math.min(16, pids.length) }, async () => {
        while (cursor < pids.length) {
          signal.throwIfAborted();
          const pid = pids[cursor++];
          try {
            const stat = await readFile(`/proc/${pid}/stat`, { encoding: "utf8", signal });
            processes.push(parseLinuxStat(stat, constants.bootId, constants.ticks, constants.pageSize));
          } catch (error) {
            signal.throwIfAborted();
            const code = (error as NodeJS.ErrnoException).code;
            if (code === "ENOENT" || code === "ESRCH") vanishedDuringCollection++;
            else if (code === "EACCES" || code === "EPERM") unreadableProcesses++;
            else throw error;
          }
        }
      }));
      const failure = reads.find((result) => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    } else throw new CollectionError("unsupported_platform");
    signal.throwIfAborted();
    return { processes, capturedAt: new Date().toISOString(), monotonicMs: performance.now(), unreadableProcesses, vanishedDuringCollection, excludedCollectorProcesses,
      host: { platform, logicalCpuCount: cpus().length, totalMemoryBytes: totalmem(), freeMemoryBytes: freemem(), loadAverage: loadavg() } };
  };
}
