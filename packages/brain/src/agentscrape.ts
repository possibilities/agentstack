import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { findExecutable } from "./executable.js";
import { brainSignal } from "./paths.js";
import { sanitizeExternalError } from "./sanitize.js";
import { codePointLength } from "./text.js";
import type {
  ExtractionEnvelope,
  ExtractionFailureClass,
  ExtractionFailureDetail,
  ExtractionMetadata,
  ExtractionRelation,
  ExtractionSuccess,
  ExtractorIdentity,
  FailureClass,
} from "./types.js";
import { normalizedWebUrl, validateHttpUrl, xStatusId } from "./url.js";

const AGENTSCRAPE_DEFAULT_TIMEOUT_MS = 120_000;
const AGENTSCRAPE_OUTPUT_MAX_BYTES = 20_000_000;
export const AGENTSCRAPE_DEFAULT_MARKDOWN_MAX_BYTES = 5_000_000;
const AGENTSCRAPE_DEFAULT_MARKDOWN_MAX_CODE_POINTS = 5_000_000;
const AGENTSCRAPE_RETRY_INITIAL_MS = 1_000;
const AGENTSCRAPE_RETRY_MAX_MS = 30_000;
const AGENTSCRAPE_RETRY_ENV_MIN_MS = 100;
const AGENTSCRAPE_RETRY_CONFIG_MAX_MS = 3_600_000;
const AGENTSCRAPE_TIMEOUT_MAX_MS = 600_000;
const AGENTSCRAPE_TERMINATION_GRACE_MS = 250;
const AGENTSCRAPE_EXTRACTION_SCHEMA_VERSION = "1" as const;
// A link list is a normal page, not a pathological one: two awesome-list
// submissions were rejected permanently at 257 relations against a limit of
// 256. The limit exists to bound one envelope, not to judge how many links a
// page may legitimately have, so it sits well above real link lists.
const AGENTSCRAPE_DEFAULT_MAX_RELATIONS = 2048;

export interface ScrapedLink {
  success: true;
  url: string;
  requested_url: string;
  markdown: string;
  content: string;
  size_chars: number;
}

export interface AgentscrapeRetryOptions {
  /** Total attempts, including the first. Undefined means no limit. */
  maxAttempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  sleep?: (delayMs: number) => void | Promise<void>;
  writeDiagnostic?: (message: string) => void;
}

export interface ScrapeOptions {
  timeoutMs?: number;
  maxMarkdownBytes?: number;
  maxMarkdownCodePoints?: number;
  maxOutputBytes?: number;
  /** Retry controls are primarily dependency-injection seams for offline tests. */
  retry?: AgentscrapeRetryOptions;
}

export type ScrapeProvider = (
  url: string,
  options?: ScrapeOptions,
) => ScrapedLink | Promise<ScrapedLink>;

export interface ExtractionOptions {
  timeoutMs?: number;
  maxContentBytes?: number;
  maxOutputBytes?: number;
  maxRelations?: number;
  signal?: AbortSignal;
}

export type ExtractionProvider = (
  url: string,
  options?: ExtractionOptions,
) => ExtractionSuccess | Promise<ExtractionSuccess>;

export interface DiscoveryWarning {
  code: string;
  message: string;
  page_url?: string | null;
}

export interface FeedDiscoveryItem {
  stable_id: string;
  upstream_id: string | null;
  identity_source: "upstream_id" | "canonical_url" | "hashed_upstream_id";
  url: string | null;
  candidate_urls: string[];
  title: string;
  published_at: string | null;
  updated_at: string | null;
  tombstone: boolean;
}

export interface FeedDiscoveryEnvelope {
  schema_version: "1";
  status: "success" | "partial" | "failure";
  source_url: string;
  source_format: "rss" | "atom" | "archive" | "mixed" | "unknown";
  validators: { etag: string | null; last_modified: string | null };
  cursor: {
    validators: { etag: string | null; last_modified: string | null };
    newest_seen_at: string | null;
    next_url: string | null;
  };
  items: FeedDiscoveryItem[];
  pagination: {
    pages: Array<{
      url: string;
      page_format: "rss" | "atom" | "archive";
      validators: { etag: string | null; last_modified: string | null };
      item_count: number;
      next_url: string | null;
    }>;
    complete: boolean;
    stop_reason:
      | "exhausted"
      | "failed"
      | "page_limit"
      | "item_limit"
      | "loop"
      | "missing_page"
      | "response_limit"
      | "timeout"
      | "cancelled"
      | "malformed_page"
      | "not_modified"
      | "transport_failure"
      | "network_error"
      | "policy"
      | "authentication"
      | "http_error"
      | "redirect_error"
      | "redirect_limit"
      | "unsupported_encoding"
      | "malformed_response"
      | "feed_discovery"
      | "unsupported_source";
    next_url: string | null;
  };
  warnings: DiscoveryWarning[];
  absence_implies_deletion: false;
  failure: {
    code: string;
    retryable: boolean;
    message: string;
  } | null;
}

export interface XTimelineItem {
  id: string;
  url: string;
  text: string;
  created_at: string;
  is_reply: boolean;
  is_repost: boolean;
  is_quote: boolean;
  is_pinned: boolean;
  article_urls: string[];
}

export interface XTimelineDiscoveryEnvelope {
  handle: string;
  /** Diagnostic oldest item only; never a seekable historical cursor. */
  next_cursor: string | null;
  scraped_at: string;
  tweets: XTimelineItem[];
  warnings: DiscoveryWarning[];
}

