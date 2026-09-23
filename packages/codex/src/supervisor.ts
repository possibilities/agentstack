import { type ChildProcess, execFile, spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const DEFAULT_GRACE_MS = 10_000;
const DEFAULT_READY_TIMEOUT_MS = 10_000;
const PORT_ATTEMPTS = 3;

export type ServerState = "running" | "stopped";

export type ServerView = {
  id: string;
  pid: number | null;
  cwd: string;
  url: string | null;
  state: ServerState;
};

type RecordFile = ServerView & {
  codexBin: string;
};

export type StartInput = {
  cwd: string;
  id?: string;
  codexBin?: string;
  args?: string[];
};

export type LaunchSpec = {
  bin: string;
  args: string[];
  cwd: string;
  logPath: string;
};

export type RunningChild = {
  pid: number;
  exited: Promise<number | null>;
  exitCode?: number | null;
  kill(signal: NodeJS.Signals): void;
};

export type SupervisorOptions = {
  stateDir: string;
  launch?: (spec: LaunchSpec) => RunningChild;
  waitReady?: (url: string, exited: Promise<number | null>, timeoutMs: number) => Promise<void>;
  reservePort?: () => Promise<number>;
  commandLine?: (pid: number) => Promise<string | null>;
  graceMs?: number;
  readyTimeoutMs?: number;
};

export class Supervisor {
  private readonly records = new Map<string, RecordFile>();
  private readonly queues = new Map<string, Promise<void>>();
  private readonly children = new Map<string, RunningChild>();
  private readonly launch: (spec: LaunchSpec) => RunningChild;
  private readonly waitReady: (url: string, exited: Promise<number | null>, timeoutMs: number) => Promise<void>;
  private readonly reservePort: () => Promise<number>;
  private readonly commandLine: (pid: number) => Promise<string | null>;
  private readonly graceMs: number;
  private readonly readyTimeoutMs: number;

  constructor(private readonly options: SupervisorOptions) {
    this.launch = options.launch ?? launchChild;
    this.waitReady = options.waitReady ?? waitForReady;
    this.reservePort = options.reservePort ?? reserveLoopbackPort;
    this.commandLine = options.commandLine ?? processCommandLine;
    this.graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
    this.readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
  }

  async load(): Promise<void> {
    await mkdir(this.recordsDir(), { recursive: true, mode: 0o700 });
    await mkdir(this.options.stateDir, { recursive: true, mode: 0o700 });
    const names = await readdir(this.recordsDir()).catch(() => []);
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      try {
        const parsed = JSON.parse(await readFile(join(this.recordsDir(), name), "utf8")) as RecordFile;
        if (!parsed?.id || !ID_PATTERN.test(parsed.id)) continue;
        this.records.set(parsed.id, parsed);
      } catch {
        continue;
      }
    }
  }

  async reap(): Promise<void> {
    for (const record of this.records.values()) {
      if (record.state !== "running" || record.pid === null || record.url === null) continue;
      if (await this.ownsProcess(record.pid, record.url)) await this.signalPid(record.pid, record.url);
      this.markStopped(record);
      await this.persist(record);
    }
  }

  list(): ServerView[] {
    return [...this.records.values()].map(viewOf);
  }

  start(input: StartInput): Promise<ServerView> {
    const id = input.id ?? newId();
    return this.enqueue(id, () => this.startQueued(id, input));
  }

  stop(id: string): Promise<ServerView> {
    if (!ID_PATTERN.test(id)) throw new Error(`invalid id: ${id}`);
    return this.enqueue(id, () => this.stopQueued(id));
  }

  async stopAll(): Promise<void> {
    const running = [...this.records.values()].filter((record) => record.state === "running");
    await Promise.all(running.map((record) => this.stop(record.id)));
  }

  async halt(): Promise<void> {
    const running = [...this.records.values()].filter((record) => record.state === "running");
    await Promise.all(
      running.map(async (record) => {
        const child = this.children.get(record.id);
        if (child) {
          try {
            child.kill("SIGKILL");
          } catch {
            // The child already exited.
          }
          this.children.delete(record.id);
        } else if (record.pid !== null && record.url !== null && (await this.ownsProcess(record.pid, record.url))) {
          try {
            process.kill(record.pid, "SIGKILL");
          } catch {
            // The pid already exited.
          }
        }
        this.markStopped(record);
        await this.persist(record);
      }),
    );
  }

  private async startQueued(id: string, input: StartInput): Promise<ServerView> {
    if (!ID_PATTERN.test(id)) throw new Error(`invalid id: ${id}`);
    const cwd = await existingDirectory(input.cwd);
    const codexBin = input.codexBin && input.codexBin.length > 0 ? input.codexBin : "codex";
    const userArgs = input.args ?? [];
    const current = this.records.get(id);
    if (current && (await this.isRunning(current))) return viewOf(current);

    let lastError: Error | undefined;
    for (let attempt = 0; attempt < PORT_ATTEMPTS; attempt += 1) {
      const port = await this.reservePort();
      const url = `ws://127.0.0.1:${port}`;
      const logPath = join(this.options.stateDir, "logs", `${id}.log`);
      await mkdir(join(this.options.stateDir, "logs"), { recursive: true, mode: 0o700 });
      let child: RunningChild;
      try {
        child = this.launch({
          bin: codexBin,
          args: appServerArgs(userArgs, url),
          cwd,
          logPath,
        });
      } catch (error) {
        throw new Error(error instanceof Error ? error.message : String(error));
      }
      this.children.set(id, child);
      const record: RecordFile = { id, pid: child.pid, cwd, url, state: "running", codexBin };
      this.records.set(id, record);
      this.watchExit(id, child, record);
      await this.persist(record);
      try {
        await this.waitReady(url, child.exited, this.readyTimeoutMs);
        return viewOf(record);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        await this.killChild(id, child);
        this.markStopped(record);
        await this.persist(record);
      }
    }
    throw lastError ?? new Error("failed to start app-server");
  }

  private async stopQueued(id: string): Promise<ServerView> {
    const record = this.records.get(id);
    if (!record) throw new Error(`unknown server: ${id}`);
    if (record.state === "stopped") return viewOf(record);
    const child = this.children.get(id);
    if (child) {
      await this.killChild(id, child);
    } else if (record.pid !== null && record.url !== null) {
      await this.signalPid(record.pid, record.url);
    }
    this.markStopped(record);
    await this.persist(record);
    return viewOf(record);
  }

  private async isRunning(record: RecordFile): Promise<boolean> {
    if (record.state !== "running" || record.pid === null || record.url === null) return false;
    const child = this.children.get(record.id);
    if (child) return child.exitCode === undefined;
    return this.ownsProcess(record.pid, record.url);
  }

  private watchExit(id: string, child: RunningChild, record: RecordFile): void {
    void child.exited.then(() => {
      void this.enqueue(id, async () => {
        if (this.children.get(id) !== child || this.records.get(id) !== record) return;
        this.children.delete(id);
        this.markStopped(record);
        await this.persist(record);
      });
    });
  }

  private async ownsProcess(pid: number, url: string): Promise<boolean> {
    const command = await this.commandLine(pid);
    return Boolean(command && isOurChild(command, url));
  }

  private async signalPid(pid: number, url: string): Promise<void> {
    if (!(await this.ownsProcess(pid, url))) return;
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      return;
    }
    const deadline = Date.now() + this.graceMs;
    while (Date.now() < deadline) {
      if (!(await this.ownsProcess(pid, url))) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    if (!(await this.ownsProcess(pid, url))) return;
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // The process exited during the grace window.
    }
  }

  private markStopped(record: RecordFile): void {
    record.state = "stopped";
    record.pid = null;
    record.url = null;
  }

  private async killChild(id: string, child: RunningChild): Promise<void> {
    const finished = child.exited.then(() => undefined, () => undefined);
    try {
      child.kill("SIGTERM");
    } catch {
      // The child already exited.
    }
    const timedOut = new Promise<"timeout">((resolve) => {
      setTimeout(() => resolve("timeout"), this.graceMs);
    });
    const outcome = await Promise.race([finished.then(() => "exited" as const), timedOut]);
    if (outcome === "timeout") {
      try {
        child.kill("SIGKILL");
      } catch {
        // The child exited during the grace window.
      }
      await finished;
    }
    this.children.delete(id);
  }

  private enqueue<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(id) ?? Promise.resolve();
    const run = previous.then(operation, operation);
    this.queues.set(id, run.then(() => undefined, () => undefined));
    return run;
  }

  private recordsDir(): string {
    return join(this.options.stateDir, "servers");
  }

  private async persist(record: RecordFile): Promise<void> {
    const path = join(this.recordsDir(), `${record.id}.json`);
    const temporary = `${path}.tmp`;
    await writeFile(temporary, JSON.stringify(record), { mode: 0o600 });
    await rename(temporary, path);
  }
}

