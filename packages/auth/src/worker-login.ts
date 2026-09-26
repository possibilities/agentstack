import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { AuthStore } from "./store.js";
import { accountEnvironment, accountRoot, credentialEvidence, type WorkerAccount, type WorkerProvider } from "./worker-accounts.js";
import { ClaudeCredentialError, claudeLoginInvocation, type ClaudeCredentialOptions } from "./claude-credentials.js";

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

const providerNames: Record<WorkerProvider, string> = { codex: "Codex", grok: "Grok", devin: "Devin", claude: "Claude" };

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
    url: /https:\/\/(?:app\.devin\.ai\/auth\/cli\/continue|windsurf\.com\/devin\/account\/login)\?[^\s\x07\x1b]+/,
    code: null,
  },
  claude: {
    url: /https:\/\/(?:claude\.com\/cai\/oauth\/authorize|claude\.ai\/oauth\/authorize|platform\.claude\.com\/oauth\/authorize|console\.anthropic\.com\/oauth\/authorize)\?[^\s\x07\x1b<>"']+/,
    code: null,
  },
};

function shellQuote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }

function nativeCommand(env: NodeJS.ProcessEnv): WorkerCommand {
  const home = env.HOME ?? homedir();
  const opencode = env.AGENTSTACK_OPENCODE_BIN ?? join(home, ".local", "bin", "opencode");
  const devin = env.AGENTSTACK_DEVIN_BIN ?? join(home, ".local", "share", "devin", "cli", "_versions", "current", "bin", "devin");
  const claude = claudeLoginInvocation(env);
  return (account) => {
    if (account.provider === "claude") return claude;
    if (account.provider === "devin") {
      // devin auth login needs a terminal; script gives it a pty without opening one.
      // Current macOS Devin ignores BROWSER and remote markers and invokes open
      // directly. Deny only that executable for this sign-in and its descendants;
      // a missing or failed sandbox must fail the sign-in rather than fall back.
      if (platform() === "darwin") return {
        bin: "/usr/bin/sandbox-exec",
        args: ["-p", '(version 1) (allow default) (deny process-exec (literal "/usr/bin/open"))',
          "/usr/bin/script", "-q", "/dev/null", devin, "auth", "login", "--force-manual-token-flow"],
      };
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
  private readonly claude: ClaudeCredentialOptions;
  private readonly startQueues = new Map<string, Promise<void>>();
  private closed = false;

  constructor(private readonly store: AuthStore, options: { env?: NodeJS.ProcessEnv; command?: WorkerCommand; claude?: ClaudeCredentialOptions } = {}) {
    this.env = options.env ?? process.env;
    this.command = options.command ?? nativeCommand(this.env);
    this.claude = options.claude ?? {};
  }

  async start(account: WorkerAccount): Promise<WorkerLoginState> {
    if (this.closed) throw new Error("Worker sign-in manager is closed");
    const run = (this.startQueues.get(account.id) ?? Promise.resolve()).then(() => this.launch(account));
    const tail = run.then(() => undefined, () => undefined);
    this.startQueues.set(account.id, tail);
    void tail.then(() => { if (this.startQueues.get(account.id) === tail) this.startQueues.delete(account.id); });
    return run;
  }

  private async launch(account: WorkerAccount): Promise<WorkerLoginState> {
    for (const entry of [...this.pending.values()])
      if (entry.state.account === account.id) await this.supersede(entry);
    if (this.closed || !this.store.workerAccounts().some((item) => item.id === account.id && item.provider === account.provider && !item.removing))
      throw new Error("worker account is unavailable");
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
    // Keep remote-session hints for CLIs that honor them; on macOS the native
    // command's sandbox enforces browser suppression independently of these hints.
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
      let url = entry.output.match(prompts[account.provider].url)?.[0] ?? null;
      if (url && account.provider === "claude") {
        // Only an authorization request is public; never surface arbitrary URL credentials.
        const parsed = new URL(url);
        const allowed = new Set(["code", "response_type", "client_id", "redirect_uri", "scope", "code_challenge", "code_challenge_method", "state", "orgUUID", "login_hint", "login_method"]);
        if (url.length > 8192 || parsed.searchParams.get("response_type") !== "code" ||
            parsed.searchParams.has("code") && parsed.searchParams.get("code") !== "true" ||
            !parsed.searchParams.get("state") || !parsed.searchParams.get("code_challenge") ||
            [...parsed.searchParams.keys()].some((key) => !allowed.has(key))) url = null;
      }
      const code = prompts[account.provider].code ? entry.output.match(prompts[account.provider].code!)?.[1] ?? null : null;
      // Devin re-arms the paste field only when it re-prints its link or rejects
      // a submitted code; the buffer resets on submit so stale text cannot re-arm it.
      const rejected = account.provider === "devin" && entry.output.includes("Failed to exchange code");
      const claudePaste = account.provider === "claude" && Boolean(url || state.authUrl) && entry.output.includes("Paste code here if prompted");
      const changed = (url && url !== state.authUrl) || (code && code !== state.userCode)
        || (account.provider === "devin" && (Boolean(url) || rejected) && !state.needsCode)
        || (rejected && state.error === null) || (claudePaste && !state.needsCode);
      if (url) state.authUrl = url;
      if (code) state.userCode = code;
      if (rejected) state.error = "Devin didn't accept that code. Paste it again.";
      if (account.provider === "devin" && (url || rejected)) state.needsCode = true;
      if (claudePaste) state.needsCode = true;
      if (changed) this.onChange?.();
    };
    child.stdout?.on("data", scan);
    child.stderr?.on("data", scan);
    child.stdin?.on("error", () => { /* A native exit can race a paste; close owns the sanitized outcome. */ });
    child.once("error", () => this.fail(state, `Could not start the installed ${name} sign-in command`));
    child.once("close", (code) => { void this.finish(entry, code).finally(finished); });
    return { ...state };
  }

  submit(id: string, code: string): WorkerLoginState {
    const entry = this.pending.get(id);
    if (!entry) throw new Error("unknown Worker sign-in");
    if (entry.state.status !== "pending" || !["devin", "claude"].includes(entry.state.provider) || !entry.state.needsCode)
      throw new Error("this Worker sign-in is not waiting for a code");
    if (!code || code.length > 4096 || /[\x00-\x1f\x7f]/.test(code)) throw new Error("invalid sign-in code");
    entry.child.stdin?.write(`${code}${entry.state.provider === "claude" ? "\n" : "\r"}`);
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

  async cancel(id: string): Promise<void> {
    const entry = this.pending.get(id);
    if (!entry) throw new Error("no sign-in in progress");
    this.fail(entry.state, "Sign-in cancelled");
    this.terminate(entry);
    await entry.done;
  }

  /** Cancel any pending sign-in for the account, awaiting termination so a removed profile never has a live child. */
  async cancelAccount(accountId: string): Promise<void> {
    await this.startQueues.get(accountId);
    const waits: Promise<void>[] = [];
    for (const entry of [...this.pending.values()])
      if (entry.state.account === accountId) waits.push(this.cancel(entry.state.id));
    await Promise.all(waits);
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.all(this.startQueues.values());
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
        if (entry.child.pid) process.kill(-entry.child.pid, signal);
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
        const evidence = await credentialEvidence(this.store.stateDir, account, this.claude);
        if (state.status === "pending") this.store.confirmWorker(state.account, evidence.digest, evidence.identity);
      } else if (state.status === "pending") {
        failure = `${name} sign-in did not finish. Try again.`;
      }
    } catch (cause) {
      const safe = new Set(["these native credentials are already bound to another worker account",
        "this Claude identity is already bound to another worker account", "Claude sign-in does not match this Worker account"]);
      failure = cause instanceof ClaudeCredentialError || cause instanceof Error && safe.has(cause.message)
        ? cause.message : `${name} sign-in did not finish. Try again.`;
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
