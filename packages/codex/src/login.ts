import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { codexRuntimePath } from "./paths.js";
import { StateStore } from "./store.js";

type LoginState = { id: string; status: "pending" | "complete" | "failed"; authUrl: string | null; account: string | null; error: string | null };
type Pending = { state: LoginState; child: ChildProcess; directory: string; timer: ReturnType<typeof setTimeout>; replace: string | null };

export class LoginManager {
  onChange: (() => void) | undefined;
  private readonly pending = new Map<string, Pending>();
  private readonly results = new Map<string, LoginState>();

  constructor(private readonly store: StateStore, private readonly command: { bin: string; args: string[] } = {
    bin: codexRuntimePath(), args: ["-c", 'cli_auth_credentials_store="file"', "login"],
  }) {}

  async start(replace: string | null = null): Promise<LoginState> {
    if (this.pending.size) throw new Error("A Codex sign-in is already in progress");
    if (replace && !this.store.listAccounts().some((account) => account.name === replace)) throw new Error(`unknown Codex account: ${replace}`);
    const directory = await mkdtemp(join(this.store.stateDir, ".login-"));
    const id = randomBytes(12).toString("hex");
    const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: directory, BROWSER: "/usr/bin/true" };
    for (const key of ["OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN", "OPENAI_BASE_URL", "CODEX_MULTI_AUTH_DIR", "AGENTUSAGE_AUTH_TOKEN", "AGENTUSAGE_ACCOUNT"]) delete env[key];
    const child = spawn(this.command.bin, this.command.args, {
      env, stdio: ["ignore", "ignore", "pipe"],
    });
    const state: LoginState = { id, status: "pending", authUrl: null, account: null, error: null };
    const timer = setTimeout(() => child.kill("SIGTERM"), 10 * 60_000);
    const entry = { state, child, directory, timer, replace };
    this.pending.set(id, entry);
    let output = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      // The CLI reports a browser URL, never return its other output or credential details.
      output = (output + chunk.toString("utf8")).slice(-16_384);
      const match = output.match(/https:\/\/auth\.openai\.com\/[^\s]+/);
      if (match && !state.authUrl) {
        state.authUrl = match[0];
        this.onChange?.();
      }
    });
    child.once("error", () => {
      state.status = "failed";
      state.error = "Could not start the installed Codex login command";
    });
    child.once("close", (code) => { void this.finish(entry, code); });
    return state;
  }

  status(id: string): LoginState {
    const state = this.pending.get(id)?.state ?? this.results.get(id);
    if (!state) throw new Error("unknown Codex sign-in");
    return { ...state };
  }

  cancel(id: string): void {
    const entry = this.pending.get(id);
    if (!entry) throw new Error("no sign-in in progress");
    entry.state.status = "failed";
    entry.state.error = "Sign-in cancelled";
    entry.child.kill("SIGTERM");
  }

  async close(): Promise<void> {
    for (const entry of this.pending.values()) entry.child.kill("SIGTERM");
    const force = setTimeout(() => {
      for (const entry of this.pending.values()) entry.child.kill("SIGKILL");
    }, 2_000);
    try {
      while (this.pending.size) await new Promise((resolve) => setTimeout(resolve, 20));
    } finally { clearTimeout(force); }
  }

  private async finish(entry: Pending, code: number | null): Promise<void> {
    clearTimeout(entry.timer);
    const { state, directory } = entry;
    let completedAccount: string | null = null;
    let failure: string | null = null;
    try {
      if (state.status === "pending" && code === 0) {
        const auth = await readFile(join(directory, "auth.json"), "utf8");
        if (entry.replace) {
          this.store.replaceCredentials(entry.replace, auth);
          completedAccount = entry.replace;
        } else completedAccount = this.store.addAccount(auth).name;
      } else if (state.status === "pending") {
        failure = "Codex sign-in did not finish. Try again.";
      }
    } catch {
      failure = "Codex did not save usable credentials. Try signing in again.";
    } finally {
      state.authUrl = null;
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
