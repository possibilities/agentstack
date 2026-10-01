import { execFile } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { accountEnvironment, accountRoot, type WorkerAccount } from "@stack/auth";
import { snapshotStateFiles, stateHash } from "@stack/api";
import type { WorkerRecord } from "./ledger.js";

const sandbox = '(version 1) (allow default) (deny network-outbound (require-not (remote ip "localhost:*"))) (deny process-exec (literal "/usr/bin/open"))';
async function privatePath(root: string, path: string) {
  if (!path.startsWith(`${root}/`)) throw new Error("Native path escaped exact account profile");
  for (let current = path; current.length >= root.length; current = dirname(current)) {
    const info = await lstat(current);
    if (info.isSymbolicLink() || info.uid !== process.getuid?.() || (!info.isFile() && !info.isDirectory())) throw new Error("Native profile has unsafe ownership/path");
    if (current === root) break;
  }
}
async function native(root: string, worker: WorkerRecord, source: NodeJS.ProcessEnv, args: string[], claude = false) {
  if (process.platform !== "darwin") throw new Error("Offline native-session guard is not available on this host");
  const account: WorkerAccount = { id: worker.accountId, provider: worker.provider, enabled: false, ready: true, removing: false };
  const env = accountEnvironment(root, account, source);
  // Devin's ordinary runtime intentionally keeps HOME. Maintenance is narrower:
  // isolate HOME too and prohibit external egress/browser activation.
  env.HOME = accountRoot(root, account.id);
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  for (const key of Object.keys(env)) if (/^(OPENCODE_|DEVIN_|CLAUDE_)/.test(key) && !["OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR", "CLAUDE_CONFIG_DIR"].includes(key)) delete env[key];
  const home = source.HOME ?? homedir();
  const binary = claude ? process.execPath : worker.provider === "codex" ? source.STACK_OPENCODE_BIN ?? join(home, ".local", "bin", "opencode") : source.STACK_DEVIN_BIN ?? join(home, ".local", "share", "devin", "cli", "_versions", "current", "bin", "devin");
  return (await promisify(execFile)("/usr/bin/sandbox-exec", ["-p", sandbox, binary, ...args], { env, cwd: worker.provider === "devin" ? worker.cwd! : accountRoot(root, account.id), timeout: 30_000, maxBuffer: 2_000_000 })).stdout.trim();
}
const quote = (id: string) => `"${id.replaceAll('"', '""')}"`;
type Store = { nativeIds: string[]; selected: string; siblings: string; credentials: string; blockedBy: string[] };
async function sqliteStore(root: string, worker: WorkerRecord): Promise<Store> {
  const profile = accountRoot(root, worker.accountId), codex = worker.provider === "codex";
  const path = codex ? join(profile, "data", "opencode", "opencode.db") : join(profile, "data", "devin", "cli", "sessions.db");
  await privatePath(profile, path);
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout=5000; BEGIN");
    const sessionsTable = codex ? "session_v2" : "sessions";
    const sessions = db.prepare(`SELECT * FROM ${sessionsTable} ORDER BY id LIMIT 20001`).all();
    if (sessions.length > 20000) throw new Error("Native session inventory exceeds bounded scope verification");
    const exact = sessions.find(row => row.id === worker.sessionId);
    const ids = new Set<string>(exact ? [worker.sessionId!] : []);
    if (codex && exact) {
      for (let i = 0; i < 100; i++) { const size = ids.size; for (const row of sessions) if (ids.has(String(row.parent_id))) ids.add(String(row.id)); if (size === ids.size) break; }
      if (ids.size > 100 || sessions.some(row => ids.has(String(row.parent_id)) && !ids.has(String(row.id)))) throw new Error("Native descendant scope exceeds 100 sessions");
    }
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[];
    const selected: unknown[] = [], siblings: unknown[] = [];
    for (const { name } of tables) {
      const columns = db.prepare(`PRAGMA table_info(${quote(name)})`).all();
      if (name !== sessionsTable && !columns.some(row => row.name === "session_id")) continue;
      const field = name === sessionsTable ? "id" : "session_id";
      const rows = db.prepare(`SELECT * FROM ${quote(name)} ORDER BY rowid LIMIT 20001`).all();
      if (rows.length > 20000 || JSON.stringify(rows).length > 8_000_000) throw new Error("Native transcript verification exceeds bounded scope");
      selected.push([name, rows.filter(row => ids.has(String(row[field])))]);
      siblings.push([name, rows.filter(row => !ids.has(String(row[field])))]);
    }
    const credentialPath = join(profile, "data", "devin", "credentials.toml");
    if (!codex) await privatePath(profile, credentialPath).catch(error => { if (error.code !== "ENOENT") throw error; });
    const credentials = codex ? stateHash(db.prepare("SELECT * FROM credential ORDER BY id").all()) : stateHash(await readFile(credentialPath).catch(error => { if (error.code === "ENOENT") return Buffer.alloc(0); throw error; }));
    return { nativeIds: [...ids].sort(), selected: stateHash(selected), siblings: stateHash(siblings), credentials,
      blockedBy: [...(!exact ? ["Exact native session is absent; no purge is admitted"] : []),
        ...(exact && exact[codex ? "directory" : "working_directory"] !== worker.cwd ? ["Native session directory does not match Worker claim"] : []),
        ...(codex && [...ids].some(id => { const row = sessions.find(row => row.id === id)!; return row.time_compacting !== null || row.time_suspended !== null; }) ? ["Native compaction/suspended session remains unresolved"] : [])] };
  } finally { db.close(); }
}
async function claudeStore(root: string, worker: WorkerRecord): Promise<Store> {
  const profile = accountRoot(root, worker.accountId), projects = join(profile, "claude", "projects");
  await privatePath(profile, projects);
  const files = await snapshotStateFiles(projects, { all: true });
  if (files.entries.some(row => row.type !== "file" && row.type !== "directory")) throw new Error("Native Claude projects have unsafe symlink/special entries");
  const project = worker.cwd!.replace(/[^a-zA-Z0-9]/g, "-");
  const exact = `${project}/${worker.sessionId}.jsonl`, descendant = `${project}/${worker.sessionId}/`;
  if (files.entries.some(row => row.path.endsWith(`/${worker.sessionId}.jsonl`) && row.path !== exact)) throw new Error("Native Claude session ID is duplicated in another project; SDK search scope is ambiguous");
  const selected = files.entries.filter(row => row.path === exact || row.path === descendant.slice(0, -1) || row.path.startsWith(descendant));
  const others = files.entries.filter(row => row.type === "file" && !selected.includes(row));
  return { nativeIds: selected.some(row => row.path === exact && row.bytes > 0) ? [worker.sessionId!] : [],
    selected: stateHash(selected), siblings: stateHash(others), credentials: "isolated-keychain-not-selected",
    blockedBy: selected.some(row => row.path === exact && row.bytes > 0) ? [] : ["Exact Claude transcript is absent/empty or native project-key encoding is unsupported"] };
}
export async function observeNativeSession(root: string, worker: WorkerRecord, env: NodeJS.ProcessEnv) {
  if (!worker.cwd || !worker.sessionId || worker.phase !== "closed") throw new Error("Native purge requires a closed Worker with exact native session/cwd");
  if (worker.provider === "claude" ? !/^[0-9a-f-]{36}$/i.test(worker.sessionId) : worker.provider === "codex" ? !/^ses_[A-Za-z0-9]+$/.test(worker.sessionId) : !/^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/.test(worker.sessionId)) throw new Error("Native session identity is malformed");
  for (const path of [root, join(root, "worker-accounts"), accountRoot(root, worker.accountId)]) if (await realpath(path) !== path || (await lstat(path)).isSymbolicLink()) throw new Error("Native account root is not a definite private path");
  await privatePath(accountRoot(root, worker.accountId), join(accountRoot(root, worker.accountId), worker.provider === "claude" ? "claude" : worker.provider === "codex" ? ".config/opencode/opencode.json" : "config/devin/config.json"));
  if (worker.provider === "codex") {
    const config = JSON.parse(await readFile(join(accountRoot(root, worker.accountId), ".config", "opencode", "opencode.json"), "utf8")) as Record<string, unknown>;
    if (Object.keys(config).some(key => !["$schema", "update", "experimental"].includes(key)) || config.update !== "disable"
      || (config.experimental && (typeof config.experimental !== "object" || Object.keys(config.experimental).some(key => key !== "policies")))) throw new Error("Native OpenCode configuration has unverified extensions; maintenance refuses to launch them");
  }
  const version = worker.provider === "claude" ? "0.3.283" : await native(root, worker, env, ["--version"]);
  if ((worker.provider === "codex" && !/^(?:opencode v)?2\.0\.16$/.test(version)) || (worker.provider === "devin" && !/^devin 3000\.11\.3(?: \([a-f0-9]+\))?$/.test(version))) throw new Error("Native session purge version has not been scope-verified");
  const store = await (worker.provider === "claude" ? claudeStore(root, worker) : sqliteStore(root, worker));
  return { ...store, revision: stateHash([worker, version, store]) };
}
export async function purgeNativeSession(root: string, worker: WorkerRecord, env: NodeJS.ProcessEnv, expectedRevision: string) {
  const before = await observeNativeSession(root, worker, env);
  if (before.revision !== expectedRevision || before.blockedBy.length) throw new Error("Native session changed or blocked");
  if (worker.provider === "claude") {
    // Compiled src lives at dist/src: module resolution, not path guessing,
    // selects the package's pinned SDK in this private subprocess.
    const resolved = import.meta.resolve("@anthropic-ai/claude-agent-sdk");
    await native(root, worker, env, ["--input-type=module", "-e", `const {deleteSession}=await import(${JSON.stringify(resolved)}); await deleteSession(${JSON.stringify(worker.sessionId)},{dir:${JSON.stringify(worker.cwd)}});`], true);
  } else await native(root, worker, env, worker.provider === "codex" ? ["session", "delete", worker.sessionId!, "--standalone"] : ["rm", worker.sessionId!, "--force"]);
  const after = await (worker.provider === "claude" ? claudeStore(root, worker) : sqliteStore(root, worker));
  if (after.nativeIds.length || after.credentials !== before.credentials || after.siblings !== before.siblings) throw new Error("Native absence/sibling/credential preservation could not be verified");
  return before.nativeIds;
}
