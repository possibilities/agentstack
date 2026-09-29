import { access, readdir, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

async function exists(path: string, executable = false): Promise<boolean> {
  try { await access(path, executable ? constants.X_OK : constants.R_OK); return (await stat(path)).isFile(); }
  catch { return false; }
}

/** Which runtime candidate supplied the tools; a label, never a path. */
export type CodexRuntimeSource = "override" | "standalone" | "chatgpt-app" | "codex-app";
export class CodexInstallationError extends Error {
  constructor(readonly code: "runtime_missing" | "config_invalid" | "browser_module_missing", message: string) { super(message); }
}

/** The desktop installation is a tool provider, not a Bot/Worker inference account. */
export async function codexInstallation(env: NodeJS.ProcessEnv): Promise<{ home: string; binary: string; source: CodexRuntimeSource }> {
  const home = env.STACK_CODEX_TOOLS_HOME ?? join(homedir(), ".codex");
  if (!isAbsolute(home)) throw new CodexInstallationError("config_invalid", "STACK_CODEX_TOOLS_HOME must be absolute");
  const override = env.STACK_CODEX_TOOLS_BIN;
  if (override && !isAbsolute(override)) throw new CodexInstallationError("config_invalid", "STACK_CODEX_TOOLS_BIN must be absolute");
  const candidates: Array<[string, CodexRuntimeSource]> = override ? [[override, "override"]] : [
    [join(home, "packages", "standalone", "current", "bin", "codex"), "standalone"],
    ["/Applications/ChatGPT.app/Contents/Resources/codex", "chatgpt-app"],
    ["/Applications/Codex.app/Contents/Resources/codex", "codex-app"],
  ];
  for (const [binary, source] of candidates) if (await exists(binary, true)) return { home, binary, source };
  throw new CodexInstallationError("runtime_missing", "Codex tools runtime unavailable. Install the Codex/ChatGPT desktop app or set STACK_CODEX_TOOLS_BIN and STACK_CODEX_TOOLS_HOME on the Stack server.");
}

export async function browserModule(home: string): Promise<string> {
  for (const plugin of ["chrome", "browser"]) {
    const root = join(home, "plugins", "cache", "openai-bundled", plugin);
    const versions = await readdir(root).catch(() => [] as string[]);
    for (const version of ["latest", ...versions.filter((v) => v !== "latest").sort((a, b) => b.localeCompare(a, "en", { numeric: true }))]) {
      const module = join(root, version, "scripts", "browser-client.mjs");
      if (await exists(module)) return module;
    }
  }
  throw new CodexInstallationError("browser_module_missing", "Chrome runtime unavailable. Enable the browser/Chrome plugin and install the ChatGPT Chrome extension in the desktop app.");
}
