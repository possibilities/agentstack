import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { AuthStore } from "./store.js";
import { accountEnvironment, accountRoot, credentialEvidence, type WorkerAccount, type WorkerProvider } from "./worker-accounts.js";

export type WorkerLoginState = {
  id: string;
  account: string;
  provider: WorkerProvider;
  status: "pending" | "complete" | "failed";
  authUrl: string | null;
  userCode: string | null;
  needsCode: boolean;
  error: string | null;
};

type WorkerCommand = (account: WorkerAccount) => { bin: string; args: string[] };
type Pending = { state: WorkerLoginState; child: ChildProcess; output: string; timer: ReturnType<typeof setTimeout> | undefined; done: Promise<void> };

const providerNames: Record<WorkerProvider, string> = { codex: "Codex", grok: "Grok", devin: "Devin" };

/** Strip terminal styling so only the literal prompt text can match. */
const strip = (value: string) => value.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "");

const prompts: Record<WorkerProvider, { url: RegExp; code: RegExp | null }> = {
  codex: {
    url: /https:\/\/auth\.openai\.com\/codex\/device(?![\w/-])/,
    code: /Enter code:\s*([A-Z0-9]+(?:-[A-Z0-9]+)+)/,
  },
  grok: {
    url: /https:\/\/accounts\.x\.ai\/oauth2\/device\?user_code=[A-Z0-9-]+/,
    code: /enter code:\s*([A-Z0-9]+(?:-[A-Z0-9]+)+)/i,
  },
  devin: {
    url: /https:\/\/app\.devin\.ai\/auth\/cli\/continue\?[^\s\x07\x1b]+/,
    code: null,
  },
};

function shellQuote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }

function nativeCommand(env: NodeJS.ProcessEnv): WorkerCommand {
  const home = env.HOME ?? homedir();
  const opencode = env.AGENTSTACK_OPENCODE_BIN ?? join(home, ".local", "bin", "opencode");
  const devin = env.AGENTSTACK_DEVIN_BIN ?? join(home, ".local", "share", "devin", "cli", "_versions", "current", "bin", "devin");
  return (account) => {
    if (account.provider === "devin") {
      // devin auth login needs a terminal; script gives it a pty without opening one.
      if (platform() === "darwin") return { bin: "/usr/bin/script", args: ["-q", "/dev/null", devin, "auth", "login", "--force-manual-token-flow"] };
      return { bin: "script", args: ["-q", "-e", "-c", `${shellQuote(devin)} auth login --force-manual-token-flow`, "/dev/null"] };
    }
    return {
      bin: opencode,
      args: ["auth", "login", "--standalone", "--method", account.provider === "grok" ? "device" : "chatgpt-headless", account.provider === "grok" ? "xai" : "openai"],
    };
  };
}

export class WorkerLoginManager {
  onChange: (() => void) | undefined;
  onAccountsChange: (() => void) | undefined;
  private readonly pending = new Map<string, Pending>();
  private readonly results = new Map<string, WorkerLoginState>();
  private readonly command: WorkerCommand;
  private readonly env: NodeJS.ProcessEnv;

  constructor(private readonly store: AuthStore, options: { env?: NodeJS.ProcessEnv; command?: WorkerCommand } = {}) {
    this.env = options.env ?? process.env;
    this.command = options.command ?? nativeCommand(this.env);
  }

