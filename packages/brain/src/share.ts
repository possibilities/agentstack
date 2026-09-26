import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { brainEnvironment, brainStateRoot } from "./paths.js";
import { dirname, join } from "node:path";
import { CliError } from "./errors.js";
import { normalizeTags } from "./text.js";
import { validateHttpUrl } from "./url.js";

export const SHARE_CONTRACT_VERSION = 1 as const;
export const SHARE_MAX_BODY_BYTES = 1_048_576;
const SHARE_MAX_TEXT_CHARS = 100_000;
const SHARE_MAX_TITLE_CHARS = 500;
export const SHARE_DEFAULT_COLLECTION = "saved-links";
export const SHARE_DEFAULT_PORT = 8877;
export const SHARE_DEFAULT_HOST = "127.0.0.1";
const SHARE_TOKEN_BYTES = 32;

/**
 * Clients this ingress recognizes. Unknown values are rejected so that
 * `ingress` stays a bounded enum in durable job intent rather than
 * free-form text supplied by a network peer.
 */
const SHARE_CLIENTS = ["chrome-extension", "android-share"] as const;
export type ShareClient = (typeof SHARE_CLIENTS)[number];

export type ShareResolvedKind = "url" | "text";

export interface ShareRequest {
  version: number;
  client: ShareClient;
  url?: string;
  text?: string;
  title?: string;
  tags: string[];
  collections: string[];
  idempotencyKey?: string;
}

export interface ResolvedShare {
  kind: ShareResolvedKind;
  source: string;
  ingress: ShareClient;
  title?: string;
  tags: string[];
  collections: string[];
  idempotencyKey?: string;
  /** True when a URL was recovered from a free-text share payload. */
  extractedFromText: boolean;
}

function shareError(
  code: string,
  message: string,
  recovery?: string,
): CliError {
  return new CliError(code, message, {
    exitCode: 2,
    ...(recovery ? { recovery } : {}),
  });
}

function asOptionalString(
  value: unknown,
  field: string,
  maxChars: number,
): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw shareError("bad_payload", `${field} must be a string`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.length > maxChars) {
    throw shareError(
      "bad_payload",
      `${field} exceeds ${maxChars} characters`,
      "Trim the shared payload before sending it.",
    );
  }
  return trimmed;
}

function asStringArray(value: unknown, field: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw shareError("bad_payload", `${field} must be an array of strings`);
  }
  if (value.length > 32) {
    throw shareError("bad_payload", `${field} accepts at most 32 entries`);
  }
  return value.map((entry) => {
    if (typeof entry !== "string") {
      throw shareError("bad_payload", `${field} must be an array of strings`);
    }
    return entry.trim();
  });
}

/**
 * Extracts the first http(s) URL from a free-text share payload.
 *
 * Android's ACTION_SEND and many apps deliver a link wrapped in surrounding
 * prose ("Look at this https://example.com/post — great read"), so the server
 * — not the client — owns recovery of the locator. Trailing punctuation that
 * commonly abuts a URL in prose is stripped, and unbalanced closing brackets
 * are trimmed so Markdown-ish payloads resolve correctly.
 */
export function extractFirstUrl(text: string): string | null {
  const matches = text.match(/https?:\/\/[^\s<>"']+/gi);
  if (matches === null) return null;
  for (const raw of matches) {
    let candidate = raw;
    while (candidate.length > 0) {
      const last = candidate.at(-1) as string;
      if (".,;:!?".includes(last)) {
        candidate = candidate.slice(0, -1);
        continue;
      }
      const opener = { ")": "(", "]": "[", "}": "{" }[last];
      // Strip a closer only when it is unmatched, so a genuinely parenthesized
      // path such as /wiki/Foo_(bar) survives intact.
      if (
        opener !== undefined &&
        candidate.split(last).length > candidate.split(opener).length
      ) {
        candidate = candidate.slice(0, -1);
        continue;
      }
      break;
    }
    try {
      validateHttpUrl(candidate);
      return candidate;
    } catch {
      // Keep scanning; a malformed first match must not mask a valid later one.
    }
  }
  return null;
}

function parseClient(value: unknown): ShareClient {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw shareError(
      "bad_payload",
      "client is required",
      `Use one of: ${SHARE_CLIENTS.join(", ")}.`,
    );
  }
  const client = value.trim();
  if (!(SHARE_CLIENTS as readonly string[]).includes(client)) {
    throw shareError(
      "bad_payload",
      `unknown client '${client}'`,
      `Use one of: ${SHARE_CLIENTS.join(", ")}.`,
    );
  }
  return client as ShareClient;
}

export function parseShareRequest(body: unknown): ShareRequest {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw shareError("bad_payload", "share payload must be a JSON object");
  }
  const raw = body as Record<string, unknown>;
  const version = raw.version ?? SHARE_CONTRACT_VERSION;
  if (version !== SHARE_CONTRACT_VERSION) {
    throw shareError(
      "unsupported_version",
      `unsupported share contract version ${String(version)}`,
      `This server speaks share contract version ${SHARE_CONTRACT_VERSION}.`,
    );
  }
  const idempotencyKey = asOptionalString(
    raw.idempotency_key,
    "idempotency_key",
    200,
  );
  return {
    version: SHARE_CONTRACT_VERSION,
    client: parseClient(raw.client),
    url: asOptionalString(raw.url, "url", 4_096),
    text: asOptionalString(raw.text, "text", SHARE_MAX_TEXT_CHARS),
    title: asOptionalString(raw.title, "title", SHARE_MAX_TITLE_CHARS),
    tags: asStringArray(raw.tags, "tags").flatMap((tag) => normalizeTags(tag)),
    collections: asStringArray(raw.collections, "collections").filter(
      (entry) => entry.length > 0,
    ),
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
  };
}

