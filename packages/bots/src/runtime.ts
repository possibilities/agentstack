import { access, readFile, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join } from "node:path";
import { codexRuntimePath } from "./paths.js";

// Report the installed release, not the setup pin or Codex's unbranded
// `codex-cli 0.0.0` version. Do not launch a subprocess to render the UI.
export async function installedRuntimeVersion(): Promise<string | null> {
  try {
    const binary = await realpath(codexRuntimePath());
    await access(binary, constants.X_OK);
    const receipt: unknown = JSON.parse(await readFile(join(dirname(binary), "receipt.json"), "utf8"));
    if (!receipt || typeof receipt !== "object") return null;
    const fields = receipt as Record<string, unknown>;
    if (fields.owner !== "codexnk-release-v1" || fields.repository !== "possibilities/codexnk-codex") return null;
    if (typeof fields.commit !== "string" || !/^[0-9a-f]{40}$/.test(fields.commit)) return null;
    if (typeof fields.tag !== "string" || !/^codexnk-v\d+\.\d+\.\d+$/.test(fields.tag)) return null;
    return fields.tag.slice("codexnk-".length);
  } catch {
    return null;
  }
}
