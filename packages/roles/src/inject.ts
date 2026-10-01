import { spawn, execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { internalMcpLaunches, mcpPort, mcpToolTimeoutSeconds, stateDir, workspaceRoot } from "@stack/api";
import { roleMcpConflict, serverMcpOrigins } from "./bundle.js";
import { injectArguments, type Harness } from "./inject-args.js";
import { startOpenCodeHost } from "./inject-opencode.js";
import { mcpRecord, skillRecord } from "./resources.js";
import { RoleStore, renderInstructions, type RoleSnapshot } from "./store.js";
import { processBirth } from "./launch-state.js";

type Mcp = { type: "http"; url: string; headers: Record<string, string> } |
  { type: "stdio"; command: string; args: string[]; env: Record<string, string> };
const json = (value: unknown) => JSON.stringify(value, null, 2);
const asciiFold = (value: string) => value.replace(/[A-Z]/g, (char) => char.toLowerCase());

async function executable(command: string): Promise<string> {
  const paths = isAbsolute(command) ? [command] : command.includes("/") ? [resolve(command)]
    : (process.env.PATH ?? "").split(delimiter).filter(Boolean).map((path) => resolve(path, command));
  for (const path of paths) {
    try { await access(path, constants.X_OK); if ((await stat(path)).isFile()) return path; } catch { /* next PATH entry */ }
  }
  throw new Error(`executable is unavailable: ${command}`);
}

async function snapshotFor(name: string): Promise<RoleSnapshot> {
  const store = new RoleStore(stateDir(), { readOnly: true });
  try { return store.namedLaunchSnapshot(name); } finally { store.close(); }
}

async function connections(snapshot: RoleSnapshot): Promise<Record<string, Mcp>> {
  const launches = await internalMcpLaunches(workspaceRoot(import.meta.dirname), { kind: "operator" });
  const names = new Set(Object.keys(launches).map(asciiFold));
  const ports = [mcpPort(), Number(process.env.STACK_SERVER_MCP_PORT)].filter(port => Number.isInteger(port) && port > 0);
  const origins = new Set(ports.flatMap(serverMcpOrigins));
  const servers: Record<string, Mcp> = {};
  for (const [name, launch] of Object.entries(launches))
    if (!snapshot.disabledInternalMcpServers.includes(name)) servers[name] = launch;
  const requiredEnv = (key: string) => {
    const value = process.env[key];
    if (value === undefined) throw new Error(`Role MCP environment variable ${key} is unavailable`);
    return value;
  };
  for (const value of snapshot.mcpServers) {
    const server = mcpRecord.parse(value);
    const conflict = roleMcpConflict(server, names, origins);
    if (conflict) throw new Error(conflict);
    if (!server.enabled) continue;
    const definition = server.definition;
    if (definition.type === "stdio") {
      const env = { ...definition.env };
      for (const name of definition.envVars ?? []) env[name] = requiredEnv(name);
      servers[server.name] = { type: "stdio", command: await executable(definition.command), args: definition.args, env };
    } else {
      const headers = { ...definition.httpHeaders };
      if (definition.bearerTokenEnvVar) headers.Authorization = `Bearer ${requiredEnv(definition.bearerTokenEnvVar)}`;
      for (const [name, key] of Object.entries(definition.envHttpHeaders ?? {})) headers[name] = requiredEnv(key);
      servers[server.name] = { type: "http", url: definition.url, headers };
    }
  }
  return servers;
}

async function file(path: string, contents: string | Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, contents, { mode: 0o600 });
}

async function skills(path: string, snapshot: RoleSnapshot): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  for (const value of snapshot.skills) {
    const skill = skillRecord.parse(value);
    if (!skill.enabled) continue;
    const root = join(path, skill.name);
    await file(join(root, "SKILL.md"), `---\nname: ${JSON.stringify(skill.name)}\ndescription: ${JSON.stringify(skill.description)}\n---\n\n${skill.body}\n`);
    for (const item of skill.files) await file(join(root, item.path), Buffer.from(item.contentBase64, "base64"));
  }
}

function tomlConfig(instructions: string, servers: Record<string, Mcp>): string {
  const quote = JSON.stringify;
  const map = (values: Record<string, string>) => `{ ${Object.entries(values).map(([key, value]) => `${quote(key)} = ${quote(value)}`).join(", ")} }`;
  const lines = [`developer_instructions = ${quote(instructions)}`, ""];
  for (const [name, server] of Object.entries(servers)) {
    lines.push(`[mcp_servers.${quote(name)}]`);
    if (server.type === "http") lines.push(`url = ${quote(server.url)}`, `http_headers = ${map(server.headers)}`);
    else lines.push(`command = ${quote(server.command)}`, `args = [${server.args.map((arg) => quote(arg)).join(", ")}]`, `env = ${map(server.env)}`);
    lines.push(`tool_timeout_sec = ${mcpToolTimeoutSeconds(name)}`, "");
  }
  return lines.join("\n");
}

