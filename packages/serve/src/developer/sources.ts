import { z } from "zod";
import { harnessReleaseMaxBytes, harnessReleaseTimeoutMs, releaseVersion, type HarnessId, type HarnessReleaseError } from "./schema.js";

export const releaseSources = [
  { id: "opencode", title: "OpenCode", sourceUrl: "https://registry.npmjs.org/@opencode/cli/latest", packageName: "@opencode/cli", channel: "npm-latest" },
  { id: "codex", title: "Codex", sourceUrl: "https://registry.npmjs.org/@openai/codex/latest", packageName: "@openai/codex", channel: "npm-latest" },
  { id: "claude", title: "Claude Code", sourceUrl: "https://registry.npmjs.org/@anthropic-ai/claude-code/latest", packageName: "@anthropic-ai/claude-code", channel: "npm-latest" },
  { id: "devin", title: "Devin CLI", sourceUrl: "https://static.devin.ai/cli/current/manifest.json", packageName: null, channel: "devin-current" },
] as const satisfies ReadonlyArray<{ id: HarnessId; title: string; sourceUrl: string; packageName: string | null; channel: "npm-latest" | "devin-current" }>;

const messages: Record<HarnessReleaseError["code"], string> = {
  timeout: "The release channel did not finish within the check deadline.",
  network_error: "The public release channel could not be reached.",
  http_error: "The public release channel returned an unsuccessful HTTP status.",
  rate_limited: "The public release channel rate-limited the check. Retry later or wait for the next scheduled check.",
  response_too_large: "The release response exceeded the bounded size limit.",
  invalid_response: "The release response was not valid JSON with the expected identity and release version.",
  interrupted: "The check was interrupted by disable, shutdown or restart; any last good release is retained.",
  cache_read_failed: "The retained release cache could not be read or validated. No cached release is asserted.",
  cache_write_failed: "The release cache could not be saved. In-memory results may not survive restart.",
};
export function releaseProblem(code: HarnessReleaseError["code"]): HarnessReleaseError { return { code, message: messages[code] }; }
class ReleaseFailure extends Error {
  constructor(readonly code: HarnessReleaseError["code"]) { super(code); }
}

/** Fixed public channels only; redirects, credentials, retries and arbitrary URLs are never used. */
export async function observeRelease(source: typeof releaseSources[number], signal: AbortSignal): Promise<{ version: string; error: null } | { version: null; error: HarnessReleaseError }> {
  const deadline = new AbortController();
  const timeout = setTimeout(() => deadline.abort(), harnessReleaseTimeoutMs);
  const combined = AbortSignal.any([signal, deadline.signal]);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    combined.throwIfAborted();
    const response = await fetch(source.sourceUrl, { signal: combined, redirect: "error", credentials: "omit", cache: "no-store", headers: { accept: "application/json" } });
    reader = response.body?.getReader();
    if (!response.ok) throw new ReleaseFailure(response.status === 429 ? "rate_limited" : "http_error");
    if (Number(response.headers.get("content-length")) > harnessReleaseMaxBytes) throw new ReleaseFailure("response_too_large");
    if (!/^application\/(?:[\w.-]+\+)?json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "") || !reader) throw new ReleaseFailure("invalid_response");
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      combined.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > harnessReleaseMaxBytes) throw new ReleaseFailure("response_too_large");
      chunks.push(value);
    }
    let payload: unknown;
    try { payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
    catch { throw new ReleaseFailure("invalid_response"); }
    const parsed = source.packageName
      ? z.object({ name: z.literal(source.packageName), version: releaseVersion }).safeParse(payload)
      : z.object({ version: releaseVersion, platforms: z.record(z.string(), z.unknown()).refine(value => Object.keys(value).length > 0) }).safeParse(payload);
    if (!parsed.success) throw new ReleaseFailure("invalid_response");
    return { version: parsed.data.version, error: null };
  } catch (error) {
    return { version: null, error: releaseProblem(signal.aborted ? "interrupted" : deadline.signal.aborted ? "timeout" : error instanceof ReleaseFailure ? error.code : "network_error") };
  } finally {
    clearTimeout(timeout);
    // Cancels oversized/failed bodies as well as releasing successful ones.
    try { await reader?.cancel(); } catch { /* Abort may already have closed the body. */ }
    reader?.releaseLock();
  }
}
