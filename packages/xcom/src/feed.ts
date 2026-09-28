import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Post } from "./store.js";

const execute = promisify(execFile);

export class FeedError extends Error {
  constructor(message: string, readonly transient = false, readonly code: string | null = null) { super(message); }
}

async function request(binary: string, args: string[], signal: AbortSignal): Promise<unknown> {
  let stdout: string;
  try {
    ({ stdout } = await execute(binary, args, { signal, timeout: 120_000, maxBuffer: 12_000_000 }));
  } catch (error) {
    if (signal.aborted) throw error;
    const failure = error as Error & { stdout?: string; code?: string | number; killed?: boolean };
    let payload: unknown;
    try { payload = JSON.parse(failure.stdout ?? ""); } catch { /* CLI may not have emitted JSON */ }
    const detail = payload && typeof payload === "object" && "error" in payload ? payload.error : null;
    const code = detail && typeof detail === "object" && "code" in detail ? String(detail.code) : null;
    const message = detail && typeof detail === "object" && "message" in detail ? String(detail.message) : "";
    const transient = failure.killed === true || failure.code === "ETIMEDOUT" ||
      (code === "api_error" && (/deadlineexceeded/i.test(message) || /\bHTTP (?:0|502|503|504)\b/i.test(message)));
    throw new FeedError(`twitter CLI failed: ${[code, message].filter(Boolean).join(": ").slice(0, 300) || String(failure.code ?? failure.message).slice(0, 300)}`, transient, code);
  }
  try { return JSON.parse(stdout); }
  catch { throw new FeedError("twitter CLI did not return valid JSON"); }
}

export type FeedPage = { posts: Post[]; nextCursor: string | null };
export async function fetchPage(binary: string, cursor: string | null, signal: AbortSignal): Promise<FeedPage> {
  const args = ["feed", "--type", "following", "--max", "40", "--json"];
  if (cursor) args.push("--cursor", cursor);
  const payload = await request(binary, args, signal);
  if (!payload || typeof payload !== "object" || !("ok" in payload) || payload.ok !== true ||
      !("data" in payload) || !Array.isArray(payload.data)) throw new FeedError("twitter CLI returned an unexpected feed response");
  const posts: Post[] = payload.data;
  if (posts.some(post => !post || typeof post !== "object" || typeof post.id !== "string" || !post.id))
    throw new FeedError("feed contained a post without a string ID");
  const pagination = "pagination" in payload ? payload.pagination : null;
  if (pagination !== null && (typeof pagination !== "object" || Array.isArray(pagination)))
    throw new FeedError("feed returned invalid pagination");
  const cursorValue = pagination && "nextCursor" in pagination ? pagination.nextCursor : null;
  if (cursorValue !== null && (typeof cursorValue !== "string" || !cursorValue)) throw new FeedError("feed returned an invalid cursor");
  return { posts, nextCursor: cursorValue };
}

export async function fetchArticle(binary: string, id: string, signal: AbortSignal): Promise<Post> {
  const payload = await request(binary, ["article", id, "--json"], signal);
  if (!payload || typeof payload !== "object" || !("ok" in payload) || payload.ok !== true ||
      !("data" in payload) || !payload.data || typeof payload.data !== "object")
    throw new FeedError("twitter CLI returned an unexpected article response");
  return payload.data as Post;
}