/** Fail before a turn if the installed executable lacks our native isolation contract. */
async function compatible(binary: string, harness: Harness, env: NodeJS.ProcessEnv): Promise<void> {
  const { stdout } = await promisify(execFile)(binary, [harness === "opencode" ? "--version" : "--help"], { env, timeout: 15_000, maxBuffer: 1_000_000 });
  const required = harness === "claude" ? ["--setting-sources", "--strict-mcp-config", "--plugin-dir", "--append-system-prompt", "--system-prompt-snapshot"] : ["--no-daemon"];
  if (harness === "opencode" ? !/^(?:opencode\s+)?v?2\.0\.16\s*$/.test(stdout) : required.some((flag) => !stdout.includes(flag)))
    throw new Error(`installed ${harness} does not support the roles inject isolation contract${harness === "opencode" ? "; the private host requires the matching stable OpenCode 2.0.16 CLI" : ""}`);
}

type Exit = { code: number; signal: NodeJS.Signals | null };
async function foreground(binary: string, args: string[], env: NodeJS.ProcessEnv, signal: AbortSignal, hostClosed?: Promise<void>): Promise<Exit> {
  signal.throwIfAborted();
  const child = spawn(binary, args, { env, stdio: "inherit" });
  const abort = () => { child.kill(signal.reason as NodeJS.Signals); };
  signal.addEventListener("abort", abort, { once: true });
  let running = true, hostFailed = false;
  void hostClosed?.then(() => { if (running && !signal.aborted) { hostFailed = true; child.kill("SIGTERM"); } });
  try {
    return await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => hostFailed ? reject(new Error("OpenCode Role host exited while the native CLI was running")) : resolve({ code: code ?? 1, signal }));
    });
  } finally { running = false; signal.removeEventListener("abort", abort); }
}

export async function inject(args: string[]): Promise<number> {
  const controller = new AbortController();
  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
  const listeners = signals.map((signal) => { const listener = () => controller.abort(signal); process.on(signal, listener); return listener; });
  let result: Exit | undefined;
  try { result = await launch(args, controller.signal); }
  catch (error) { if (!controller.signal.aborted) throw error; }
  finally { signals.forEach((signal, index) => process.off(signal, listeners[index]!)); }
  const signal = controller.signal.aborted ? controller.signal.reason as NodeJS.Signals : result?.signal;
  if (signal) { process.kill(process.pid, signal); return 1; }
  return result?.code ?? 1;
}