/**
 * Resolves a parsed share request into exactly one Admission intent.
 *
 * The server is the authoritative ingestion point: clients send what they
 * observed, and this function — not the Chrome extension or the Android
 * activity — decides whether the result is a URL job or a text job.
 */
export function resolveShare(request: ShareRequest): ResolvedShare {
  const collections =
    request.collections.length > 0
      ? request.collections
      : [SHARE_DEFAULT_COLLECTION];
  const common = {
    ingress: request.client,
    tags: request.tags,
    collections,
    ...(request.title === undefined ? {} : { title: request.title }),
    ...(request.idempotencyKey === undefined
      ? {}
      : { idempotencyKey: request.idempotencyKey }),
  };

  if (request.url !== undefined) {
    try {
      validateHttpUrl(request.url);
    } catch (error) {
      throw shareError(
        "bad_source",
        error instanceof Error ? error.message : String(error),
      );
    }
    return {
      ...common,
      kind: "url",
      source: request.url,
      extractedFromText: false,
    };
  }

  if (request.text !== undefined) {
    const extracted = extractFirstUrl(request.text);
    if (extracted !== null) {
      return {
        ...common,
        kind: "url",
        source: extracted,
        extractedFromText: true,
      };
    }
    return {
      ...common,
      kind: "text",
      source: request.text,
      extractedFromText: false,
    };
  }

  throw shareError(
    "bad_payload",
    "share payload requires url or text",
    'Send {"client":"...","url":"https://..."} or a text payload.',
  );
}

/**
 * How many share outcomes one status request may ask about. The client shows a
 * bounded history, so a larger request is a client bug or a probe, not a use.
 */
export const SHARE_MAX_STATE_IDS = 50;

/**
 * Parses `job_ids=1,2,3`. Ids are the client's own acknowledgements, so a
 * malformed list is refused rather than silently narrowed to what parsed.
 */
export function parseShareStateIds(raw: string | null): number[] {
  const trimmed = (raw ?? "").trim();
  if (trimmed === "") return [];
  const parts = trimmed.split(",").map((part) => part.trim());
  const ids: number[] = [];
  for (const part of parts) {
    if (!/^[0-9]{1,15}$/.test(part)) {
      throw shareError(
        "bad_payload",
        "job_ids must be a comma-separated list of job ids",
        "Send job_ids=1,2,3 using the ids returned by /v1/share.",
      );
    }
    const id = Number(part);
    if (id <= 0) {
      throw shareError(
        "bad_payload",
        "job_ids must be positive job ids",
        "Send job_ids=1,2,3 using the ids returned by /v1/share.",
      );
    }
    if (!ids.includes(id)) ids.push(id);
  }
  if (ids.length > SHARE_MAX_STATE_IDS) {
    throw shareError(
      "payload_too_large",
      `job_ids accepts at most ${SHARE_MAX_STATE_IDS} ids`,
      "Ask about the ids currently on screen.",
    );
  }
  return ids;
}

export function defaultShareTokenPath(home?: string): string { return join(brainStateRoot(brainEnvironment(), home), "share-token"); }

export function generateShareToken(): string {
  return randomBytes(SHARE_TOKEN_BYTES).toString("base64url");
}

/**
 * Writes a token with owner-only permissions, matching the private-state
 * rules in ADR 0012.
 */
export function writeShareToken(path: string, token: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${token}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

export function readShareToken(path: string): string {
  let contents: string;
  try {
    contents = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new CliError(
        "share_token_missing",
        `share token not found: ${path}`,
        { recovery: "Start the Brain Package API to initialize its private share token." },
      );
    }
    throw error;
  }
  const token = contents.trim();
  if (token.length < 16) {
    throw new CliError(
      "share_token_invalid",
      `share token in ${path} is too short to be usable`,
      { recovery: "Restore a valid private token file before starting the Brain Package API." },
    );
  }
  return token;
}

/** Compares two tokens without leaking length or content through timing. */
export function tokenMatches(expected: string, presented: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(presented, "utf8");
  if (a.length !== b.length) {
    // Still perform a comparison so rejection cost does not depend on length.
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}

export function bearerToken(headerValue: string | null): string | null {
  if (headerValue === null) return null;
  const match = headerValue.match(/^Bearer\s+(\S+)$/i);
  return match?.[1] ?? null;
}

/**
 * Resolves the token a server will require. The environment override exists
 * for supervised/service contexts that inject a secret without a file; the
 * file remains the default so ADR 0012 permission rules apply. `doctor` reads
 * it the same way so its probe presents whatever the running ingress expects.
 */
export function resolveShareServerToken(path: string): {
  token: string;
  source: string;
} {
  return { token: readShareToken(path), source: path };
}