export function appServerArgs(userArgs: readonly string[], url: string): string[] {
  for (const arg of userArgs) {
    if (arg === "--listen" || arg.startsWith("--listen=")) {
      throw new Error("do not pass --listen; agentstack sets the websocket listener");
    }
  }
  const args = [...userArgs];
  let appServerAt = args.indexOf("app-server");
  if (appServerAt === -1) {
    args.unshift("app-server");
    appServerAt = 0;
  }
  args.splice(appServerAt + 1, 0, "--listen", url);
  return args;
}

function viewOf(record: RecordFile): ServerView {
  return {
    id: record.id,
    pid: record.pid,
    cwd: record.cwd,
    url: record.url,
    state: record.state,
  };
}

function newId(): string {
  return `s${randomBytes(8).toString("hex")}`;
}

async function existingDirectory(cwd: string): Promise<string> {
  const { stat } = await import("node:fs/promises");
  const { resolve } = await import("node:path");
  const absolute = resolve(cwd);
  let info;
  try {
    info = await stat(absolute);
  } catch {
    throw new Error(`cwd does not exist: ${absolute}`);
  }
  if (!info.isDirectory()) throw new Error(`cwd is not a directory: ${absolute}`);
  return absolute;
}

function isOurChild(command: string, url: string): boolean {
  return command.includes("app-server") && command.includes("--listen") && command.includes(url);
}

