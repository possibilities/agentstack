import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

export function workspaceRoot(from: string): string {
  let dir = from;
  while (dirname(dir) !== dir) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    dir = dirname(dir);
  }
  throw new Error("workspace root not found");
}
