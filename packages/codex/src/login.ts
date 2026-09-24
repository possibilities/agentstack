import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { codexRuntimePath } from "./paths.js";
import { StateStore } from "./store.js";

type LoginState = { id: string; status: "pending" | "complete" | "failed"; authUrl: string | null; userCode: string | null; account: string | null; error: string | null; targetAccount: string | null };
type Pending = { state: LoginState; child: ChildProcess; directory: string; timer: ReturnType<typeof setTimeout> | undefined; replace: string | null; done: Promise<void> };

export class LoginManager {
  onChange: (() => void) | undefined;
  private readonly pending = new Map<string, Pending>();
  private readonly results = new Map<string, LoginState>();
  private startQueue: Promise<unknown> = Promise.resolve();

  constructor(private readonly store: StateStore, private readonly command: { bin: string; args: string[] } = {
    bin: codexRuntimePath(), args: ["-c", 'cli_auth_credentials_store="file"', "login", "--device-auth"],
  }) {}

  async start(replace: string | null = null): Promise<LoginState> {
    const run = this.startQueue.then(() => this.launch(replace));
    this.startQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  private async launch(replace: string | null): Promise<LoginState> {
    if (replace && !this.store.listAccounts().some((account) => account.name === replace)) throw new Error(`unknown Codex account: ${replace}`);
    for (const entry of [...this.pending.values()]) await this.supersede(entry);
    const directory = await mkdtemp(join(this.store.stateDir, ".login-"));
    const id = randomBytes(12).toString("hex");
    const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: directory, BROWSER: "/usr/bin/true" };
    for (const key of ["OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN", "OPENAI_BASE_URL", "CODEX_MULTI_AUTH_DIR", "AGENTUSAGE_AUTH_TOKEN", "AGENTUSAGE_ACCOUNT"]) delete env[key];
    const child = spawn(this.command.bin, this.command.args, {
      env, stdio: ["ignore", "pipe", "ignore"],
    });
    const state: LoginState = { id, status: "pending", authUrl: null, userCode: null, account: null, error: null, targetAccount: replace };
    let finished: () => void = () => undefined;
    const done = new Promise<void>((resolve) => { finished = resolve; });
    const entry: Pending = { state, child, directory, timer: undefined, replace, done };
    entry.timer = setTimeout(() => {
      if (state.status !== "pending") return;
      state.status = "failed";
      state.error = "Codex sign-in expired. Start again for a new code.";
      state.authUrl = null;
      state.userCode = null;
      this.terminate(entry);
    }, 16 * 60_000);
    this.pending.set(id, entry);
    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      if (state.status !== "pending") return;
      // The device prompt is the only CLI output the UI may surface; never expose other output or credentials.
      output = (output + chunk.toString("utf8")).slice(-16_384);
      const plain = output.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
      const url = plain.match(/https:\/\/auth\.openai\.com\/codex\/device(?![\w/-])/)?.[0];
      const code = plain.match(/Enter this one-time code[^\n]*\n[ \t]*([A-Z0-9]+(?:-[A-Z0-9]+)*)/)?.[1];
      if (url && code && !state.authUrl) {
        state.authUrl = url;
        state.userCode = code;
        this.onChange?.();
      }
    });
    child.once("error", () => {
      state.status = "failed";
      state.error = "Could not start the installed Codex login command";
    });
    child.once("close", (code) => { void this.finish(entry, code).finally(finished); });
    return state;
  }

  status(id: string): LoginState {
    const state = this.pending.get(id)?.state ?? this.results.get(id);
    if (!state) throw new Error("unknown Codex sign-in");
    return { ...state };
  }

  current(): LoginState | null {
    for (const entry of this.pending.values()) {
      if (entry.state.status === "pending") return { ...entry.state };
    }
    return null;
  }

  cancel(id: string): void {
    const entry = this.pending.get(id);
    if (!entry) throw new Error("no sign-in in progress");
    entry.state.status = "failed";
    entry.state.error = "Sign-in cancelled";
    entry.state.authUrl = null;
    entry.state.userCode = null;
    this.terminate(entry);
  }

  async close(): Promise<void> {
    const entries = [...this.pending.values()];
    for (const entry of entries) {
      if (entry.state.status === "pending") {
        entry.state.status = "failed";
        entry.state.error = "Codex sign-in stopped";
      }
      entry.state.authUrl = null;
      entry.state.userCode = null;
      this.terminate(entry);
    }
    await Promise.all(entries.map((entry) => entry.done));
  }

  private async supersede(entry: Pending): Promise<void> {
    if (entry.state.status === "pending") {
      entry.state.status = "failed";
      entry.state.error = "Sign-in restarted with a new attempt";
    }
    entry.state.authUrl = null;
    entry.state.userCode = null;
    this.terminate(entry);
    await entry.done;
  }

  private terminate(entry: Pending): void {
    entry.child.kill("SIGTERM");
    const force = setTimeout(() => entry.child.kill("SIGKILL"), 2_000);
    void entry.done.then(() => clearTimeout(force));
  }

  private async finish(entry: Pending, code: number | null): Promise<void> {
    clearTimeout(entry.timer);
    const { state, directory } = entry;
    let completedAccount: string | null = null;
    let failure: string | null = null;
    try {
      if (state.status === "pending" && code === 0) {
        const auth = await readFile(join(directory, "auth.json"), "utf8");
        if (state.status === "pending") {
          if (entry.replace) {
            this.store.replaceCredentials(entry.replace, auth);
            completedAccount = entry.replace;
          } else completedAccount = this.store.addAccount(auth).name;
        }
      } else if (state.status === "pending") {
        failure = "Codex sign-in did not finish. Try again.";
      }
    } catch {
      failure = "Codex did not save usable credentials. Try signing in again.";
    } finally {
      state.authUrl = null;
      state.userCode = null;
      try {
        await rm(directory, { recursive: true, force: true });
      } catch (error) {
        failure = "Codex sign-in cleanup failed. Inspect the private state directory.";
        console.error("Codex sign-in temporary directory cleanup failed:", error);
      }
      if (failure) { state.status = "failed"; state.error = failure; }
      else if (completedAccount) { state.status = "complete"; state.account = completedAccount; }
      this.pending.delete(state.id);
      this.results.set(state.id, { ...state });
      if (this.results.size > 20) this.results.delete(this.results.keys().next().value as string);
      this.onChange?.();
    }
  }
}