export function launchChild(spec: LaunchSpec): RunningChild {
  const log = createWriteStream(spec.logPath, { flags: "a" });
  const child: ChildProcess = spawn(spec.bin, spec.args, {
    cwd: spec.cwd,
    detached: false,
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
  child.stdout?.pipe(log);
  child.stderr?.pipe(log);
  let resolveExit: (code: number | null) => void = () => undefined;
  const exited = new Promise<number | null>((resolve) => {
    resolveExit = resolve;
  });
  if (child.pid === undefined) {
    throw new Error(`failed to spawn ${spec.bin}`);
  }
  const running: RunningChild = {
    pid: child.pid,
    exited,
    kill(signal) {
      child.kill(signal);
    },
  };
  child.once("error", () => {
    if (running.exitCode === undefined) running.exitCode = null;
    resolveExit(null);
  });
  child.once("exit", (code) => {
    log.end();
    running.exitCode = code;
    resolveExit(code);
  });
  return running;
}

export async function reserveLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("failed to reserve a loopback port");
  }
  const { port } = address;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

export async function waitForReady(url: string, exited: Promise<number | null>, timeoutMs: number): Promise<void> {
  const port = new URL(url).port;
  const deadline = Date.now() + timeoutMs;
  let exitCode: number | null | undefined;
  void exited.then((code) => {
    exitCode = code;
  });
  while (Date.now() < deadline) {
    if (exitCode !== undefined) throw new Error(`app-server exited before ready (${exitCode ?? "spawn error"})`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/readyz`);
      if (response.ok) return;
    } catch {
      // The listener is not up yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`app-server was not ready at ${url}`);
}

export function processCommandLine(pid: number): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("ps", ["-p", String(pid), "-ww", "-o", "command="], (error, stdout) => {
      if (error) resolve(null);
      else resolve(stdout.trim() || null);
    });
  });
}
