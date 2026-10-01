import { execFile } from "node:child_process";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { socketCall } from "@stack/api";
import type { Release, PlatformConfiguration } from "./contract.js";
import { ClientState, digest } from "./state.js";

class ServiceCommandError extends Error {
  constructor(readonly exitCode: string | number | undefined, readonly output: string) { super("service_command_failed"); }
}
function run(command: string, args: string[]) {
  return new Promise<string>((resolve, reject) => execFile(command, args, { timeout: 30_000, maxBuffer: 65_536 }, (error, stdout) => {
    if (error) reject(new ServiceCommandError(error.code, stdout)); else resolve(stdout);
  }));
}
const xml = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const unit = (value: string) => `"${value.replaceAll("%", "%%").replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
export class PlatformService {
  readonly name: string;
  readonly path: string;
  readonly platformState: string;
  constructor(readonly state: ClientState) {
    this.name = `dev.stack.platform.${digest(state.root).slice(0, 16)}`;
    this.platformState = join(state.root, "platform", "state");
    this.path = process.platform === "darwin" ? join(homedir(), "Library", "LaunchAgents", `${this.name}.plist`)
      : join(homedir(), ".config", "systemd", "user", `${this.name}.service`);
  }
  private domain() { if (!process.getuid || process.getuid() === 0) throw new Error("target_user_required"); return `gui/${process.getuid()}`; }
  private command() {
    const release = this.state.read<Release>("installation")?.value;
    if (!release) throw new Error("platform_not_installed");
    return join(this.state.root, "releases", release.sha256, "bin", "stack");
  }
  private content(enabled: boolean) {
    const launcher = this.command();
    const env: Record<string, string> = { STACK_STATE_DIR: this.platformState };
    const configuration = this.state.read<PlatformConfiguration>("configuration")?.value ?? {};
    const names = { ui: "STACK_UI_PORT", websocket: "STACK_WEBSOCKET_PORT", mcp: "STACK_MCP_PORT", inspector: "STACK_INSPECTOR_PORT",
      documents: "STACK_CONTENT_PORT", artifacts: "STACK_CONTENT_ARTIFACT_PORT", brain: "STACK_BRAIN_SHARE_PORT" };
    for (const [name, port] of Object.entries(configuration.ports ?? {})) env[names[name as keyof typeof names]] = String(port);
    if (configuration.access) {
      const a = configuration.access;
      Object.assign(env, { STACK_ACCESS_HOST: a.host, STACK_ACCESS_ORIGIN: a.deviceOrigin, STACK_ACCESS_PORT: new URL(a.deviceOrigin).port || "443",
        STACK_ACCESS_ARTIFACT_PORT: String(a.artifactPort), STACK_ACCESS_UI_ORIGIN: a.uiOrigin, STACK_ACCESS_UI_PORT: new URL(a.uiOrigin).port || "443",
        STACK_ACCESS_TLS_CERT: a.tlsCert, STACK_ACCESS_TLS_KEY: a.tlsKey });
    }
    if (process.platform === "darwin") return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${this.name}</string><key>ProgramArguments</key><array><string>${xml(launcher)}</string><string>serve</string></array><key>EnvironmentVariables</key><dict>${Object.entries(env).map(([key, value]) => `<key>${key}</key><string>${xml(value)}</string>`).join("")}</dict><key>RunAtLoad</key><${enabled ? "true" : "false"}/><key>ExitTimeOut</key><integer>300</integer><key>StandardOutPath</key><string>${xml(join(this.state.root, "platform", "service.log"))}</string><key>StandardErrorPath</key><string>${xml(join(this.state.root, "platform", "service.log"))}</string></dict></plist>\n`;
    return `[Unit]\nDescription=Stack platform (client-owned)\n[Service]\nType=simple\nExecStart=${unit(launcher)} serve\n${Object.entries(env).map(([key, value]) => `Environment=${unit(`${key}=${value}`)}`).join("\n")}\nRestart=on-failure\nTimeoutStopSec=300\n[Install]\nWantedBy=default.target\n`;
  }
  private async verifyOwned() {
    const expected = this.state.read<{ hash: string }>("service-file");
    const info = await lstat(this.path).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
    if (info && (!info.isFile() || !expected || digest(await readFile(this.path, "utf8")) !== expected.value.hash)) throw new Error("service_ownership_conflict");
    return !!info;
  }
  async observe() {
    let owned = await this.verifyOwned();
    let registered = false, running = false, available = true;
    try {
      if (process.platform === "darwin") {
        const text = await run("launchctl", ["print", `${this.domain()}/${this.name}`]);
        registered = true; running = /\bstate = running\b/.test(text) || /^\s*pid = [1-9]\d*$/m.test(text);
        const definition = /^\s*path = (.+)$/m.exec(text)?.[1];
        owned = owned && !!definition && await realpath(definition) === await realpath(this.path);
      } else {
        const text = await run("systemctl", ["--user", "show", `${this.name}.service`, "--property=LoadState,ActiveState,FragmentPath", "--no-pager"]);
        registered = text.includes("LoadState=loaded"); running = /^ActiveState=(active|activating|deactivating|reloading)$/m.test(text);
        if (registered) {
          const definition = /^FragmentPath=(.+)$/m.exec(text)?.[1];
          owned = owned && !!definition && await realpath(definition) === await realpath(this.path);
        }
      }
    } catch (error) {
      // launchctl's missing-service result is definite. Other failures do not
      // prove absence and must not authorize replacing a possibly live service.
      if (!(error instanceof ServiceCommandError && (process.platform === "darwin" && error.exitCode === 113
        || process.platform === "linux" && error.exitCode === 4 && error.output.includes("LoadState=not-found")))) available = false;
    }
    const socket = join(this.platformState, "sockets", "serve.sock");
    const platform = await socketCall(socket, "tools/call", { name: "serve_status", arguments: {} }, { timeoutMs: 1000 }).catch(() => null);
    return { owned, registered, running, available, ready: platform !== null, platform, path: this.path,
      login: { saved: this.state.read<boolean>("login")?.value ?? false, applied: this.state.read<boolean>("login-applied")?.value ?? false } };
  }
  async configure(enabled: boolean) {
    await this.verifyOwned();
    const observed = await this.observe();
    if (!observed.available) throw new Error("service_observation_unavailable");
    if (observed.registered && !observed.owned) throw new Error("service_not_owned");
    if (process.platform === "darwin" && observed.running) return { applied: false };
    const configurationRevision = this.state.read("configuration")?.revision ?? 0;
    const content = this.content(enabled);
    await mkdir(join(this.state.root, "platform"), { recursive: true, mode: 0o700 });
    await mkdir(join(this.path, ".."), { recursive: true, mode: 0o700 });
    if (process.platform === "darwin" && observed.registered) await run("launchctl", ["bootout", `${this.domain()}/${this.name}`]);
    await writeFile(this.path, content, { mode: 0o600 });
    this.state.write("service-file", { hash: digest(content) });
    if (process.platform === "linux") {
      await run("systemctl", ["--user", "daemon-reload"]);
      await run("systemctl", ["--user", enabled ? "enable" : "disable", `${this.name}.service`]);
    }
    this.state.write("login-applied", enabled);
    return { applied: true, configurationRevision };
  }
  async start() {
    const status = await this.observe();
    if (!status.available) throw new Error("service_observation_unavailable");
    if (status.registered && !status.owned) throw new Error("service_not_owned");
    if (status.running) return;
    if (status.ready) throw new Error("unmanaged_platform_running");
    const enabled = this.state.read<boolean>("login")?.value ?? false;
    const configured = await this.configure(enabled);
    if (!configured.applied) return;
    if (process.platform === "darwin") {
      await run("launchctl", ["bootstrap", this.domain(), this.path]);
      if (!enabled) await run("launchctl", ["kickstart", `${this.domain()}/${this.name}`]);
    } else await run("systemctl", ["--user", "start", `${this.name}.service`]);
    this.state.write("configuration-applied", configured.configurationRevision);
  }
  async stop() {
    if (!await this.verifyOwned()) throw new Error("service_not_owned");
    const status = await this.observe();
    if (!status.available) throw new Error("service_observation_unavailable");
    if (status.registered && !status.owned) throw new Error("service_not_owned");
    if (!status.registered) return;
    if (process.platform === "darwin") await run("launchctl", ["bootout", `${this.domain()}/${this.name}`]);
    else await run("systemctl", ["--user", "stop", `${this.name}.service`]);
  }
  async open() {
    return socketCall(join(this.platformState, "sockets", "serve.sock"), "tools/call", { name: "serve_local_connect", arguments: { target: "ui" } });
  }
}
