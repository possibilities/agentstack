import { mkdir, chmod, lstat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

export interface RuntimePaths {
  runtimeRoot: string;
  controlSocket: string;
  configRoot: string;
  stateRoot: string;
  codexHome: string;
}

function xdg(name: "CONFIG" | "STATE", fallback: string): string {
  return process.env[`XDG_${name}_HOME`] ?? join(homedir(), fallback);
}

export function resolveRuntimePaths(): RuntimePaths {
  const runtimeBase =
    process.env.XDG_RUNTIME_DIR ??
    join(tmpdir(), `agentstack-${process.getuid?.() ?? "dev"}`);
  const runtimeRoot = resolve(runtimeBase, "agentstack");
  const stateRoot = resolve(xdg("STATE", ".local/state"), "agentstack");
  return {
    runtimeRoot,
    controlSocket: join(runtimeRoot, "control.sock"),
    configRoot: resolve(xdg("CONFIG", ".config"), "agentstack"),
    stateRoot,
    codexHome: join(stateRoot, "engines", "codex"),
  };
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  try {
    const existing = await lstat(path);
    if (existing.isSymbolicLink() || !existing.isDirectory()) {
      throw new Error(`unsafe directory: ${path}`);
    }
    if (
      typeof existing.uid === "number" &&
      existing.uid !== process.getuid?.()
    ) {
      throw new Error(`foreign-owned directory: ${path}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(path, { recursive: true, mode: 0o700 });
  }
  await chmod(path, 0o700);
}

export async function ensureRuntimePaths(paths: RuntimePaths): Promise<void> {
  await ensurePrivateDirectory(paths.runtimeRoot);
  await ensurePrivateDirectory(paths.stateRoot);
  await ensurePrivateDirectory(join(paths.stateRoot, "engines"));
  await ensurePrivateDirectory(paths.codexHome);
}
