// Trusted parent configuration only. Never import into a browser component.
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { releaseSchema } from "@stack/client/contract";

export function parseTrustedRelease(text) {
  try { return Object.freeze(releaseSchema.parse(JSON.parse(text))); }
  catch { throw new Error("client_release_manifest_invalid"); }
}

export async function loadTrustedRelease(path) {
  if (!path) return null;
  if (!isAbsolute(path)) throw new Error("client_release_manifest_absolute_path_required");
  let file;
  try {
    file = await open(path, "r");
    const info = await file.stat();
    if (!info.isFile() || info.size > 4096) throw new Error();
    const bytes = Buffer.alloc(4097);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead > 4096) throw new Error();
    return parseTrustedRelease(bytes.subarray(0, bytesRead).toString("utf8"));
  } catch { throw new Error("client_release_manifest_invalid"); }
  finally { await file?.close(); }
}
