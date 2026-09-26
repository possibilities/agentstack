import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join } from "node:path";

/** Resolve an executable from the current PATH without invoking a shell. */
export function findExecutable(name: string): string | null {
  if (name.includes("/")) return executableFile(name) ? name : null;
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, name);
    if (executableFile(candidate)) return candidate;
  }
  return null;
}

function executableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