  async start(account: WorkerAccount): Promise<WorkerLoginState> {
    for (const entry of [...this.pending.values()])
      if (entry.state.account === account.id) await this.supersede(entry);
    const id = randomBytes(12).toString("hex");
    const command = this.command(account);
    const name = providerNames[account.provider];
    const env = accountEnvironment(this.store.stateDir, account, { ...this.env });
    env.BROWSER = "/usr/bin/true";
    env.TERM = "dumb";
    const state: WorkerLoginState = { id, account: account.id, provider: account.provider, status: "pending", authUrl: null, userCode: null, needsCode: false, error: null };
    let finished: () => void = () => undefined;
    const done = new Promise<void>((resolve) => { finished = resolve; });
    // umask guards any file the CLI creates; credentials stay inside the account profile.
    // Devin runs under `script` for a pty, and macOS script needs a tty-compatible
    // stdin: spawn pipes are sockets (refused by tcgetattr) and FIFOs fail too, so
    // bash's `<(cat)` gives it a real pipe carrying whatever we write to stdin.
    // `detached` makes the shell a process-group leader so terminate() kills the
    // whole cat → script → devin chain.
    const dir = join(accountRoot(this.store.stateDir, account.id), "probe");
    const devin = account.provider === "devin";
    // devin's browser opener ignores BROWSER; marking the session remote keeps it link-only.
    if (devin) { env.SSH_CONNECTION = "127.0.0.1 0 127.0.0.1 0"; env.SSH_CLIENT = "127.0.0.1 0 0"; }
    const child = spawn(devin ? "/bin/bash" : "/bin/sh",
      devin ? ["-c", 'umask 077 && exec "$@" < <(cat)', "sh", command.bin, ...command.args]
            : ["-c", 'umask 077 && exec "$@"', "sh", command.bin, ...command.args], {
      cwd: dir,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    const entry: Pending = { state, child, output: "", timer: undefined, done };
    entry.timer = setTimeout(() => {
      if (state.status !== "pending") return;
      this.fail(state, `${name} sign-in expired. Start again for a new code.`);
      this.terminate(entry);
    }, 16 * 60_000);
    this.pending.set(id, entry);
    this.onChange?.();
    const scan = (chunk: Buffer) => {
      if (state.status !== "pending") return;
      // The link prompt is the only output the API may surface; never expose other output or credentials.
      entry.output = strip(entry.output + chunk.toString("utf8")).slice(-16_384);
      const url = entry.output.match(prompts[account.provider].url)?.[0] ?? null;
      const code = prompts[account.provider].code ? entry.output.match(prompts[account.provider].code!)?.[1] ?? null : null;
      // Devin re-arms the paste field only when it re-prints its link or rejects
      // a submitted code; the buffer resets on submit so stale text cannot re-arm it.
      const rejected = account.provider === "devin" && entry.output.includes("Failed to exchange code");
      const changed = (url && url !== state.authUrl) || (code && code !== state.userCode)
        || (account.provider === "devin" && (Boolean(url) || rejected) && !state.needsCode)
        || (rejected && state.error === null);
      if (url) state.authUrl = url;
      if (code) state.userCode = code;
      if (rejected) state.error = "Devin didn't accept that code. Paste it again.";
      if (account.provider === "devin" && (url || rejected)) state.needsCode = true;
      if (changed) this.onChange?.();
    };
    child.stdout?.on("data", scan);
    child.stderr?.on("data", scan);
    child.once("error", () => this.fail(state, `Could not start the installed ${name} sign-in command`));
    child.once("close", (code) => { void this.finish(entry, code).finally(finished); });
    return { ...state };
  }

  submit(id: string, code: string): WorkerLoginState {
    const entry = this.pending.get(id);
    if (!entry) throw new Error("unknown Worker sign-in");
    if (entry.state.status !== "pending" || entry.state.provider !== "devin" || !entry.state.needsCode)
      throw new Error("this Worker sign-in is not waiting for a code");
    if (!code || code.length > 4096 || /[\x00-\x1f\x7f]/.test(code)) throw new Error("invalid sign-in code");
    entry.child.stdin?.write(`${code}\r`);
    entry.output = "";
    entry.state.needsCode = false;
    entry.state.error = null;
    this.onChange?.();
    return { ...entry.state };
  }

  status(id: string): WorkerLoginState {
    const state = this.pending.get(id)?.state ?? this.results.get(id);
    if (!state) throw new Error("unknown Worker sign-in");
    return { ...state };
  }

  current(): WorkerLoginState[] {
    return [...this.pending.values()].filter((entry) => entry.state.status === "pending").map((entry) => ({ ...entry.state }));
  }

  cancel(id: string): void {
    const entry = this.pending.get(id);
    if (!entry) throw new Error("no sign-in in progress");
    this.fail(entry.state, "Sign-in cancelled");
    this.terminate(entry);
  }

  /** Cancel any pending sign-in for the account, awaiting termination so a removed profile never has a live child. */
  async cancelAccount(accountId: string): Promise<void> {
    const waits: Promise<void>[] = [];
    for (const entry of [...this.pending.values()])
      if (entry.state.account === accountId) { this.cancel(entry.state.id); waits.push(entry.done); }
    await Promise.all(waits);
  }

  async close(): Promise<void> {
    const entries = [...this.pending.values()];
    for (const entry of entries) {
      if (entry.state.status === "pending") this.fail(entry.state, "Worker sign-in stopped");
      this.terminate(entry);
    }
    await Promise.all(entries.map((entry) => entry.done));
  }

  private fail(state: WorkerLoginState, message: string): void {
    state.status = "failed";
    state.error = message;
    state.authUrl = null;
    state.userCode = null;
    state.needsCode = false;
    this.onChange?.();
  }

  private async supersede(entry: Pending): Promise<void> {
    if (entry.state.status === "pending") this.fail(entry.state, "Sign-in restarted with a new attempt");
    else { entry.state.authUrl = null; entry.state.userCode = null; entry.state.needsCode = false; }
    this.onChange?.();
    this.terminate(entry);
    await entry.done;
  }

  private terminate(entry: Pending): void {
    const kill = (signal: NodeJS.Signals) => {
      try {
        if (entry.child.pid && entry.child.exitCode === null && entry.child.signalCode === null)
          process.kill(-entry.child.pid, signal);
        else entry.child.kill(signal);
      } catch { entry.child.kill(signal); }
    };
    kill("SIGTERM");
    const force = setTimeout(() => kill("SIGKILL"), 2_000);
    void entry.done.then(() => clearTimeout(force));
  }

  private async finish(entry: Pending, code: number | null): Promise<void> {
    clearTimeout(entry.timer);
    // Release the `<(cat)` bridge's read end so it exits instead of lingering.
    try { entry.child.stdin?.destroy(); } catch { /* already closed */ }
    const { state } = entry;
    const name = providerNames[state.provider];
    let failure: string | null = null;
    try {
      if (state.status === "pending" && code === 0) {
        const account = this.store.workerAccounts().find((item) => item.id === state.account);
        if (!account) throw new Error("unknown worker account");
        const evidence = await credentialEvidence(this.store.stateDir, account);
        this.store.confirmWorker(state.account, evidence.digest);
      } else if (state.status === "pending") {
        failure = `${name} sign-in did not finish. Try again.`;
      }
    } catch (cause) {
      failure = cause instanceof Error ? cause.message : `${name} sign-in did not finish. Try again.`;
    } finally {
      state.authUrl = null;
      state.userCode = null;
      state.needsCode = false;
      const completed = !failure && state.status === "pending";
      if (failure && state.status === "pending") { state.status = "failed"; state.error = failure; }
      else if (completed) state.status = "complete";
      else if (failure) state.error = failure;
      this.pending.delete(state.id);
      this.results.set(state.id, { ...state });
      if (this.results.size > 20) this.results.delete(this.results.keys().next().value as string);
      if (completed) this.onAccountsChange?.();
      this.onChange?.();
    }
  }
}
