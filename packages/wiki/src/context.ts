import { statSync } from "node:fs";
import { CliError } from "./errors.js";
import { ensureGit } from "./git.js";
import { VaultIndex } from "./index.js";
import type { Environ } from "./paths.js";
import { ensureVault } from "./vault.js";

export interface Context {
  env: Environ;
  home: string;
  cwd: string;
  vaultRoot: string;
  /** Injected so command output is reproducible under test. */
  now: () => string;
  readStdin: () => Promise<string>;
  stdinIsTerminal: boolean;
}

export interface CommandResult {
  data: unknown;
  human: string;
  /** Present only where streaming is meaningful; --jsonl emits one per line. */
  records?: unknown[];
}

export type Handler = (
  context: Context,
  flags: import("./flags.ts").ParsedFlags,
) => CommandResult | Promise<CommandResult>;

/** Read commands never conjure a vault: an empty result and a missing vault
 * are different answers, and an agent has to be able to tell them apart. */
export function openIndex(context: Context, options: { create: boolean }): VaultIndex {
  if (options.create) {
    ensureVault(context.vaultRoot);
    // Only writes bring a vault under git. A read finding no repository has
    // nothing to record anyway, and must not create one behind the user.
    ensureGit(context.vaultRoot);
  } else assertVaultExists(context.vaultRoot);
  const index = VaultIndex.open(context.vaultRoot);
  index.reconcile();
  return index;
}

export function assertVaultExists(root: string): void {
  try {
    if (statSync(root).isDirectory()) return;
  } catch {
    // Fall through to the same error: absent and not-a-directory are equally
    // unusable, and the recovery is the same.
  }
  throw new CliError(
    "vault_not_found",
    `no vault at ${root}`,
    'Create one by capturing something: agentwiki new "First document"',
  );
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export async function readAllStdin(): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}
