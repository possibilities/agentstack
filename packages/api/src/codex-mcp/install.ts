import { access, readdir, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

async function exists(path: string, executable = false): Promise<boolean> {
  try { await access(path, executable ? constants.X_OK : constants.R_OK); return (await stat(path)).isFile(); }
  catch { return false; }
}

/** The desktop installation is a tool provider, not a Bot/Worker inference account. */
export async function codexInstallation(env: NodeJS.ProcessEnv): Promise<{ home: string; binary: string }> {
  const home = env.STACK_CODEX_TOOLS_HOME ?? join(homedir(), ".codex");
  if (!isAbsolute(home)) throw new Error("STACK_CODEX_TOOLS_HOME must be absolute");
  const override = env.STACK_CODEX_TOOLS_BIN;
  if (override && !isAbsolute(override)) throw new Error("STACK_CODEX_TOOLS_BIN must be absolute");
  const candidates = override ? [override] : [
    join(home, "packages", "standalone", "current", "bin", "codex"),
    "/Applications/ChatGPT.app/Contents/Resources/codex",
    "/Applications/Codex.app/Contents/Resources/codex",
  ];
  for (const binary of candidates) if (await exists(binary, true)) return { home, binary };
  throw new Error("Codex tools runtime unavailable. Install the Codex/ChatGPT desktop app or set STACK_CODEX_TOOLS_BIN and STACK_CODEX_TOOLS_HOME on the Stack server.");
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
  throw new Error("Chrome runtime unavailable. Enable the browser/Chrome plugin and install the ChatGPT Chrome extension in the desktop app.");
}