async function launch(args: string[], signal: AbortSignal): Promise<Exit> {
  const { role, harness, native, command, commandIndex, context } = injectArguments(args);
  const binary = await executable(harness);
  const snapshot = await snapshotFor(role);
  const servers = await connections(snapshot);
  const instructions = renderInstructions(snapshot, context);
  const parent = join(stateDir(), "roles", "inject");
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const root = await mkdtemp(join(parent, `${harness}-`));
  const lock = { version: 1, pid: process.pid, birth: await processBirth(process.pid), state: "preparing" };
  await file(join(root, "launch-lock.json"), json(lock));
  const capabilities = join(root, "capabilities");
  const env = { ...process.env };
  let launched = false;
  let result: Exit;
  let host: Awaited<ReturnType<typeof startOpenCodeHost>> | undefined;
  const cleanup: string[] = [capabilities];
  try {
    await file(join(root, "launch.json"), json({ harness, roleId: snapshot.id, roleRevision: snapshot.revision, createdAt: new Date().toISOString() }));
    let argv: string[];
    if (harness === "claude") {
      // setting-sources gates native home/project customizations without changing
      // keychain/OAuth lookup. Automatic memory has a separate native switch.
      for (const key of Object.keys(env)) if (/^CLAUDE_CODE_(?:SAFE_MODE|SIMPLE|CLIENT_DATA_URL|ADDITIONAL_DIRECTORIES_CLAUDE_MD|RESUME_|SESSION_)/.test(key)) delete env[key];
      env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = "1";
      await skills(join(capabilities, "plugin", "skills"), snapshot);
      await file(join(capabilities, "plugin", ".claude-plugin", "plugin.json"), json({ name: "stack-role", version: "1.0.0" }));
      await file(join(capabilities, "mcp.json"), json({ mcpServers: servers }));
      await file(join(capabilities, "instructions.md"), instructions);
      argv = ["--setting-sources", "", "--strict-mcp-config", "--mcp-config", join(capabilities, "mcp.json"),
        "--plugin-dir", join(capabilities, "plugin"), "--append-system-prompt-file", join(capabilities, "instructions.md"),
        "--system-prompt-snapshot", "off", ...native];
    } else if (harness === "codex") {
      const home = join(root, "home"), codexHome = join(home, ".codex");
      await mkdir(codexHome, { recursive: true, mode: 0o700 });
      const auth = join(resolve(process.env.CODEX_HOME ?? join(process.env.HOME ?? homedir(), ".codex")), "auth.json");
      if (!await stat(auth).then((value) => value.isFile(), () => false))
        throw new Error("roles inject requires existing Codex file credentials at CODEX_HOME/auth.json; keyring-only login is not supported");
      await symlink(auth, join(codexHome, "auth.json"));
      env.HOME = home; env.CODEX_HOME = codexHome;
      env.XDG_CONFIG_HOME = join(home, ".config"); env.XDG_DATA_HOME = join(home, ".local", "share");
      delete env.CODEX_MANAGED_CONFIG_PATH;
      await skills(join(codexHome, "skills"), snapshot);
      await file(join(codexHome, "config.toml"), tomlConfig(instructions, servers));
      cleanup.push(join(codexHome, "config.toml"), join(codexHome, "skills"), join(codexHome, "auth.json"));
      argv = command ? native : ["--no-daemon", ...native];
    } else {
      const config = join(capabilities, "config");
      for (const key of ["OPENCODE_CONFIG", "OPENCODE_CONFIG_CONTENT", "OPENCODE_CLI_CONFIG_CONTENT", "OPENCODE_SERVER_PASSWORD", "OPENCODE_PTY_HANDOFF"]) delete env[key];
      env.OPENCODE_CONFIG_DIR = config; env.OPENCODE_CONFIG_PROJECT_DISABLE = "1";
      env.XDG_CONFIG_HOME = join(capabilities, "xdg-config");
      env.OPENCODE_PASSWORD = randomBytes(32).toString("base64url");
      await skills(join(capabilities, "skills"), snapshot);
      const plugin = join(capabilities, "append");
      await file(join(plugin, "index.ts"), `export default {\n  id: "stack.roles.append",\n  async setup(ctx) {\n    const hook = await ctx.session.hook("context", (event) => {\n      event.system.push({ type: "text", text: ${JSON.stringify(instructions)} });\n    });\n    return () => hook.dispose();\n  },\n};\n`);
      const mcp = Object.fromEntries(Object.entries(servers).map(([name, server]) => [name, server.type === "http"
        ? { type: "remote", url: server.url, headers: server.headers, timeout: mcpToolTimeoutSeconds(name) * 1000 }
        : { type: "local", command: [server.command, ...server.args], environment: server.env, timeout: mcpToolTimeoutSeconds(name) * 1000 }]));
      // Instruction discovery is independent of config discovery and can walk
      // up to HOME/AGENTS.md even when project config is disabled.
      await file(join(config, "opencode.json"), json({ $schema: "https://opencode.ai/config.json", plugins: ["-opencode.config.compatibility", "-opencode.config.instruction", plugin], skills: [join(capabilities, "skills")], mcp: { servers: mcp } }));
      await file(join(config, "cli.json"), "{}\n");
      await file(join(env.XDG_CONFIG_HOME, "opencode", "cli.json"), "{}\n");
      // Version-check the exact CLI before the host can open the native database.
      await compatible(binary, harness, env);
      host = await startOpenCodeHost(env, signal);
      // --server belongs to the selected native subcommand, even when root
      // options precede `run` or `mini`; never reorder caller arguments.
      argv = commandIndex === undefined ? ["--server", host.url, ...native]
        : [...native.slice(0, commandIndex + 1), "--server", host.url, ...native.slice(commandIndex + 1)];
    }
    if (harness !== "opencode") await compatible(binary, harness, env);
    signal.throwIfAborted();
    await file(join(root, "launch-lock.json"), json({ ...lock, state: "running" }));
    launched = true;
    result = await foreground(binary, argv, env, signal, host?.closed);
  } finally {
    // A host can still be reading skills/plugins and MCP credentials until its
    // native scope has closed. Always reap it before removing those files.
    await host?.stop();
    if (!launched) await rm(root, { recursive: true, force: true });
    else {
      for (const path of cleanup) await rm(path, { recursive: true, force: true });
      if (harness !== "codex") await rm(root, { recursive: true, force: true });
      else {
        await file(join(root, "launch-lock.json"), json({ ...lock, state: "exited" }));
        console.error(`roles inject: private native history retained at ${root}`);
      }
    }
  }
  return result;
}
