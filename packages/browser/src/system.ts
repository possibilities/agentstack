import { execFile as execFileCallback, spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { closeSync, existsSync, lstatSync, openSync } from "node:fs";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { stateDir } from "@agentstack/api";

const execFile = promisify(execFileCallback);
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const DEFAULT_CHECK_INTERVAL_MS = 6 * 60 * 60_000;
const MAX_COMMAND_OUTPUT = 1024 * 1024;
const HYPEMAN_VERSION = "0.3.0";
const HYPEMAN_ARCHIVES: Record<string, string> = {
  darwin_arm64: "85d3e51bab7c75df045ccbbab4b21da0c026fd1f87ecc97058fdec33c87c6d1d",
  linux_amd64: "0e704787082e2f5744f55e59b6858085c952f695b5e3cf3d5ea081b1d655c15b",
};

export type BrowserUpdatePolicy = "manual" | "automatic";
export type BrowserToolStatus = {
  installed: boolean; version: string | null; location: string | null;
  latest: string | null; pending: string | null; checkedAt: string | null;
  checkError: string | null; policy: BrowserUpdatePolicy;
};
type SystemRecord = { version: 1; hypemanRoot: string | null; candidateRoot: string | null; policy: BrowserUpdatePolicy; latest: string | null; checkedAt: string | null; checkError: string | null };
const initial: SystemRecord = { version: 1, hypemanRoot: null, candidateRoot: null, policy: "manual", latest: null, checkedAt: null, checkError: null };

function safeDirectory(path: string): boolean {
  if (!isAbsolute(path) || resolve(path) !== path || path === "/") return false;
  try {
    const details = lstatSync(path);
    return details.isDirectory() && !details.isSymbolicLink() && (typeof process.getuid !== "function" || details.uid === process.getuid());
  } catch { return false; }
}

export type HypemanInstallation = { root: string; installed: boolean; selected: boolean; source: "agentstack" | "legacy" | "custom"; running: boolean; issue: string | null };

export class BrowserSystem {
  readonly root: string;
  private readonly recordPath: string;
  private record: SystemRecord = { ...initial };
  private updateTask: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private operation = Promise.resolve();
  private hostChild: ChildProcess | null = null;
  private hostStart: Promise<void> | null = null;
  private managedHostStarted = false;
  onChange?: () => void;

  constructor(private readonly env: NodeJS.ProcessEnv) {
    this.root = join(stateDir(env), "browser");
    this.recordPath = join(this.root, "system.json");
  }

  async start(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    try {
      const value: unknown = JSON.parse(await readFile(this.recordPath, "utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid browser system record");
      const candidate = value as SystemRecord;
      if (candidate.version !== 1 || !["manual", "automatic"].includes(candidate.policy) ||
          !(candidate.hypemanRoot === null || typeof candidate.hypemanRoot === "string") ||
          !(candidate.candidateRoot === null || candidate.candidateRoot === undefined || typeof candidate.candidateRoot === "string") ||
          !(candidate.latest === null || typeof candidate.latest === "string") ||
          !(candidate.checkedAt === null || typeof candidate.checkedAt === "string") ||
          !(candidate.checkError === null || typeof candidate.checkError === "string")) throw new Error("invalid browser system record");
      this.record = { ...candidate, candidateRoot: candidate.candidateRoot ?? null };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    this.timer = setInterval(() => { void this.checkUpdates().catch(() => undefined); }, DEFAULT_CHECK_INTERVAL_MS);
    this.timer.unref();
    // An owner launch never causes a network request or an unattended install.
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.updateTask;
    await this.operation;
    if (this.hostChild) {
      const child = this.hostChild;
      this.hostChild = null;
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => { if (child.exitCode !== null) resolve(); else child.once("exit", () => resolve()); });
    }
    if (this.managedHostStarted) await this.reapManagedCaddy();
  }

  private async reapManagedCaddy(): Promise<void> {
    const expected = `/opt/homebrew/bin/caddy run --config ${join(this.root, "hypeman", "data", "caddy", "config.json")}`;
    const { stdout } = await execFile("ps", ["-axo", "pid=,uid=,command="], { timeout: 5_000, maxBuffer: MAX_COMMAND_OUTPUT });
    const ownUid = typeof process.getuid === "function" ? process.getuid() : -1;
    for (const line of stdout.split("\n")) {
      const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      if (!match || Number(match[2]) !== ownUid || match[3] !== expected) continue;
      process.kill(Number(match[1]), "SIGTERM");
    }
  }

  private async save(): Promise<void> {
    const temp = join(this.root, `system.${process.pid}.${randomUUID()}.tmp`);
    try {
      await writeFile(temp, `${JSON.stringify(this.record)}\n`, { flag: "wx", mode: 0o600 });
      await rename(temp, this.recordPath);
    } finally { await rm(temp, { force: true }); }
    this.onChange?.();
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const task = this.operation.then(fn, fn);
    this.operation = task.then(() => undefined, () => undefined);
    return task;
  }

  private browserPath(): string {
    return join(this.root, "toolchain", "current", "node_modules", "agent-browser", "bin", process.platform === "darwin" && process.arch === "arm64" ? "agent-browser-darwin-arm64" : process.platform === "darwin" ? "agent-browser-darwin-x64" : process.arch === "arm64" ? "agent-browser-linux-arm64" : "agent-browser-linux-x64");
  }

  private async installedVersion(): Promise<string | null> {
    try {
      const binary = this.browserPath();
      const { stdout } = await execFile(binary, ["--version"], { timeout: 5_000, maxBuffer: 1024, env: this.env });
      return /^agent-browser (\S+)\s*$/.exec(stdout)?.[1] ?? null;
    } catch { return null; }
  }

  async browserStatus(): Promise<BrowserToolStatus> {
    const version = await this.installedVersion();
    return { installed: version !== null, version, location: version ? this.browserPath() : null,
      latest: this.record.latest, pending: this.record.latest && (!version || newer(this.record.latest, version)) ? this.record.latest : null,
      checkedAt: this.record.checkedAt, checkError: this.record.checkError, policy: this.record.policy };
  }

  async browserDetect(): Promise<Array<{ location: string; version: string | null; source: "agentstack" | "agentstart" }>> {
    const paths = [this.browserPath(), join(this.env.HOME ?? homedir(), ".local", "bin", "agent-browser")];
    const result: Array<{ location: string; version: string | null; source: "agentstack" | "agentstart" }> = [];
    for (const [index, path] of paths.entries()) {
      try {
        const { stdout } = await execFile(path, ["--version"], { timeout: 5_000, maxBuffer: 1024, env: this.env });
        result.push({ location: path, version: /^agent-browser (\S+)\s*$/.exec(stdout)?.[1] ?? null, source: index === 0 ? "agentstack" : "agentstart" });
      } catch { /* Not an installed, executable agent-browser. */ }
    }
    return result;
  }

  async checkUpdates(): Promise<BrowserToolStatus> {
    if (this.updateTask) { await this.updateTask; return this.browserStatus(); }
    const task = this.serial(async () => {
      try {
        const { stdout } = await execFile("npm", ["view", "agent-browser", "dist-tags.latest", "--json"], {
          cwd: this.root, env: this.env, timeout: 30_000, maxBuffer: MAX_COMMAND_OUTPUT,
        });
        const latest: unknown = JSON.parse(stdout);
        if (typeof latest !== "string" || !VERSION_PATTERN.test(latest)) throw new Error("registry returned an invalid release version");
        this.record = { ...this.record, latest, checkedAt: new Date().toISOString(), checkError: null };
        await this.save();
        const installed = await this.installedVersion();
        if (this.record.policy === "automatic" && (!installed || newer(latest, installed))) await this.installVersionLocked(latest);
      } catch (error) {
        this.record = { ...this.record, checkedAt: new Date().toISOString(), checkError: (error instanceof Error ? error.message : String(error)).slice(0, 240) };
        await this.save();
      }
    });
    this.updateTask = task.finally(() => { this.updateTask = null; });
    await this.updateTask;
    return this.browserStatus();
  }

  async setUpdatePolicy(policy: BrowserUpdatePolicy): Promise<BrowserToolStatus> {
    return this.serial(async () => {
      this.record = { ...this.record, policy };
      await this.save();
      return this.browserStatus();
    });
  }

  async installBrowser(version: string): Promise<BrowserToolStatus> {
    if (!VERSION_PATTERN.test(version)) throw new Error("agent-browser version must be an exact release");
    return this.serial(async () => { await this.installVersionLocked(version); return this.browserStatus(); });
  }

  async acceptUpdate(version: string): Promise<BrowserToolStatus> {
    return this.serial(async () => {
      const installed = await this.installedVersion();
      if (version !== this.record.latest || this.record.checkError !== null || (installed !== null && !newer(version, installed)))
        throw new Error("release is not the current observed pending update");
      await this.installVersionLocked(version);
      return this.browserStatus();
    });
  }

  private async installVersionLocked(version: string): Promise<void> {
    const directory = join(this.root, "toolchain");
    const target = join(directory, "releases", version);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    if (existsSync(target) && !safeDirectory(target)) throw new Error("refusing a foreign browser release directory");
    if (!existsSync(join(target, "node_modules", "agent-browser", "package.json"))) {
      if (existsSync(target)) throw new Error("browser release directory is incomplete; refusing to overwrite it");
      const staged = join(directory, `staging-${randomUUID()}`);
      await mkdir(staged, { mode: 0o700 });
      try {
        await execFile("npm", ["install", "--prefix", staged, "--ignore-scripts", "--no-audit", "--no-fund", `agent-browser@${version}`], {
          cwd: this.root, env: this.env, timeout: 180_000, maxBuffer: MAX_COMMAND_OUTPUT,
        });
        const pkg = JSON.parse(await readFile(join(staged, "node_modules", "agent-browser", "package.json"), "utf8")) as { name?: string; version?: string };
        if (pkg.name !== "agent-browser" || pkg.version !== version) throw new Error("downloaded agent-browser release identity mismatch");
        const binary = join(staged, "node_modules", "agent-browser", "bin", basename(this.browserPath()));
        if (!safeFile(binary)) throw new Error("downloaded agent-browser executable is not an owned regular file");
        await chmod(binary, 0o755);
        const { stdout } = await execFile(binary, ["--version"], { timeout: 5_000, maxBuffer: 1024, env: this.env });
        if (stdout.trim() !== `agent-browser ${version}`) throw new Error("downloaded agent-browser executable version mismatch");
        await rename(staged, target);
      } finally { await rm(staged, { recursive: true, force: true }); }
    }
    const current = join(directory, "current");
    const temporary = join(directory, `.current-${randomUUID()}`);
    const { symlink, lstat, readlink } = await import("node:fs/promises");
    try {
      await symlink(target, temporary);
      if ((existsSync(current) || await lstat(current).then(() => true, () => false)) && !(await lstat(current)).isSymbolicLink()) throw new Error("refusing to replace an independent browser installation");
      if (await lstat(current).then(() => true, () => false) && !(await readlink(current)).startsWith(resolve(directory, "releases") + "/")) throw new Error("refusing to replace a foreign browser link");
      await rename(temporary, current);
    } finally { await rm(temporary, { force: true }); }
    this.onChange?.();
  }

  async uninstallBrowser(): Promise<BrowserToolStatus> {
    return this.serial(async () => {
      const current = join(this.root, "toolchain", "current");
      if (existsSync(current) || await (await import("node:fs/promises")).lstat(current).then(() => true, () => false)) {
        const { lstat } = await import("node:fs/promises");
        if (!(await lstat(current)).isSymbolicLink()) throw new Error("refusing to uninstall a foreign browser installation");
        const { readlink } = await import("node:fs/promises");
        if (!(await readlink(current)).startsWith(resolve(this.root, "toolchain", "releases") + "/")) throw new Error("refusing to uninstall a foreign browser link");
        await rm(current);
      }
      this.onChange?.();
      return this.browserStatus();
    });
  }

  private candidateRoots(): Array<{ root: string; source: HypemanInstallation["source"] }> {
    const roots = [
      { root: join(this.root, "hypeman"), source: "agentstack" as const },
      { root: join(this.env.HOME ?? homedir(), ".local", "share", "ab-hypeman"), source: "legacy" as const },
      ...(this.record.hypemanRoot ? [{ root: this.record.hypemanRoot, source: "custom" as const }] : []),
      ...(this.record.candidateRoot ? [{ root: this.record.candidateRoot, source: "custom" as const }] : []),
    ];
    const unique = new Map<string, (typeof roots)[number]>();
    for (const entry of roots) if (!unique.has(entry.root)) unique.set(entry.root, entry);
    return [...unique.values()];
  }

  async detectHypeman(): Promise<HypemanInstallation[]> {
    return Promise.all(this.candidateRoots().map(async ({ root, source }) => {
      const installed = safeDirectory(root) && safeFile(join(root, "bin", "hypeman-api"));
      let running = false;
      let issue: string | null = null;
      if (installed) {
        try {
          const connection = await this.connection(root);
          const response = await fetch(`${connection.baseUrl}/instances`, { headers: { Authorization: `Bearer ${connection.token}` }, signal: AbortSignal.timeout(2000) });
          running = response.ok;
          if (!response.ok) issue = `host returned HTTP ${response.status}`;
          await response.body?.cancel();
        } catch { issue = "host unavailable"; }
      }
      return { root, installed, selected: this.record.hypemanRoot === root, source, running, issue };
    }));
  }

  async connection(root = this.selectedHypemanRoot()): Promise<{ baseUrl: string; token: string }> {
    if (!safeDirectory(root)) throw new Error("Hypeman root must be an owned, nonsymlinked local directory");
    if (!safeFile(join(root, "connection.json"))) throw new Error("Hypeman connection descriptor must be an owned regular file");
    const descriptor = JSON.parse(await readFile(join(root, "connection.json"), "utf8")) as { baseUrl?: string; tokenFile?: string };
    if (!descriptor.baseUrl || !descriptor.tokenFile) throw new Error("Hypeman connection descriptor is incomplete");
    const url = new URL(descriptor.baseUrl);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.pathname !== "/" || url.search || url.hash) throw new Error("only a local loopback Hypeman instance can be selected");
    if (resolve(descriptor.tokenFile) !== join(root, "token") || !safeFile(join(root, "token"))) throw new Error("Hypeman token must belong to the selected local root");
    const token = (await readFile(descriptor.tokenFile, "utf8")).trim();
    if (!token || /\s/.test(token)) throw new Error("invalid Hypeman token");
    return { baseUrl: url.origin, token };
  }

  async guestSubnet(): Promise<(address: string) => boolean> {
    const root = this.selectedHypemanRoot();
    const config = JSON.parse(await readFile(join(root, "config.yaml"), "utf8")) as { network?: { subnet_cidr?: string } };
    const cidr = config.network?.subnet_cidr;
    const match = /^(192\.168|10)\.(\d{1,3})\.(\d{1,3})\/24$/.exec(cidr ?? "");
    if (!match || Number(match[2]) > 255 || Number(match[3]) !== 0) throw new Error("Hypeman guest subnet must be a private /24");
    const prefix = `${match[1]}.${match[2]}.`;
    return (ip) => {
      const part = ip.startsWith(prefix) ? ip.slice(prefix.length) : "";
      return /^(?:[1-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-4])$/.test(part);
    };
  }

  async ensureRunning(): Promise<void> {
    if (this.hostStart) return this.hostStart;
    const start = async () => {
      const root = this.selectedHypemanRoot();
      const connection = await this.connection(root);
      const probe = async () => {
        try {
          const response = await fetch(`${connection.baseUrl}/instances`, { headers: { Authorization: `Bearer ${connection.token}` }, signal: AbortSignal.timeout(1000) });
          await response.body?.cancel();
          return response.ok;
        } catch { return false; }
      };
      if (await probe()) return;
      if (!this.hostChild) {
        if (root !== join(this.root, "hypeman")) throw new Error("the selected external Hypeman service is stopped; AgentStack will not start an independent installation");
        const configPath = join(root, "config.yaml");
        if (!safeFile(configPath) || !safeFile(join(root, "bin", "hypeman-api"))) throw new Error("managed Hypeman has unsafe config or executable");
        const config = JSON.parse(await readFile(configPath, "utf8")) as { port?: string };
        if (!config.port || connection.baseUrl !== `http://127.0.0.1:${config.port}`) throw new Error("Hypeman config and connection disagree");
        const log = openSync(join(root, "agentstack-host.log"), "a", 0o600);
        try {
          const child = spawn(join(root, "bin", "hypeman-api"), [], {
            cwd: root, env: { ...this.env, CONFIG_PATH: configPath, PATH: `/opt/homebrew/opt/e2fsprogs/sbin:${this.env.PATH ?? "/usr/bin:/bin"}` },
            stdio: ["ignore", log, log],
          });
          child.once("error", () => { if (this.hostChild === child) this.hostChild = null; });
          child.once("exit", () => { if (this.hostChild === child) this.hostChild = null; });
          this.hostChild = child;
          this.managedHostStarted = true;
        } finally { closeSync(log); }
      }
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        if (await probe()) return;
        if (!this.hostChild) throw new Error("Hypeman exited while starting; inspect its private host log");
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      throw new Error("local Hypeman did not become ready; inspect its private host log");
    };
    this.hostStart = start().finally(() => { this.hostStart = null; });
    return this.hostStart;
  }

  selectedHypemanRoot(): string {
    if (!this.record.hypemanRoot) throw new Error("no local Hypeman installation is enabled");
    return this.record.hypemanRoot;
  }

  async enableHypeman(root: string | null): Promise<HypemanInstallation[]> {
    return this.serial(async () => {
      if (root !== null) {
        if (!this.candidateRoots().some((candidate) => candidate.root === root) || !safeFile(join(root, "bin", "hypeman-api"))) throw new Error("selected Hypeman root is not a detected installation");
        await this.connection(root);
      }
      this.record = { ...this.record, hypemanRoot: root };
      await this.save();
      return this.detectHypeman();
    });
  }

  async installHypeman(): Promise<HypemanInstallation[]> {
    return this.serial(async () => {
      const root = join(this.root, "hypeman");
      const receiptPath = join(root, "agentstack-install.json");
      if (existsSync(root) && (!safeDirectory(root) || !safeFile(receiptPath)))
        throw new Error("refusing to replace an independent Hypeman installation");
      const platform = `${process.platform}_${process.arch === "x64" ? "amd64" : process.arch}`;
      const digest = HYPEMAN_ARCHIVES[platform];
      if (!digest) throw new Error("Hypeman has no reviewed release for this platform");
      if (existsSync(receiptPath)) {
        const existing = JSON.parse(await readFile(receiptPath, "utf8")) as { version?: string; digest?: string };
        if (existing.version !== HYPEMAN_VERSION || existing.digest !== digest) throw new Error("Hypeman installation receipt differs from the reviewed release");
        return this.detectHypeman();
      }
      const staged = join(this.root, `hypeman-staging-${randomUUID()}`);
      await mkdir(staged, { mode: 0o700 });
      try {
        const archive = join(staged, "release.tar.gz");
        const url = `https://github.com/kernel/hypeman/releases/download/v${HYPEMAN_VERSION}/hypeman_${HYPEMAN_VERSION}_${platform}.tar.gz`;
        await execFile("curl", ["--fail", "--location", "--retry", "2", "--output", archive, url], { timeout: 180_000, maxBuffer: MAX_COMMAND_OUTPUT });
        const { createReadStream } = await import("node:fs");
        const { createHash } = await import("node:crypto");
        const hash = createHash("sha256");
        for await (const chunk of createReadStream(archive)) hash.update(chunk);
        if (hash.digest("hex") !== digest) throw new Error("Hypeman release checksum mismatch");
        const { stdout } = await execFile("tar", ["-tzf", archive], { timeout: 10_000, maxBuffer: MAX_COMMAND_OUTPUT });
        const entries = stdout.trim().split("\n").map((name) => name.replace(/^\.\//, ""));
        if (entries.some((name) => !["", "hypeman-api", "hypeman-token", "hypeman-uffd-pager", "config.example.darwin.yaml", "config.example.linux.yaml"].includes(name)) || !entries.includes("hypeman-api") || !entries.includes("hypeman-token"))
          throw new Error("Hypeman release archive has unexpected entries");
        const binaries = join(staged, "bin");
        await mkdir(binaries, { mode: 0o700 });
        const names = ["hypeman-api", "hypeman-token", ...(entries.includes("hypeman-uffd-pager") ? ["hypeman-uffd-pager"] : [])];
        await execFile("tar", ["-xzf", archive, "-C", binaries, ...names.map((name) => `./${name}`)], { timeout: 30_000, maxBuffer: MAX_COMMAND_OUTPUT });
        for (const name of names) {
          if (!safeFile(join(binaries, name))) throw new Error("Hypeman archive contains a nonregular binary");
          await chmod(join(binaries, name), 0o755);
        }
        if (process.platform === "darwin") {
          const entitlements = join(staged, "entitlements.plist");
          await writeFile(entitlements, `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>com.apple.security.virtualization</key><true/><key>com.apple.security.network.server</key><true/><key>com.apple.security.network.client</key><true/></dict></plist>`, { mode: 0o600 });
          await execFile("codesign", ["--force", "--sign", "-", "--entitlements", entitlements, join(binaries, "hypeman-api")], { timeout: 30_000, maxBuffer: MAX_COMMAND_OUTPUT });
        }
        const port = 4975;
        const jwt = randomBytes(32).toString("hex");
        const config = {
          jwt_secret: jwt, data_dir: join(root, "data"), port: String(port),
          hypervisor: { default: process.platform === "darwin" ? "vz" : "cloud-hypervisor" },
          caddy: { listen_address: "127.0.0.1", admin_port: port + 1, http_port: port + 2, https_port: port + 3 },
          metrics: { port: port + 4, listen_address: "127.0.0.1" },
          network: { dns_server: "1.1.1.1", subnet_cidr: process.platform === "darwin" ? "192.168.64.0/24" : "10.212.0.0/24", bridge_name: process.platform === "darwin" ? "nat" : "ashype0" },
          logging: { level: "info" }, oversubscription: { disk: 2.0 },
        };
        await writeFile(join(staged, "config.yaml"), `${JSON.stringify(config)}\n`, { mode: 0o600 });
        const { stdout: token } = await execFile(join(binaries, "hypeman-token"), ["-user-id", "agentstack", "-duration", "8760h"], { env: { ...this.env, JWT_SECRET: jwt }, timeout: 5_000, maxBuffer: 10_000 });
        await writeFile(join(staged, "token"), `${token.trim()}\n`, { mode: 0o600 });
        await writeFile(join(staged, "connection.json"), `${JSON.stringify({ baseUrl: `http://127.0.0.1:${port}`, tokenFile: join(root, "token") })}\n`, { mode: 0o600 });
        await writeFile(join(staged, "agentstack-install.json"), `${JSON.stringify({ version: HYPEMAN_VERSION, digest, installedAt: new Date().toISOString() })}\n`, { mode: 0o600 });
        await rm(archive);
        await mkdir(join(staged, "logs"), { mode: 0o700 });
        await rename(staged, root);
        this.onChange?.();
      } finally { await rm(staged, { recursive: true, force: true }); }
      return this.detectHypeman();
    });
  }

  async uninstallHypeman(discardData: boolean): Promise<HypemanInstallation[]> {
    return this.serial(async () => {
      const root = join(this.root, "hypeman");
      if (!safeDirectory(root) || !safeFile(join(root, "agentstack-install.json"))) throw new Error("only AgentStack-owned Hypeman can be uninstalled through this operation");
      if (this.record.hypemanRoot === root) throw new Error("disable this Hypeman installation before uninstalling it");
      if (!discardData) throw new Error("managed Hypeman stores its images and state under this root; confirm data disposal to uninstall");
      const sessions = join(this.root, "sessions.json");
      if (existsSync(sessions) && (JSON.parse(await readFile(sessions, "utf8")) as unknown[]).length)
        throw new Error("browser reservations remain; close or reconcile them before uninstalling Hypeman");
      const connected = await this.connection(root);
      let instances: unknown;
      let volumes: unknown;
      let reachable = false;
      try {
        const headers = { Authorization: `Bearer ${connected.token}` };
        const [i, v] = await Promise.all(["/instances", "/volumes"].map((path) => fetch(connected.baseUrl + path, { headers, signal: AbortSignal.timeout(3_000) })));
        reachable = true;
        if (!i.ok || !v.ok) throw new Error("Hypeman inventory failed");
        instances = await i.json(); volumes = await v.json();
      } catch { /* Stopped host: explicit disposal and empty AgentStack ledger are required. */ }
      if ((Array.isArray(instances) && instances.length) || (Array.isArray(volumes) && volumes.length))
        throw new Error("Hypeman still contains instances or profile volumes; refusing uninstall");
      if (this.hostChild || reachable) throw new Error("stop managed Hypeman before uninstalling it");
      await rm(root, { recursive: true });
      this.onChange?.();
      return this.detectHypeman();
    });
  }

  async setHypemanLocation(root: string): Promise<HypemanInstallation[]> {
    if (!isAbsolute(root) || resolve(root) !== root) throw new Error("Hypeman location must be an absolute canonical directory");
    // Adding a detected location never enables it or contacts a remote host.
    return this.serial(async () => {
      this.record = { ...this.record, candidateRoot: root };
      await this.save();
      return this.detectHypeman();
    });
  }
}

function safeFile(path: string): boolean {
  try {
    const info = lstatSync(path);
    return info.isFile() && !info.isSymbolicLink() && (typeof process.getuid !== "function" || info.uid === process.getuid());
  } catch { return false; }
}

function newer(candidate: string, installed: string): boolean {
  const numbers = (v: string) => /^([0-9]+)\.([0-9]+)\.([0-9]+)$/.exec(v)?.slice(1).map(Number);
  const a = numbers(candidate); const b = numbers(installed);
  if (!a || !b) return false;
  for (let index = 0; index < 3; index += 1) {
    if (a[index]! !== b[index]!) return a[index]! > b[index]!;
  }
  return false;
}