export interface FeedDiscoveryRequest {
  sourceUrl: string;
  sourceKind?: "auto" | "feed" | "archive";
  /** Optional offline response fixture; omitted for live Agentscrape-owned transport. */
  recordedInputFile?: string;
  /** Prior committed validators for conditional Agentscrape-owned transport. */
  validators?: { etag: string | null; lastModified: string | null };
  /** Exact effective feed URL to which those validators are bound. */
  validatorUrl?: string;
  /** Validators attached to an offline recorded response fixture. */
  recordedValidators?: { etag?: string; lastModified?: string };
  since?: string;
  maxResponseBytes?: number;
  maxPages: number;
  maxItems: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface XTimelineDiscoveryRequest {
  url: string;
  handle: string;
  sinceId?: string;
  limit: number;
  maxScrolls: number;
  includeReplies?: boolean;
  includeReposts?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface SourceDiscoveryProvider {
  discoverFeed(
    request: FeedDiscoveryRequest,
  ): FeedDiscoveryEnvelope | Promise<FeedDiscoveryEnvelope>;
  discoverXTimeline(
    request: XTimelineDiscoveryRequest,
  ): XTimelineDiscoveryEnvelope | Promise<XTimelineDiscoveryEnvelope>;
}

export type DiscoveryDisposition = FailureClass | "cancelled";

export class AgentscrapeDiscoveryError extends Error {
  constructor(
    message: string,
    readonly disposition: DiscoveryDisposition,
    readonly outcome:
      | "infrastructure"
      | "rate_limit"
      | "auth_config"
      | "permanent"
      | "cancellation"
      | "protocol",
  ) {
    super(message);
    this.name = "AgentscrapeDiscoveryError";
  }
}

export type ExtractionDisposition = FailureClass | "cancelled";

export class AgentscrapeExtractionError extends Error {
  constructor(
    message: string,
    readonly disposition: ExtractionDisposition,
    readonly outcome:
      | "infrastructure"
      | "item"
      | "auth_config"
      | "permanent"
      | "policy"
      | "cancellation"
      | "protocol",
  ) {
    super(message);
    this.name = "AgentscrapeExtractionError";
  }
}

type CancellationSignal = "SIGHUP" | "SIGINT" | "SIGTERM";

type ProviderTerminator = () => void | Promise<void>;

const activeProviderTerminators = new Set<ProviderTerminator>();
let parentCancellationStarted = false;
const CANCELLATION_EXIT_CODES: Record<CancellationSignal, number> = {
  SIGHUP: 129,
  SIGINT: 130,
  SIGTERM: 143,
};

async function exitForCancellation(signal: CancellationSignal): Promise<void> {
  if (parentCancellationStarted) return;
  parentCancellationStarted = true;
  await Promise.allSettled(
    [...activeProviderTerminators].map(async (terminate) => terminate()),
  );
  process.exit(CANCELLATION_EXIT_CODES[signal]);
}

const cancellationHandlers: Record<CancellationSignal, () => void> = {
  SIGHUP: () => {
    void exitForCancellation("SIGHUP");
  },
  SIGINT: () => {
    void exitForCancellation("SIGINT");
  },
  SIGTERM: () => {
    void exitForCancellation("SIGTERM");
  },
};

function registerProviderTerminator(terminate: ProviderTerminator): () => void {
  if (activeProviderTerminators.size === 0) {
    for (const signal of Object.keys(
      cancellationHandlers,
    ) as CancellationSignal[]) {
      process.once(signal, cancellationHandlers[signal]);
    }
  }
  activeProviderTerminators.add(terminate);
  return () => {
    activeProviderTerminators.delete(terminate);
    if (activeProviderTerminators.size === 0) {
      for (const signal of Object.keys(
        cancellationHandlers,
      ) as CancellationSignal[]) {
        process.removeListener(signal, cancellationHandlers[signal]);
      }
    }
  };
}

interface CommandResult {
  stdout: string;
  stderr: string;
  status: number | null;
  signal: NodeJS.Signals | null;
  spawnError?: unknown;
  timedOut: boolean;
  outputExceeded: boolean;
  aborted: boolean;
}

class AttemptFailure extends Error {
  constructor(
    message: string,
    readonly transient: boolean,
  ) {
    super(message);
    this.name = "AttemptFailure";
  }
}

function positiveInteger(
  value: number,
  name: string,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be a positive safe integer <= ${maximum}`);
  }
  return value;
}

function nonnegativeInteger(
  value: number,
  name: string,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new Error(
      `${name} must be a non-negative safe integer <= ${maximum}`,
    );
  }
  return value;
}

function markdownLimits(options: ScrapeOptions): {
  bytes: number;
  codePoints: number;
} {
  return {
    bytes: positiveInteger(
      options.maxMarkdownBytes ?? AGENTSCRAPE_DEFAULT_MARKDOWN_MAX_BYTES,
      "max markdown bytes",
    ),
    codePoints: positiveInteger(
      options.maxMarkdownCodePoints ??
        AGENTSCRAPE_DEFAULT_MARKDOWN_MAX_CODE_POINTS,
      "max markdown code points",
    ),
  };
}

function enforceMarkdownCap(
  markdown: string,
  limits: { bytes: number; codePoints: number },
): void {
  const bytes = Buffer.byteLength(markdown, "utf8");
  if (bytes > limits.bytes) {
    throw new Error(
      `agentscrape markdown exceeds max_bytes (${bytes} > ${limits.bytes})`,
    );
  }
  const points = codePointLength(markdown);
  if (points > limits.codePoints) {
    throw new Error(
      `agentscrape markdown exceeds max_code_points (${points} > ${limits.codePoints})`,
    );
  }
}

function envDelay(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) &&
    parsed >= AGENTSCRAPE_RETRY_ENV_MIN_MS &&
    parsed <= AGENTSCRAPE_RETRY_CONFIG_MAX_MS
    ? parsed
    : fallback;
}

function retrySettings(options: AgentscrapeRetryOptions | undefined): {
  maxAttempts: number | undefined;
  initialDelayMs: number;
  maxDelayMs: number;
  sleep: (delayMs: number) => void | Promise<void>;
  writeDiagnostic: (message: string) => void;
} {
  const maxAttempts =
    options?.maxAttempts === undefined
      ? undefined
      : positiveInteger(options.maxAttempts, "retry max attempts");
  const initialDelayMs = nonnegativeInteger(
    options?.initialDelayMs ??
      envDelay(
        "AGENTSTACK_BRAIN_AGENTSCRAPE_RETRY_INITIAL_MS",
        AGENTSCRAPE_RETRY_INITIAL_MS,
      ),
    "retry initial delay",
    AGENTSCRAPE_RETRY_CONFIG_MAX_MS,
  );
  const maxDelayMs = nonnegativeInteger(
    options?.maxDelayMs ??
      envDelay("AGENTSTACK_BRAIN_AGENTSCRAPE_RETRY_MAX_MS", AGENTSCRAPE_RETRY_MAX_MS),
    "retry max delay",
    AGENTSCRAPE_RETRY_CONFIG_MAX_MS,
  );
  return {
    maxAttempts,
    initialDelayMs,
    maxDelayMs,
    sleep:
      options?.sleep ??
      ((delayMs) =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, delayMs);
        })),
    writeDiagnostic:
      options?.writeDiagnostic ??
      ((message) => {
        process.stderr.write(message);
      }),
  };
}

function runCommand(
  executable: string,
  args: string[],
  timeoutMs: number,
  maxOutputBytes: number,
  abortSignal?: AbortSignal,
): Promise<CommandResult> {
  const managedSignal = brainSignal();
  if (managedSignal) abortSignal = abortSignal ? AbortSignal.any([abortSignal, managedSignal]) : managedSignal;
  return new Promise((resolve, reject) => {
    const useProcessGroup = process.platform !== "win32";
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(executable, args, {
        detached: useProcessGroup,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      reject(error);
      return;
    }

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let totalBytes = 0;
    let timedOut = false;
    let outputExceeded = false;
    let aborted = false;
    let spawnError: unknown;
    let terminationStarted = false;
    let escalationTimer: ReturnType<typeof setTimeout> | undefined;
    let markChildClosed = (): void => {};
    const childClosed = new Promise<void>((resolveClosed) => {
      markChildClosed = resolveClosed;
    });

    const signalAttempt = (signal: NodeJS.Signals): void => {
      if (useProcessGroup && child.pid !== undefined) {
        let groupSignaled = false;
        try {
          process.kill(-child.pid, signal);
          groupSignaled = true;
        } catch {
          // The group may not have existed yet; the POSIX fallback retries it.
        }
        // Bun has intermittently failed to deliver negative-PID group signals
        // on both hosted Linux and Darwin despite reporting success. A POSIX
        // shell kill reaches the same process-group contract through the OS.
        const nativeKill = spawnSync(
          "/bin/sh",
          [
            "-c",
            'kill -s "$1" -- "-$2"',
            "agentstack-brain-group-kill",
            signal.slice(3),
            String(child.pid),
          ],
          { stdio: "ignore" },
        );
        if (nativeKill.status === 0 || groupSignaled) return;
      }
      try {
        child.kill(signal);
      } catch {
        // The attempt has already exited.
      }
    };
    const terminateOnParentExit = async (): Promise<void> => {
      signalAttempt("SIGKILL");
      const retry = setInterval(() => signalAttempt("SIGKILL"), 25);
      try {
        await childClosed;
      } finally {
        clearInterval(retry);
        signalAttempt("SIGKILL");
      }
    };
    // The owner closes the Package API on process signals. A provider must not
    // exit that process ahead of socket, registration and SQLite cleanup.
    const unregisterProviderTerminator = managedSignal
      ? () => {}
      : registerProviderTerminator(terminateOnParentExit);
    if (!managedSignal) process.once("exit", terminateOnParentExit);

    const terminateAttempt = (): void => {
      if (terminationStarted) return;
      terminationStarted = true;
      signalAttempt("SIGTERM");
      escalationTimer = setTimeout(
        () => signalAttempt("SIGKILL"),
        AGENTSCRAPE_TERMINATION_GRACE_MS,
      );
    };
    const abortAttempt = (): void => {
      aborted = true;
      terminateAttempt();
    };
    abortSignal?.addEventListener("abort", abortAttempt, { once: true });
    if (abortSignal?.aborted) abortAttempt();
    const collect = (destination: Buffer[], chunk: Buffer | string): void => {
      if (outputExceeded) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buffer.byteLength;
      if (totalBytes > maxOutputBytes) {
        outputExceeded = true;
        terminateAttempt();
        return;
      }
      destination.push(buffer);
    };
    child.stdout?.on("data", (chunk) => collect(stdout, chunk));
    child.stderr?.on("data", (chunk) => collect(stderr, chunk));
    child.on("error", (error) => {
      spawnError = error;
    });

    const timer = setTimeout(() => {
      timedOut = true;
      terminateAttempt();
    }, timeoutMs);

    child.on("close", (status, signal) => {
      clearTimeout(timer);
      unregisterProviderTerminator();
      if (!managedSignal) process.removeListener("exit", terminateOnParentExit);
      abortSignal?.removeEventListener("abort", abortAttempt);
      if (escalationTimer !== undefined) {
        clearTimeout(escalationTimer);
        // The direct process may exit while descendants still hold no pipes.
        signalAttempt("SIGKILL");
      }
      markChildClosed();
      resolve({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        status,
        signal,
        ...(spawnError === undefined ? {} : { spawnError }),
        timedOut,
        outputExceeded,
        aborted,
      });
    });
  });
}

const PERMANENT_FAILURE_PATTERNS = [
  /\b(?:auth(?:entication|orization)?|login|credentials?)\s+(?:is\s+)?required\b/i,
  /\b(?:unauthorized|forbidden)\b/i,
  /\b(?:authentication|authorization)\s+(?:failed|denied)\b/i,
  /\binvalid\s+(?:api[-_ ]?key|credentials?|token)\b/i,
  /\b(?:400|401|403|404|410|413|415|422)\b/,
  /\b(?:invalid|unknown|unsupported|missing|bad)\s+(?:preset|input|url|argument|option|request)\b/i,
  /\b(?:preset|input|url|argument|option)\s+(?:is\s+)?invalid\b/i,
  /\b(?:content|document|response|payload|markdown).{0,40}(?:too large|exceeds|unsupported|empty|not found)\b/i,
  /\b(?:unsupported content|content not found|cannot extract|extraction failed)\b/i,
];

const TRANSIENT_FAILURE_PATTERNS = [
  /\bupstream down\b/i,
  /\bfailed to acquire browser from browserctl\b/i,
  /\b(?:agent-browser|browser(?:ctl)?).{0,60}\btimed out\b/i,
  /\b(?:agentscrape|browserctl|agent-browser|executable|binary|command).{0,60}\b(?:not found|missing)\b/i,
  /\bno such file or directory\b/i,
  /\b(?:ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT)\b/i,
  /\bconnection\s+(?:was\s+)?(?:refused|reset|unreachable|timed out)\b/i,
  /\b(?:network|host)\s+(?:is\s+)?unreachable\b/i,
  /\bsocket hang up\b/i,
  /\b(?:backend|browser|upstream|provider|service|daemon).{0,60}\b(?:unavailable|down|offline|not running|unreachable|refused|reset)\b/i,
  /\b(?:failed|unable) to connect\b/i,
];

function transientCommandFailure(detail: string): boolean {
  if (PERMANENT_FAILURE_PATTERNS.some((pattern) => pattern.test(detail))) {
    return false;
  }
  return TRANSIENT_FAILURE_PATTERNS.some((pattern) => pattern.test(detail));
}

function commandErrorDetail(result: CommandResult): string {
  if (result.stderr.trim()) return result.stderr;
  return `agentscrape exited ${result.status ?? "without status"}`;
}

function providerFailure(detail: unknown, transient: boolean): AttemptFailure {
  const sanitized = sanitizeExternalError(detail);
  return new AttemptFailure(
    `agentscrape provider ${transient ? "unavailable" : "failed"}: ${sanitized}`,
    transient,
  );
}

async function scrapeAttempt(
  requestedUrl: string,
  timeoutMs: number,
  maxOutputBytes: number,
  limits: { bytes: number; codePoints: number },
): Promise<ScrapedLink> {
  const executable = findExecutable("agentscrape");
  if (!executable) {
    throw providerFailure("agentscrape is not installed on PATH", true);
  }
  const args = ["fetch-markdown", "--markdown", requestedUrl];

  let result: CommandResult;
  try {
    result = await runCommand(executable, args, timeoutMs, maxOutputBytes);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    throw providerFailure(error, code === "ENOENT");
  }
  if (result.outputExceeded) {
    throw providerFailure(
      `command output exceeds max_output_bytes (${maxOutputBytes})`,
      false,
    );
  }
  if (result.timedOut) {
    throw providerFailure(`command timed out after ${timeoutMs}ms`, true);
  }
  if (result.spawnError) {
    const code = (result.spawnError as NodeJS.ErrnoException).code;
    throw providerFailure(result.spawnError, code === "ENOENT");
  }
  if (result.signal) {
    throw providerFailure(`command terminated by ${result.signal}`, false);
  }
  if (result.status !== 0) {
    const detail = commandErrorDetail(result).replaceAll(requestedUrl, "[URL]");
    throw providerFailure(detail, transientCommandFailure(detail));
  }
  if (!result.stdout.trim()) {
    throw providerFailure("agentscrape returned empty markdown", false);
  }

  try {
    enforceMarkdownCap(result.stdout, limits);
  } catch (error) {
    throw providerFailure(error, false);
  }
  return {
    success: true,
    url: requestedUrl,
    requested_url: requestedUrl,
    markdown: result.stdout,
    content: result.stdout,
    size_chars: codePointLength(result.stdout),
  };
}

/** Invoke the sole URL-extraction provider, retrying only availability failures. */
export async function scrapeWithAgentscrape(
  inputUrl: string,
  options: ScrapeOptions = {},
): Promise<ScrapedLink> {
  const requestedUrl = normalizedWebUrl(inputUrl);
  const timeoutMs = positiveInteger(
    options.timeoutMs ?? AGENTSCRAPE_DEFAULT_TIMEOUT_MS,
    "agentscrape timeout",
    AGENTSCRAPE_TIMEOUT_MAX_MS,
  );
  const requestedOutputLimit = positiveInteger(
    options.maxOutputBytes ?? AGENTSCRAPE_OUTPUT_MAX_BYTES,
    "agentscrape max output bytes",
  );
  const maxOutputBytes = Math.min(
    requestedOutputLimit,
    AGENTSCRAPE_OUTPUT_MAX_BYTES,
  );
  const limits = markdownLimits(options);
  const retry = retrySettings(options.retry);

  let attempt = 1;
  let lastDiagnosticDelay: number | undefined;
  while (true) {
    try {
      return await scrapeAttempt(
        requestedUrl,
        timeoutMs,
        maxOutputBytes,
        limits,
      );
    } catch (error) {
      if (!(error instanceof AttemptFailure)) throw error;
      if (
        !error.transient ||
        (retry.maxAttempts !== undefined && attempt >= retry.maxAttempts)
      ) {
        throw new Error(error.message);
      }
      const exponent = Math.min(attempt - 1, 30);
      const delayMs = Math.min(
        retry.initialDelayMs * 2 ** exponent,
        retry.maxDelayMs,
      );
      if (delayMs !== lastDiagnosticDelay) {
        const diagnostic =
          `AgentStack Brain: Agentscrape unavailable; retrying provider command ` +
          `(attempt ${attempt + 1}, delay ${delayMs}ms)\n`;
        try {
          retry.writeDiagnostic(diagnostic);
        } catch {
          // Diagnostics must never change provider retry behavior.
        }
        lastDiagnosticDelay = delayMs;
      }
      await retry.sleep(delayMs);
      attempt += 1;
    }
  }
}

const EXTRACTION_FAILURE_CLASSES = new Set<ExtractionFailureClass>([
  "invalid_request",
  "authentication_required",
  "upstream_unavailable",
  "timeout",
  "browser_error",
  "provider_error",
  "malformed_provider_output",
  "empty_content",
  "output_limit_exceeded",
  "cancelled",
  "internal_error",
]);

function protocolDefect(detail: string): never {
  throw new AgentscrapeExtractionError(
    `agentscrape protocol defect: ${detail}`,
    "permanent",
    "protocol",
  );
}

function extractionRecord(
  value: unknown,
  keys: readonly string[],
  name: string,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return protocolDefect(`${name} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    return protocolDefect(`${name} has unknown or missing fields`);
  }
  return record;
}

function extractionString(
  value: unknown,
  name: string,
  maximum: number,
  minimum = 0,
): string {
  if (typeof value !== "string") {
    return protocolDefect(`${name} must be text`);
  }
  const length = codePointLength(value);
  if (length < minimum || length > maximum) {
    return protocolDefect(`${name} is outside its size bound`);
  }
  return value;
}

function extractionUrl(value: unknown, name: string): string {
  const text = extractionString(value, name, 4096, 1);
  if (Buffer.byteLength(text, "utf8") > 4096) {
    return protocolDefect(`${name} is outside its byte bound`);
  }
  try {
    validateHttpUrl(text);
  } catch {
    return protocolDefect(`${name} is not an absolute HTTP(S) URL`);
  }
  return text;
}

function redactedComponentMatches(expected: string, actual: string): boolean {
  if (expected === actual) return true;
  try {
    return decodeURIComponent(actual) === "[REDACTED]";
  } catch {
    return false;
  }
}

function requestEvidenceMatches(expected: string, actual: string): boolean {
  const left = validateHttpUrl(expected);
  const right = validateHttpUrl(actual);
  if (
    left.protocol.toLowerCase() !== right.protocol.toLowerCase() ||
    left.hostname.toLowerCase() !== right.hostname.toLowerCase() ||
    left.port !== right.port
  ) {
    return false;
  }
  const leftPath = left.pathname.split("/");
  const rightPath = right.pathname.split("/");
  if (
    leftPath.length !== rightPath.length ||
    leftPath.some(
      (part, index) => !redactedComponentMatches(part, rightPath[index] ?? ""),
    )
  ) {
    return false;
  }
  const leftQuery = [...left.searchParams.entries()];
  const rightQuery = [...right.searchParams.entries()];
  return (
    leftQuery.length === rightQuery.length &&
    leftQuery.every(([name, value], index) => {
      const other = rightQuery[index];
      return (
        other !== undefined &&
        name === other[0] &&
        redactedComponentMatches(value, other[1])
      );
    })
  );
}

function parseExtractor(value: unknown): ExtractorIdentity {
  const record = extractionRecord(
    value,
    ["name", "version", "implementation", "implementation_version"],
    "extractor",
  );
  if (record.name !== "agentscrape") {
    return protocolDefect("extractor name is unsupported");
  }
  return {
    name: "agentscrape",
    version: extractionString(record.version, "extractor version", 100),
    implementation: extractionString(
      record.implementation,
      "extractor implementation",
      100,
    ),
    implementation_version: extractionString(
      record.implementation_version,
      "extractor implementation version",
      100,
    ),
  };
}

function parseMetadata(value: unknown): ExtractionMetadata {
  const optional =
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? ["content_kind", "content_item_count"].filter((key) => key in value)
      : [];
  const record = extractionRecord(
    value,
    [
      "content_type",
      "title",
      "author_name",
      "author_handle",
      "published_at",
      "source_id",
      "warnings",
      ...optional,
    ],
    "extraction metadata",
  );
  if (
    !new Set(["web_page", "social_post", "article"]).has(
      String(record.content_type),
    )
  ) {
    return protocolDefect("metadata content type is unsupported");
  }
  const hasContentKind = Object.hasOwn(record, "content_kind");
  const hasItemCount = Object.hasOwn(record, "content_item_count");
  if (hasContentKind !== hasItemCount) {
    return protocolDefect(
      "metadata content kind and item count must be provided together",
    );
  }
  if (
    hasContentKind &&
    !new Set(["post", "thread", "article"]).has(String(record.content_kind))
  ) {
    return protocolDefect("metadata content kind is unsupported");
  }
  if (
    hasItemCount &&
    (!Number.isSafeInteger(record.content_item_count) ||
      (record.content_item_count as number) < 1 ||
      (record.content_item_count as number) > 10_000)
  ) {
    return protocolDefect("metadata content item count is invalid");
  }
  if (
    record.content_kind === "thread" &&
    (record.content_item_count as number) < 2
  ) {
    return protocolDefect("thread metadata must contain at least two items");
  }
  if (
    (record.content_kind === "post" || record.content_kind === "article") &&
    record.content_item_count !== 1
  ) {
    return protocolDefect(
      `${record.content_kind} metadata must contain one item`,
    );
  }
  if (!Array.isArray(record.warnings) || record.warnings.length > 8) {
    return protocolDefect("metadata warnings are invalid");
  }
  if (record.warnings.some((warning) => warning !== "partial_content")) {
    return protocolDefect("metadata warning is unsupported");
  }
  return {
    content_type: record.content_type as ExtractionMetadata["content_type"],
    ...(hasContentKind
      ? {
          content_kind: record.content_kind as NonNullable<
            ExtractionMetadata["content_kind"]
          >,
          content_item_count: record.content_item_count as number,
        }
      : {}),
    title: extractionString(record.title, "metadata title", 500),
    author_name: extractionString(record.author_name, "metadata author", 200),
    author_handle: extractionString(
      record.author_handle,
      "metadata author handle",
      100,
    ),
    published_at: extractionString(
      record.published_at,
      "metadata publication time",
      100,
    ),
    source_id: extractionString(record.source_id, "metadata source id", 200),
    warnings: record.warnings as Array<"partial_content">,
  };
}

function validateContentClassification(
  metadata: ExtractionMetadata,
  extractor: ExtractorIdentity,
): void {
  if (metadata.content_kind === undefined) return;
  const validTweet =
    (metadata.content_kind === "post" || metadata.content_kind === "thread") &&
    metadata.content_type === "social_post" &&
    extractor.implementation === "x-tweet";
  const validArticle =
    metadata.content_kind === "article" &&
    metadata.content_type === "article" &&
    extractor.implementation === "x-article";
  if (!validTweet && !validArticle) {
    protocolDefect(
      "metadata content classification does not match its extractor",
    );
  }
}

const EXTRACTION_RELATION_TYPES = new Set<ExtractionRelation["relation_type"]>([
  "references",
  "content_link",
  "article",
  "quoted_post",
]);

function parseRelations(value: unknown, maximum: number): ExtractionRelation[] {
  if (!Array.isArray(value) || value.length > maximum) {
    return protocolDefect("extraction relations are invalid");
  }
  return value.map((item) => {
    const record = extractionRecord(
      item,
      ["relation_type", "target_url"],
      "extraction relation",
    );
    if (
      typeof record.relation_type !== "string" ||
      !EXTRACTION_RELATION_TYPES.has(
        record.relation_type as ExtractionRelation["relation_type"],
      )
    ) {
      return protocolDefect("extraction relation type is unsupported");
    }
    return {
      relation_type:
        record.relation_type as ExtractionRelation["relation_type"],
      target_url: extractionUrl(record.target_url, "relation target URL"),
    };
  });
}

function parseFailureDetail(value: unknown): ExtractionFailureDetail {
  const record = extractionRecord(
    value,
    ["failure_class", "retryable", "message", "evidence"],
    "extraction failure",
  );
  if (
    typeof record.failure_class !== "string" ||
    !EXTRACTION_FAILURE_CLASSES.has(
      record.failure_class as ExtractionFailureClass,
    )
  ) {
    return protocolDefect("extraction failure class is unsupported");
  }
  if (typeof record.retryable !== "boolean") {
    return protocolDefect("extraction retry advice is invalid");
  }
  return {
    failure_class: record.failure_class as ExtractionFailureClass,
    retryable: record.retryable,
    message: extractionString(
      record.message,
      "extraction failure message",
      200,
    ),
    evidence: extractionString(
      record.evidence,
      "extraction failure evidence",
      1024,
      1,
    ),
  };
}

export function validateExtractionEnvelope(
  value: unknown,
  expectedUrl: string,
  options: { maxContentBytes?: number; maxRelations?: number } = {},
): ExtractionEnvelope {
  const maxContentBytes = positiveInteger(
    options.maxContentBytes ?? AGENTSCRAPE_DEFAULT_MARKDOWN_MAX_BYTES,
    "max extraction content bytes",
    AGENTSCRAPE_DEFAULT_MARKDOWN_MAX_BYTES,
  );
  const maxRelations = nonnegativeInteger(
    options.maxRelations ?? AGENTSCRAPE_DEFAULT_MAX_RELATIONS,
    "max extraction relations",
    AGENTSCRAPE_DEFAULT_MAX_RELATIONS,
  );
  const record = extractionRecord(
    value,
    [
      "schema_version",
      "status",
      "requested_url",
      "final_url",
      "extractor",
      "artifacts",
      "metadata",
      "relations",
      "failure",
    ],
    "extraction envelope",
  );
  if (record.schema_version !== AGENTSCRAPE_EXTRACTION_SCHEMA_VERSION) {
    return protocolDefect("extraction schema version is unsupported");
  }
  const requestedUrl = extractionUrl(
    record.requested_url,
    "extraction requested URL",
  );
  if (!requestEvidenceMatches(expectedUrl, requestedUrl)) {
    return protocolDefect("extraction requested URL does not match the job");
  }
  const extractor = parseExtractor(record.extractor);

  if (record.status === "success") {
    const finalUrl = extractionUrl(record.final_url, "extraction final URL");
    if (!Array.isArray(record.artifacts) || record.artifacts.length !== 1) {
      return protocolDefect("successful extraction must contain one artifact");
    }
    const artifactRecord = extractionRecord(
      record.artifacts[0],
      [
        "artifact_type",
        "media_type",
        "encoding",
        "content",
        "size_bytes",
        "sha256",
      ],
      "extraction artifact",
    );
    if (
      artifactRecord.artifact_type !== "document" ||
      artifactRecord.media_type !== "text/markdown" ||
      artifactRecord.encoding !== "utf-8"
    ) {
      return protocolDefect("extraction artifact descriptor is unsupported");
    }
    const content = extractionString(
      artifactRecord.content,
      "extraction content",
      maxContentBytes,
      1,
    );
    if (!content.trim()) {
      return protocolDefect("successful extraction content is empty");
    }
    const contentBytes = Buffer.byteLength(content, "utf8");
    if (contentBytes > maxContentBytes) {
      return protocolDefect("extraction content exceeds its byte bound");
    }
    if (
      !Number.isSafeInteger(artifactRecord.size_bytes) ||
      artifactRecord.size_bytes !== contentBytes
    ) {
      return protocolDefect("extraction artifact size does not match content");
    }
    if (
      typeof artifactRecord.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(artifactRecord.sha256) ||
      createHash("sha256").update(content, "utf8").digest("hex") !==
        artifactRecord.sha256
    ) {
      return protocolDefect(
        "extraction artifact digest does not match content",
      );
    }
    if (record.failure !== null) {
      return protocolDefect("successful extraction contains failure details");
    }
    const metadata = parseMetadata(record.metadata);
    validateContentClassification(metadata, extractor);
    const relations = parseRelations(record.relations, maxRelations);
    return {
      schema_version: "1",
      status: "success",
      requested_url: requestedUrl,
      final_url: finalUrl,
      extractor,
      artifacts: [
        {
          artifact_type: "document",
          media_type: "text/markdown",
          encoding: "utf-8",
          content,
          size_bytes: contentBytes,
          sha256: artifactRecord.sha256,
        },
      ],
      metadata,
      relations,
      failure: null,
    };
  }

  if (record.status !== "failure") {
    return protocolDefect("extraction status is unsupported");
  }
  if (
    !Array.isArray(record.artifacts) ||
    record.artifacts.length !== 0 ||
    record.metadata !== null ||
    !Array.isArray(record.relations) ||
    record.relations.length !== 0
  ) {
    return protocolDefect("failed extraction contains success data");
  }
  const finalUrl =
    record.final_url === null
      ? null
      : extractionUrl(record.final_url, "extraction final URL");
  return {
    schema_version: "1",
    status: "failure",
    requested_url: requestedUrl,
    final_url: finalUrl,
    extractor,
    artifacts: [],
    metadata: null,
    relations: [],
    failure: parseFailureDetail(record.failure),
  };
}

function envelopeFailure(detail: ExtractionFailureDetail): never {
  const summary = sanitizeExternalError(
    `${detail.message}: ${detail.evidence}`,
  );
  const message = `agentscrape extraction failed (${detail.failure_class}): ${summary}`;
  if (detail.failure_class === "cancelled") {
    throw new AgentscrapeExtractionError(message, "cancelled", "cancellation");
  }
  if (detail.failure_class === "authentication_required") {
    throw new AgentscrapeExtractionError(message, "auth_config", "auth_config");
  }
  if (detail.failure_class === "invalid_request") {
    throw new AgentscrapeExtractionError(message, "permanent", "policy");
  }
  if (detail.retryable && detail.failure_class === "upstream_unavailable") {
    // An unavailable extraction dependency (missing agent-browser, browserctl
    // outage) is infrastructure per ADR 0004: retry indefinitely with capped
    // backoff instead of burning the bounded item-retry budget.
    throw new AgentscrapeExtractionError(message, "infra", "infrastructure");
  }
  if (
    detail.retryable &&
    new Set(["timeout", "browser_error", "provider_error"]).has(
      detail.failure_class,
    )
  ) {
    throw new AgentscrapeExtractionError(message, "item_transient", "item");
  }
  throw new AgentscrapeExtractionError(message, "permanent", "permanent");
}

export async function extractWithAgentscrape(
  inputUrl: string,
  options: ExtractionOptions = {},
): Promise<ExtractionSuccess> {
  const requestedUrl = normalizedWebUrl(inputUrl);
  const timeoutMs = positiveInteger(
    options.timeoutMs ?? AGENTSCRAPE_DEFAULT_TIMEOUT_MS,
    "agentscrape timeout",
    AGENTSCRAPE_TIMEOUT_MAX_MS,
  );
  const maxContentBytes = positiveInteger(
    options.maxContentBytes ?? AGENTSCRAPE_DEFAULT_MARKDOWN_MAX_BYTES,
    "agentscrape max content bytes",
    AGENTSCRAPE_DEFAULT_MARKDOWN_MAX_BYTES,
  );
  const maxRelations = nonnegativeInteger(
    options.maxRelations ?? AGENTSCRAPE_DEFAULT_MAX_RELATIONS,
    "agentscrape max relations",
    AGENTSCRAPE_DEFAULT_MAX_RELATIONS,
  );
  const maxOutputBytes = Math.min(
    positiveInteger(
      options.maxOutputBytes ?? AGENTSCRAPE_OUTPUT_MAX_BYTES,
      "agentscrape max output bytes",
    ),
    AGENTSCRAPE_OUTPUT_MAX_BYTES,
  );
  if (options.signal?.aborted) {
    throw new AgentscrapeExtractionError(
      "agentscrape extraction was cancelled",
      "cancelled",
      "cancellation",
    );
  }
  const executable = findExecutable("agentscrape");
  if (executable === null) {
    throw new AgentscrapeExtractionError(
      "agentscrape extraction infrastructure is unavailable",
      "infra",
      "infrastructure",
    );
  }
  const args = [
    "fetch-markdown",
    requestedUrl,
    "--envelope",
    // Browser-backed live routes deny egress without explicit consent. Operator
    // admission of a URL for ingestion is that consent, so the worker grants it.
    "--allow-private-network",
    "--max-content-bytes",
    String(maxContentBytes),
    "--max-relations",
    String(maxRelations),
  ];

  let result: CommandResult;
  try {
    result = await runCommand(
      executable,
      args,
      timeoutMs,
      maxOutputBytes,
      options.signal,
    );
  } catch (error) {
    throw new AgentscrapeExtractionError(
      `agentscrape extraction infrastructure failed: ${sanitizeExternalError(error)}`,
      "infra",
      "infrastructure",
    );
  }
  if (result.aborted) {
    throw new AgentscrapeExtractionError(
      "agentscrape extraction was cancelled",
      "cancelled",
      "cancellation",
    );
  }
  if (result.outputExceeded) {
    return protocolDefect("extraction command output exceeded its bound");
  }
  if (result.timedOut) {
    throw new AgentscrapeExtractionError(
      `agentscrape extraction timed out after ${timeoutMs}ms`,
      "item_transient",
      "item",
    );
  }
  if (result.spawnError !== undefined) {
    throw new AgentscrapeExtractionError(
      `agentscrape extraction infrastructure failed: ${sanitizeExternalError(result.spawnError)}`,
      "infra",
      "infrastructure",
    );
  }
  if (result.signal !== null) {
    const cancelled = new Set(["SIGHUP", "SIGINT", "SIGTERM"]).has(
      result.signal,
    );
    throw new AgentscrapeExtractionError(
      `agentscrape extraction terminated by ${result.signal}`,
      cancelled ? "cancelled" : "infra",
      cancelled ? "cancellation" : "infrastructure",
    );
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(result.stdout) as unknown;
  } catch {
    return protocolDefect("extraction command returned malformed JSON");
  }
  const envelope = validateExtractionEnvelope(decoded, requestedUrl, {
    maxContentBytes,
    maxRelations,
  });
  if (envelope.status === "success") {
    if (result.status !== 0) {
      return protocolDefect("successful extraction exited nonzero");
    }
    return envelope;
  }
  if (result.status === 0) {
    return protocolDefect("failed extraction exited successfully");
  }
  return envelopeFailure(envelope.failure);
}

function discoveryProtocol(detail: string): never {
  throw new AgentscrapeDiscoveryError(
    `agentscrape discovery protocol defect: ${detail}`,
    "permanent",
    "protocol",
  );
}

function discoveryRecord(
  value: unknown,
  keys: readonly string[],
  name: string,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return discoveryProtocol(`${name} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    return discoveryProtocol(`${name} has unknown or missing fields`);
  }
  return record;
}

function discoveryText(
  value: unknown,
  name: string,
  maximum: number,
  minimum = 0,
): string {
  if (typeof value !== "string") {
    return discoveryProtocol(`${name} must be text`);
  }
  const length = codePointLength(value);
  if (length < minimum || length > maximum) {
    return discoveryProtocol(`${name} is outside its size bound`);
  }
  return value;
}

function discoveryNullableText(
  value: unknown,
  name: string,
  maximum: number,
): string | null {
  return value === null ? null : discoveryText(value, name, maximum);
}

function discoveryUrl(value: unknown, name: string): string {
  const url = discoveryText(value, name, 4_096, 1);
  try {
    validateHttpUrl(url);
  } catch {
    return discoveryProtocol(`${name} is not an absolute HTTP(S) URL`);
  }
  return normalizedWebUrl(url);
}

function parseDiscoveryWarnings(
  value: unknown,
  maximum: number,
  feed: boolean,
): DiscoveryWarning[] {
  if (!Array.isArray(value) || value.length > maximum) {
    return discoveryProtocol("discovery warnings are invalid");
  }
  return value.map((item) => {
    const warning = discoveryRecord(
      item,
      feed &&
        item !== null &&
        typeof item === "object" &&
        !Array.isArray(item) &&
        Object.hasOwn(item, "page_url")
        ? ["code", "message", "page_url"]
        : ["code", "message"],
      "discovery warning",
    );
    return {
      code: discoveryText(warning.code, "warning code", 100, 1),
      message: discoveryText(warning.message, "warning message", 200),
      ...(feed
        ? {
            page_url:
              warning.page_url === undefined || warning.page_url === null
                ? null
                : discoveryUrl(warning.page_url, "warning page URL"),
          }
        : {}),
    };
  });
}

const FEED_WARNING_CODES = new Set([
  "invalid_date",
  "naive_date_assumed_utc",
  "unsafe_url_omitted",
  "entry_without_identity",
  "response_limit_reached",
  "page_limit_reached",
  "item_limit_reached",
  "pagination_loop",
  "page_not_recorded",
  "malformed_page",
  "unsupported_page",
  "no_archive_entries",
  "undated_item",
  "validator_omitted",
  "warnings_truncated",
]);

const FEED_INCOMPLETE_WARNING_CODES = new Set([
  "invalid_date",
  "unsafe_url_omitted",
  "entry_without_identity",
  "response_limit_reached",
  "page_limit_reached",
  "item_limit_reached",
  "pagination_loop",
  "page_not_recorded",
  "malformed_page",
  "unsupported_page",
  "no_archive_entries",
  "undated_item",
  "warnings_truncated",
]);

const FEED_FAILURE_CODES = new Set([
  "invalid_options",
  "unsafe_source_url",
  "response_limit_exceeded",
  "malformed_xml",
  "unsupported_source",
  "malformed_archive",
  "timeout",
  "cancelled",
  "input_error",
  "internal_error",
  "authentication_required",
  "rate_limited",
  "upstream_unavailable",
  "network_error",
  "http_error",
  "unsupported_content_type",
  "unsafe_destination",
  "transport_policy_violation",
  "unsupported_encoding",
  "malformed_response",
  "redirect_error",
  "redirect_limit_exceeded",
  "invalid_utf8",
  "feed_not_discovered",
  "unsupported_media_type",
]);

function parseFeedValidators(value: unknown): {
  etag: string | null;
  last_modified: string | null;
} {
  const validators = discoveryRecord(
    value,
    ["etag", "last_modified"],
    "feed validators",
  );
  return {
    etag: discoveryNullableText(validators.etag, "feed ETag", 512),
    last_modified: discoveryNullableText(
      validators.last_modified,
      "feed Last-Modified",
      512,
    ),
  };
}

export function validateFeedDiscoveryEnvelope(
  value: unknown,
  expectedSourceUrl: string,
  options: { maxItems?: number; maxPages?: number } = {},
): FeedDiscoveryEnvelope {
  const record = discoveryRecord(
    value,
    [
      "schema_version",
      "status",
      "source_url",
      "source_format",
      "validators",
      "cursor",
      "items",
      "pagination",
      "warnings",
      "absence_implies_deletion",
      "failure",
    ],
    "feed discovery envelope",
  );
  if (record.schema_version !== "1") {
    return discoveryProtocol("feed discovery schema version is unsupported");
  }
  if (!new Set(["success", "partial", "failure"]).has(String(record.status))) {
    return discoveryProtocol("feed discovery status is unsupported");
  }
  const sourceUrl = discoveryUrl(record.source_url, "feed source URL");
  if (sourceUrl !== normalizedWebUrl(expectedSourceUrl)) {
    return discoveryProtocol("feed source URL does not match the request");
  }
  if (
    !new Set(["rss", "atom", "archive", "mixed", "unknown"]).has(
      String(record.source_format),
    )
  ) {
    return discoveryProtocol("feed source format is unsupported");
  }
  const itemLimit = Math.min(options.maxItems ?? 10_000, 10_000);
  if (!Array.isArray(record.items) || record.items.length > itemLimit) {
    return discoveryProtocol("feed discovery items exceed their bound");
  }
  const items = record.items.map((item) => {
    const entry = discoveryRecord(
      item,
      [
        "stable_id",
        "upstream_id",
        "identity_source",
        "url",
        "candidate_urls",
        "title",
        "published_at",
        "updated_at",
        "tombstone",
      ],
      "feed discovery item",
    );
    if (
      !new Set(["upstream_id", "canonical_url", "hashed_upstream_id"]).has(
        String(entry.identity_source),
      ) ||
      typeof entry.tombstone !== "boolean" ||
      !Array.isArray(entry.candidate_urls) ||
      entry.candidate_urls.length > 16
    ) {
      return discoveryProtocol("feed discovery item is invalid");
    }
    return {
      stable_id: discoveryText(entry.stable_id, "feed stable ID", 512, 1),
      upstream_id: discoveryNullableText(
        entry.upstream_id,
        "feed upstream ID",
        512,
      ),
      identity_source:
        entry.identity_source as FeedDiscoveryItem["identity_source"],
      url: entry.url === null ? null : discoveryUrl(entry.url, "feed item URL"),
      candidate_urls: entry.candidate_urls.map((url) =>
        discoveryUrl(url, "feed candidate URL"),
      ),
      title: discoveryText(entry.title, "feed item title", 500),
      published_at: discoveryNullableText(
        entry.published_at,
        "feed publication time",
        40,
      ),
      updated_at: discoveryNullableText(
        entry.updated_at,
        "feed update time",
        40,
      ),
      tombstone: entry.tombstone,
    };
  });
  const pagination = discoveryRecord(
    record.pagination,
    ["pages", "complete", "stop_reason", "next_url"],
    "feed pagination evidence",
  );
  const pageLimit = Math.min(options.maxPages ?? 100, 100);
  if (
    !Array.isArray(pagination.pages) ||
    pagination.pages.length > pageLimit ||
    typeof pagination.complete !== "boolean"
  ) {
    return discoveryProtocol("feed pagination evidence is invalid");
  }
  const stopReasons = new Set([
    "exhausted",
    "failed",
    "page_limit",
    "item_limit",
    "loop",
    "missing_page",
    "response_limit",
    "timeout",
    "cancelled",
    "malformed_page",
    "not_modified",
    "transport_failure",
    "network_error",
    "policy",
    "authentication",
    "http_error",
    "redirect_error",
    "redirect_limit",
    "unsupported_encoding",
    "malformed_response",
    "feed_discovery",
    "unsupported_source",
  ]);
  if (!stopReasons.has(String(pagination.stop_reason))) {
    return discoveryProtocol("feed pagination stop reason is unsupported");
  }
  const pages = pagination.pages.map((item) => {
    const page = discoveryRecord(
      item,
      ["url", "page_format", "validators", "item_count", "next_url"],
      "feed page evidence",
    );
    if (
      !new Set(["rss", "atom", "archive"]).has(String(page.page_format)) ||
      !Number.isSafeInteger(page.item_count) ||
      (page.item_count as number) < 0
    ) {
      return discoveryProtocol("feed page evidence is invalid");
    }
    return {
      url: discoveryUrl(page.url, "feed page URL"),
      page_format: page.page_format as "rss" | "atom" | "archive",
      validators: parseFeedValidators(page.validators),
      item_count: page.item_count as number,
      next_url:
        page.next_url === null
          ? null
          : discoveryUrl(page.next_url, "feed next page URL"),
    };
  });
  const cursor = discoveryRecord(
    record.cursor,
    ["validators", "newest_seen_at", "next_url"],
    "feed discovery cursor",
  );
  let failure: FeedDiscoveryEnvelope["failure"] = null;
  if (record.failure !== null) {
    const detail = discoveryRecord(
      record.failure,
      ["code", "retryable", "message"],
      "feed discovery failure",
    );
    if (
      typeof detail.retryable !== "boolean" ||
      typeof detail.code !== "string" ||
      !FEED_FAILURE_CODES.has(detail.code)
    ) {
      return discoveryProtocol("feed discovery failure is invalid");
    }
    failure = {
      code: discoveryText(detail.code, "feed failure code", 100, 1),
      retryable: detail.retryable,
      message: discoveryText(detail.message, "feed failure message", 200),
    };
  }
  const validators = parseFeedValidators(record.validators);
  const cursorValidators = parseFeedValidators(cursor.validators);
  const cursorNextUrl =
    cursor.next_url === null
      ? null
      : discoveryUrl(cursor.next_url, "feed cursor next URL");
  const paginationNextUrl =
    pagination.next_url === null
      ? null
      : discoveryUrl(pagination.next_url, "feed boundary URL");
  const warnings = parseDiscoveryWarnings(record.warnings, 101, true);
  if (warnings.some((warning) => !FEED_WARNING_CODES.has(warning.code))) {
    return discoveryProtocol("feed discovery warning code is unsupported");
  }
  const status = record.status as FeedDiscoveryEnvelope["status"];
  const complete = pagination.complete as boolean;
  const stopReason =
    pagination.stop_reason as FeedDiscoveryEnvelope["pagination"]["stop_reason"];
  const notModified = stopReason === "not_modified";
  const successfulBoundary =
    complete &&
    (stopReason === "exhausted" || notModified) &&
    cursorNextUrl === null &&
    paginationNextUrl === null;
  if (
    record.absence_implies_deletion !== false ||
    (status === "success" && failure !== null) ||
    (status === "failure" && failure === null) ||
    (status === "success" && !successfulBoundary) ||
    (notModified &&
      (items.length !== 0 ||
        pages.length !== 0 ||
        record.source_format !== "unknown")) ||
    (complete && status !== "success") ||
    cursorNextUrl !== paginationNextUrl ||
    JSON.stringify(validators) !== JSON.stringify(cursorValidators) ||
    (status === "success" &&
      warnings.some((warning) =>
        FEED_INCOMPLETE_WARNING_CODES.has(warning.code),
      ))
  ) {
    return discoveryProtocol("feed discovery completion evidence is invalid");
  }
  return {
    schema_version: "1",
    status,
    source_url: sourceUrl,
    source_format:
      record.source_format as FeedDiscoveryEnvelope["source_format"],
    validators,
    cursor: {
      validators: cursorValidators,
      newest_seen_at: discoveryNullableText(
        cursor.newest_seen_at,
        "feed newest item time",
        40,
      ),
      next_url: cursorNextUrl,
    },
    items,
    pagination: {
      pages,
      complete,
      stop_reason: stopReason,
      next_url: paginationNextUrl,
    },
    warnings,
    absence_implies_deletion: false,
    failure,
  };
}

export function validateXTimelineDiscoveryEnvelope(
  value: unknown,
  expectedHandle: string,
  options: { maxItems?: number } = {},
): XTimelineDiscoveryEnvelope {
  const record = discoveryRecord(
    value,
    ["handle", "next_cursor", "scraped_at", "tweets", "warnings"],
    "X timeline discovery envelope",
  );
  const handle = discoveryText(record.handle, "X timeline handle", 20, 1);
  if (
    handle.replace(/^@/, "").toLowerCase() !==
    expectedHandle.replace(/^@/, "").toLowerCase()
  ) {
    return discoveryProtocol("X timeline handle does not match the request");
  }
  const maxItems = Math.min(options.maxItems ?? 10_000, 10_000);
  if (!Array.isArray(record.tweets) || record.tweets.length > maxItems) {
    return discoveryProtocol("X timeline items exceed their bound");
  }
  const tweets = record.tweets.map((item) => {
    const tweet = discoveryRecord(
      item,
      [
        "id",
        "url",
        "text",
        "created_at",
        "is_reply",
        "is_repost",
        "is_quote",
        "is_pinned",
        "article_urls",
      ],
      "X timeline item",
    );
    const id = discoveryText(tweet.id, "X status ID", 30, 1);
    const url = discoveryUrl(tweet.url, "X status URL");
    if (!/^\d+$/.test(id) || xStatusId(url) !== id) {
      return discoveryProtocol("X timeline item identity is invalid");
    }
    if (
      typeof tweet.is_reply !== "boolean" ||
      typeof tweet.is_repost !== "boolean" ||
      typeof tweet.is_quote !== "boolean" ||
      typeof tweet.is_pinned !== "boolean" ||
      !Array.isArray(tweet.article_urls) ||
      tweet.article_urls.length > 16
    ) {
      return discoveryProtocol("X timeline item metadata is invalid");
    }
    return {
      id,
      url,
      text: discoveryText(tweet.text, "X timeline text", 20_000),
      created_at: discoveryText(tweet.created_at, "X creation time", 100),
      is_reply: tweet.is_reply,
      is_repost: tweet.is_repost,
      is_quote: tweet.is_quote,
      is_pinned: tweet.is_pinned,
      article_urls: tweet.article_urls.map((url) =>
        discoveryUrl(url, "X Article URL"),
      ),
    };
  });
  const nextCursor = discoveryNullableText(
    record.next_cursor,
    "X diagnostic oldest item ID",
    30,
  );
  if (nextCursor !== null && !/^\d+$/.test(nextCursor)) {
    return discoveryProtocol("X diagnostic oldest item ID is invalid");
  }
  return {
    handle,
    next_cursor: nextCursor,
    scraped_at: discoveryText(record.scraped_at, "X scrape time", 100),
    tweets,
    warnings: parseDiscoveryWarnings(record.warnings, 100, false),
  };
}

function discoveryCommandFailure(
  detail: string,
  prefix: string,
): AgentscrapeDiscoveryError {
  const sanitized = sanitizeExternalError(detail);
  if (/429|rate.?limit|throttl/i.test(detail)) {
    return new AgentscrapeDiscoveryError(
      `${prefix} was rate limited: ${sanitized}`,
      "item_transient",
      "rate_limit",
    );
  }
  if (/auth|login|credential|unauthorized|forbidden|cookie/i.test(detail)) {
    return new AgentscrapeDiscoveryError(
      `${prefix} authentication/configuration failed: ${sanitized}`,
      "auth_config",
      "auth_config",
    );
  }
  return new AgentscrapeDiscoveryError(
    `${prefix} failed: ${sanitized}`,
    "infra",
    "infrastructure",
  );
}

async function runDiscoveryCommand(
  args: string[],
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<CommandResult> {
  if (signal?.aborted) {
    throw new AgentscrapeDiscoveryError(
      "agentscrape discovery was cancelled",
      "cancelled",
      "cancellation",
    );
  }
  const executable = findExecutable("agentscrape");
  if (executable === null) {
    throw new AgentscrapeDiscoveryError(
      "agentscrape discovery infrastructure is unavailable",
      "infra",
      "infrastructure",
    );
  }
  let result: CommandResult;
  try {
    result = await runCommand(
      executable,
      args,
      timeoutMs,
      AGENTSCRAPE_OUTPUT_MAX_BYTES,
      signal,
    );
  } catch (error) {
    throw new AgentscrapeDiscoveryError(
      `agentscrape discovery infrastructure failed: ${sanitizeExternalError(error)}`,
      "infra",
      "infrastructure",
    );
  }
  if (result.aborted) {
    throw new AgentscrapeDiscoveryError(
      "agentscrape discovery was cancelled",
      "cancelled",
      "cancellation",
    );
  }
  if (result.outputExceeded) {
    return discoveryProtocol("discovery command output exceeded its bound");
  }
  if (result.timedOut) {
    throw new AgentscrapeDiscoveryError(
      `agentscrape discovery timed out after ${timeoutMs}ms`,
      "item_transient",
      "infrastructure",
    );
  }
  if (result.spawnError !== undefined) {
    throw new AgentscrapeDiscoveryError(
      `agentscrape discovery infrastructure failed: ${sanitizeExternalError(result.spawnError)}`,
      "infra",
      "infrastructure",
    );
  }
  if (result.signal !== null) {
    const cancelled = new Set(["SIGHUP", "SIGINT", "SIGTERM"]).has(
      result.signal,
    );
    throw new AgentscrapeDiscoveryError(
      `agentscrape discovery terminated by ${result.signal}`,
      cancelled ? "cancelled" : "infra",
      cancelled ? "cancellation" : "infrastructure",
    );
  }
  return result;
}

async function assertLiveFeedCapability(
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  const result = await runDiscoveryCommand(
    ["discover-feed", "--help"],
    Math.min(timeoutMs, 5_000),
    signal,
  );
  if (
    result.status !== 0 ||
    !/^Usage:\s+agentscrape\s+discover-feed\s+\[FILE\]\s+--source-url\s+URL\b/m.test(
      result.stdout,
    )
  ) {
    throw new AgentscrapeDiscoveryError(
      "installed agentscrape lacks live discover-feed capability",
      "auth_config",
      "auth_config",
    );
  }
}

export async function discoverFeedWithAgentscrape(
  request: FeedDiscoveryRequest,
): Promise<FeedDiscoveryEnvelope> {
  const sourceUrl = normalizedWebUrl(request.sourceUrl);
  const timeoutMs = positiveInteger(
    request.timeoutMs ?? AGENTSCRAPE_DEFAULT_TIMEOUT_MS,
    "agentscrape feed discovery timeout",
    300_000,
  );
  const maxPages = positiveInteger(request.maxPages, "feed page limit", 100);
  const maxItems = positiveInteger(request.maxItems, "feed item limit", 10_000);
  if (request.recordedInputFile === undefined) {
    await assertLiveFeedCapability(timeoutMs, request.signal);
  }
  const args = ["discover-feed"];
  if (request.recordedInputFile !== undefined) {
    args.push(request.recordedInputFile);
  }
  args.push(
    "--source-url",
    sourceUrl,
    "--source-kind",
    request.sourceKind ?? "auto",
    "--max-response-bytes",
    String(request.maxResponseBytes ?? 2_000_000),
    "--max-pages",
    String(maxPages),
    "--max-items",
    String(maxItems),
    "--timeout-seconds",
    String(Math.max(0.001, timeoutMs / 1_000)),
    "--format",
    "json",
  );
  const validators =
    request.recordedInputFile === undefined
      ? request.validators
      : request.recordedValidators === undefined
        ? undefined
        : {
            etag: request.recordedValidators.etag ?? null,
            lastModified: request.recordedValidators.lastModified ?? null,
          };
  if (validators?.etag != null) {
    args.push("--etag", validators.etag);
  }
  if (validators?.lastModified != null) {
    args.push("--last-modified", validators.lastModified);
  }
  if (
    request.recordedInputFile === undefined &&
    request.validatorUrl !== undefined &&
    (validators?.etag != null || validators?.lastModified != null)
  ) {
    args.push("--validator-url", normalizedWebUrl(request.validatorUrl));
  }
  if (request.since !== undefined) args.push("--since", request.since);
  const result = await runDiscoveryCommand(args, timeoutMs, request.signal);
  let decoded: unknown;
  try {
    decoded = JSON.parse(result.stdout) as unknown;
  } catch {
    if (result.status !== 0) {
      throw discoveryCommandFailure(
        result.stderr,
        "agentscrape feed discovery",
      );
    }
    return discoveryProtocol("feed discovery command returned malformed JSON");
  }
  const envelope = validateFeedDiscoveryEnvelope(decoded, sourceUrl, {
    maxItems,
    maxPages,
  });
  if ((envelope.status === "failure") !== (result.status !== 0)) {
    return discoveryProtocol(
      "feed discovery status disagrees with command exit",
    );
  }
  return envelope;
}

export async function discoverXTimelineWithAgentscrape(
  request: XTimelineDiscoveryRequest,
): Promise<XTimelineDiscoveryEnvelope> {
  const url = normalizedWebUrl(request.url);
  const timeoutMs = positiveInteger(
    request.timeoutMs ?? AGENTSCRAPE_DEFAULT_TIMEOUT_MS,
    "agentscrape X discovery timeout",
    AGENTSCRAPE_TIMEOUT_MAX_MS,
  );
  const limit = positiveInteger(request.limit, "X timeline item limit", 10_000);
  const maxScrolls = positiveInteger(
    request.maxScrolls,
    "X timeline scroll limit",
    100,
  );
  const args = [
    "fetch-links",
    url,
    "--preset",
    "x-timeline",
    "--limit",
    String(limit),
    "--max-scrolls",
    String(maxScrolls),
    "--json",
  ];
  if (request.sinceId !== undefined) {
    if (!/^\d+$/.test(request.sinceId)) {
      return discoveryProtocol("X since_id is invalid");
    }
    args.push("--since-id", request.sinceId);
  }
  if (request.includeReplies === true) args.push("--include-replies");
  if (request.includeReposts === true) args.push("--include-reposts");
  const result = await runDiscoveryCommand(args, timeoutMs, request.signal);
  if (result.status !== 0) {
    throw discoveryCommandFailure(result.stderr, "agentscrape X discovery");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(result.stdout) as unknown;
  } catch {
    return discoveryProtocol("X discovery command returned malformed JSON");
  }
  return validateXTimelineDiscoveryEnvelope(decoded, request.handle, {
    maxItems: limit,
  });
}

export const sourceDiscoveryWithAgentscrape: SourceDiscoveryProvider = {
  discoverFeed: discoverFeedWithAgentscrape,
  discoverXTimeline: discoverXTimelineWithAgentscrape,
};
