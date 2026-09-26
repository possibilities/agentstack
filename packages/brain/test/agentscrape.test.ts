import { spawn, spawnSync } from "./process.js";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, test } from "node:test";
import { expect } from "expect";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentscrapeExtractionError,
  discoverFeedWithAgentscrape,
  discoverXTimelineWithAgentscrape,
  extractWithAgentscrape,
  scrapeWithAgentscrape,
  validateExtractionEnvelope,
  validateFeedDiscoveryEnvelope,
} from "../src/agentscrape.js";

const dirs: string[] = [];
const originalPath = process.env.PATH;
const originalInitialDelay =
  process.env.AGENTSTACK_BRAIN_AGENTSCRAPE_RETRY_INITIAL_MS;
const originalMaxDelay = process.env.AGENTSTACK_BRAIN_AGENTSCRAPE_RETRY_MAX_MS;

afterEach(() => {
  process.env.PATH = originalPath;
  if (originalInitialDelay === undefined) {
    delete process.env.AGENTSTACK_BRAIN_AGENTSCRAPE_RETRY_INITIAL_MS;
  } else {
    process.env.AGENTSTACK_BRAIN_AGENTSCRAPE_RETRY_INITIAL_MS = originalInitialDelay;
  }
  if (originalMaxDelay === undefined) {
    delete process.env.AGENTSTACK_BRAIN_AGENTSCRAPE_RETRY_MAX_MS;
  } else {
    process.env.AGENTSTACK_BRAIN_AGENTSCRAPE_RETRY_MAX_MS = originalMaxDelay;
  }
  delete process.env.LOG;
  delete process.env.COUNT_FILE;
  delete process.env.CHILD_PID_FILE;
  delete process.env.PROVIDER_PID_FILE;
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "agentstack-brain-agentscrape-"));
  dirs.push(dir);
  return dir;
}

function executablePath(dir: string): string {
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  process.env.PATH = `${bin}:${originalPath}`;
  return join(bin, "agentscrape");
}

function writeExecutable(path: string, script: string): void {
  writeFileSync(path, script);
  chmodSync(path, 0o755);
}

interface ProcessSnapshot {
  state: string;
  identity: string;
  processGroup: number;
}

function linuxProcSnapshot(pid: number): ProcessSnapshot | null {
  try {
    const value = readFileSync(`/proc/${pid}/stat`, "utf8");
    const commandEnd = value.lastIndexOf(") ");
    if (commandEnd < 0) return null;
    const command = value.slice(value.indexOf("(") + 1, commandEnd);
    const fields = value
      .slice(commandEnd + 2)
      .trim()
      .split(/\s+/);
    const state = fields[0];
    const processGroup = Number(fields[2]);
    const startedAt = fields[19];
    return state === undefined || startedAt === undefined
      ? null
      : {
          state,
          identity: `${startedAt} ${processGroup} ${command}`,
          processGroup,
        };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function processSnapshot(pid: number): ProcessSnapshot | null {
  let stat: ReturnType<typeof spawnSync>;
  try {
    stat = spawnSync({
      cmd: [
        "ps",
        "-ww",
        "-o",
        "stat=",
        "-o",
        "lstart=",
        "-o",
        "pgid=",
        "-o",
        "command=",
        "-p",
        String(pid),
      ],
      stdout: "pipe",
      stderr: "ignore",
    });
  } catch (error) {
    if (
      process.platform === "linux" &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return linuxProcSnapshot(pid);
    }
    throw error;
  }
  if (stat.exitCode !== 0) return null;
  const fields = new TextDecoder().decode(stat.stdout).trim().split(/\s+/);
  const state = fields.shift();
  const processGroup = Number(fields[5]);
  return state === undefined
    ? null
    : { state, identity: fields.join(" "), processGroup };
}

async function waitForProcessExit(
  pid: number,
  expectedIdentity?: string,
  attempts = 200,
  delayMs = 50,
): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const snapshot = processSnapshot(pid);
    if (
      snapshot === null ||
      snapshot.state.includes("Z") ||
      (expectedIdentity !== undefined && snapshot.identity !== expectedIdentity)
    ) {
      return true;
    }
    await sleep(delayMs);
  }
  return false;
}

function installAgentscrape(script: string): {
  dir: string;
  executable: string;
} {
  const dir = tempDir();
  const executable = executablePath(dir);
  writeExecutable(executable, script);
  return { dir, executable };
}

function extractionEnvelope(
  requestedUrl: string,
  content = "# Extracted\n\nBody",
): Record<string, unknown> {
  return {
    schema_version: "1",
    status: "success",
    requested_url: requestedUrl,
    final_url: `${requestedUrl}/final`,
    extractor: {
      name: "agentscrape",
      version: "1.2.3",
      implementation: "generic-page",
      implementation_version: "1",
    },
    artifacts: [
      {
        artifact_type: "document",
        media_type: "text/markdown",
        encoding: "utf-8",
        content,
        size_bytes: Buffer.byteLength(content),
        sha256: createHash("sha256").update(content).digest("hex"),
      },
    ],
    metadata: {
      content_type: "web_page",
      title: "Extracted",
      author_name: "",
      author_handle: "",
      published_at: "",
      source_id: "",
      warnings: [],
    },
    relations: [
      {
        relation_type: "content_link",
        target_url: "https://reference.example/item",
      },
    ],
    failure: null,
  };
}

function shellLiteral(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

const DEFAULT_AGENTSCRAPE_CONTRACT_FIXTURE = join(
  import.meta.dirname,
  "../../test/fixtures",
  "extraction-generic.expected.json",
);

const AGENTSCRAPE_CONTRACT_FIXTURE =
  process.env.AGENTSCRAPE_CONTRACT_FIXTURE ??
  DEFAULT_AGENTSCRAPE_CONTRACT_FIXTURE;

function assertCompatibleFixture(
  label: string,
  path: string,
  expectedUrl: string,
): void {
  if (!existsSync(path)) {
    throw new Error(`${label} contract fixture is missing: ${path}`);
  }
  const payload = JSON.parse(readFileSync(path, "utf8")) as unknown;
  try {
    const envelope = validateExtractionEnvelope(payload, expectedUrl);
    expect(envelope.status).toBe("success");
  } catch (error) {
    throw new Error(
      `${label} contract fixture is incompatible with agentstack-brain: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

test("recorded Agentscrape extraction fixtures match agentstack-brain's envelope contract", () => {
  assertCompatibleFixture(
    "Agentscrape generic",
    AGENTSCRAPE_CONTRACT_FIXTURE,
    "https://example.com/start",
  );
});

test("accepts optional parser-derived X content classification", () => {
  const url = "https://x.com/example/status/123";
  const payload = extractionEnvelope(url);
  payload.final_url = url;
  payload.extractor = {
    ...(payload.extractor as Record<string, unknown>),
    implementation: "x-tweet",
  };
  payload.metadata = {
    ...(payload.metadata as Record<string, unknown>),
    content_type: "social_post",
    content_kind: "thread",
    content_item_count: 2,
    source_id: "123",
  };
  const envelope = validateExtractionEnvelope(payload, url);
  expect(envelope.status).toBe("success");
  expect(envelope.metadata).toMatchObject({
    content_kind: "thread",
    content_item_count: 2,
  });

  const invalid = structuredClone(payload);
  (invalid.metadata as Record<string, unknown>).content_item_count = 1;
  expect(() => validateExtractionEnvelope(invalid, url)).toThrow(
    "thread metadata must contain at least two items",
  );

  const missingCount = structuredClone(payload);
  delete (missingCount.metadata as Record<string, unknown>).content_item_count;
  expect(() => validateExtractionEnvelope(missingCount, url)).toThrow(
    "content kind and item count must be provided together",
  );

  const mismatchedExtractor = structuredClone(payload);
  (mismatchedExtractor.extractor as Record<string, unknown>).implementation =
    "generic-page";
  expect(() => validateExtractionEnvelope(mismatchedExtractor, url)).toThrow(
    "content classification does not match its extractor",
  );
});

test("incompatible extraction envelope changes are protocol defects", () => {
  const url = "https://example.com/contract";
  const base = extractionEnvelope(url);
  const missingFailure = { ...base };
  delete (missingFailure as Record<string, unknown>).failure;
  const cases: Array<[string, Record<string, unknown>, string]> = [
    [
      "schema version",
      { ...base, schema_version: "2" },
      "extraction schema version is unsupported",
    ],
    [
      "provider fields",
      { ...base, status_code: 200 },
      "extraction envelope has unknown or missing fields",
    ],
    [
      "extractor identity",
      {
        ...base,
        extractor: {
          ...(base.extractor as Record<string, unknown>),
          name: "browserctl",
        },
      },
      "extractor name is unsupported",
    ],
    [
      "missing failure sentinel",
      missingFailure,
      "extraction envelope has unknown or missing fields",
    ],
  ];
  for (const [label, payload, message] of cases) {
    try {
      expect(() => validateExtractionEnvelope(payload, url)).toThrow(
        `agentscrape protocol defect: ${message}`,
      );
    } catch (error) {
      throw new Error(
        `${label} did not fail as a clear protocol defect: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
});

test("versioned extraction uses explicit argv and validates the success envelope", async () => {
  const url = "https://example.com/article";
  const envelope = extractionEnvelope(url);
  const { dir } = installAgentscrape(`#!/bin/sh
printf '%s\\n' "$@" > "$LOG"
printf '%s' ${shellLiteral(JSON.stringify(envelope))}
`);
  const log = join(dir, "extraction-argv.txt");
  process.env.LOG = log;

  const result = await extractWithAgentscrape(url, {
    maxContentBytes: 1000,
    maxRelations: 3,
  });

  expect(readFileSync(log, "utf8")).toBe(
    "fetch-markdown\nhttps://example.com/article\n--envelope\n--allow-private-network\n--max-content-bytes\n1000\n--max-relations\n3\n",
  );
  expect(result).toMatchObject({
    status: "success",
    final_url: "https://example.com/article/final",
    metadata: { title: "Extracted" },
  });
});

test("feed and X discovery use bounded explicit Agentscrape argv", async () => {
  const sourceUrl = "https://blog.example/feed.xml";
  const feed = {
    schema_version: "1",
    status: "success",
    source_url: sourceUrl,
    source_format: "rss",
    validators: { etag: '"v1"', last_modified: null },
    cursor: {
      validators: { etag: '"v1"', last_modified: null },
      newest_seen_at: null,
      next_url: null,
    },
    items: [],
    pagination: {
      pages: [
        {
          url: sourceUrl,
          page_format: "rss",
          validators: { etag: '"v1"', last_modified: null },
          item_count: 0,
          next_url: null,
        },
      ],
      complete: true,
      stop_reason: "exhausted",
      next_url: null,
    },
    warnings: [
      {
        code: "naive_date_assumed_utc",
        message: "A timezone-free entry date was interpreted as UTC.",
      },
    ],
    absence_implies_deletion: false,
    failure: null,
  };
  const { dir, executable } = installAgentscrape(`#!/bin/sh
printf '%s\\n' "$@" > "$LOG"
printf '%s' ${shellLiteral(JSON.stringify(feed))}
`);
  const input = join(dir, "feed.xml");
  writeFileSync(input, "<rss/>");
  process.env.LOG = join(dir, "feed-argv.txt");
  const feedResult = await discoverFeedWithAgentscrape({
    sourceUrl,
    recordedInputFile: input,
    maxPages: 2,
    maxItems: 7,
  });
  expect(feedResult.pagination.complete).toBe(true);
  expect(feedResult.warnings[0]?.page_url).toBeNull();
  expect(readFileSync(process.env.LOG, "utf8")).toContain(
    `discover-feed\n${input}\n--source-url\n${sourceUrl}\n`,
  );

  const notModified = {
    ...feed,
    source_format: "unknown",
    validators: { etag: '"prior"', last_modified: null },
    cursor: {
      validators: { etag: '"prior"', last_modified: null },
      newest_seen_at: null,
      next_url: null,
    },
    pagination: {
      pages: [],
      complete: true,
      stop_reason: "not_modified",
      next_url: null,
    },
  };
  writeExecutable(
    executable,
    `#!/bin/sh\nif [ "$2" = "--help" ]; then\n  printf 'Usage: agentscrape discover-feed [FILE] --source-url URL [OPTIONS]\\n'\n  exit 0\nfi\nprintf '%s\\n' "$@" > "$LOG"\nprintf '%s' ${shellLiteral(JSON.stringify(notModified))}\n`,
  );
  process.env.LOG = join(dir, "live-feed-argv.txt");
  const liveFeedResult = await discoverFeedWithAgentscrape({
    sourceUrl,
    validators: {
      etag: '"prior"',
      lastModified: "Wed, 22 Jul 2026 00:00:00 GMT",
    },
    validatorUrl: sourceUrl,
    maxPages: 2,
    maxItems: 7,
  });
  expect(liveFeedResult.pagination).toMatchObject({
    complete: true,
    stop_reason: "not_modified",
  });
  expect(readFileSync(process.env.LOG, "utf8")).toBe(
    `discover-feed\n--source-url\n${sourceUrl}\n--source-kind\nauto\n--max-response-bytes\n2000000\n--max-pages\n2\n--max-items\n7\n--timeout-seconds\n120\n--format\njson\n--etag\n"prior"\n--last-modified\nWed, 22 Jul 2026 00:00:00 GMT\n--validator-url\n${sourceUrl}\n`,
  );

  const liveFailureCases = [
    ["unsafe_source_url", "policy", false],
    ["unsafe_destination", "policy", false],
    ["transport_policy_violation", "policy", false],
    ["unsupported_encoding", "unsupported_encoding", false],
    ["malformed_response", "malformed_response", false],
    ["redirect_error", "redirect_error", false],
    ["redirect_limit_exceeded", "redirect_limit", false],
    ["invalid_utf8", "malformed_response", false],
    ["feed_not_discovered", "feed_discovery", false],
    ["unsupported_media_type", "unsupported_source", false],
    ["network_error", "network_error", true],
    ["http_error", "http_error", true],
  ] as const;
  await expect(
    discoverFeedWithAgentscrape({
      sourceUrl,
      timeoutMs: 300_001,
      maxPages: 2,
      maxItems: 7,
    }),
  ).rejects.toThrow("feed discovery timeout");

  for (const [code, stopReason, retryable] of liveFailureCases) {
    const validated = validateFeedDiscoveryEnvelope(
      {
        ...notModified,
        status: "failure",
        pagination: {
          pages: [],
          complete: false,
          stop_reason: stopReason,
          next_url: null,
        },
        failure: { code, retryable, message: "classified live failure" },
      },
      sourceUrl,
    );
    expect(validated.failure).toMatchObject({ code, retryable });
  }

  const timeline = {
    handle: "person",
    next_cursor: "123",
    scraped_at: "2026-07-20T00:00:00.000Z",
    tweets: [],
    warnings: [],
  };
  writeExecutable(
    executable,
    `#!/bin/sh\nprintf '%s\\n' "$@" > "$LOG"\nprintf '%s' ${shellLiteral(JSON.stringify(timeline))}\n`,
  );
  process.env.LOG = join(dir, "x-argv.txt");
  const xResult = await discoverXTimelineWithAgentscrape({
    url: "https://x.com/person",
    handle: "person",
    sinceId: "456",
    limit: 8,
    maxScrolls: 3,
  });
  expect(xResult.next_cursor).toBe("123");
  expect(readFileSync(process.env.LOG, "utf8")).toBe(
    "fetch-links\nhttps://x.com/person\n--preset\nx-timeline\n--limit\n8\n--max-scrolls\n3\n--json\n--since-id\n456\n",
  );
});

test("live feed discovery rejects a recorded-only Agentscrape deployment", async () => {
  installAgentscrape(`#!/bin/sh
if [ "$2" = "--help" ]; then
  printf 'Usage: agentscrape discover-feed FILE --source-url URL [OPTIONS]\\n'
  exit 0
fi
exit 1
`);
  await expect(
    discoverFeedWithAgentscrape({
      sourceUrl: "https://blog.example/feed.xml",
      maxPages: 2,
      maxItems: 10,
    }),
  ).rejects.toMatchObject({
    disposition: "auth_config",
    outcome: "auth_config",
  });
});

test("classified extraction failures map without parsing stderr", async () => {
  const url = "https://example.com/failure";
  const { executable } = installAgentscrape("#!/bin/sh\nexit 1\n");
  const cases = [
    ["upstream_unavailable", true, "infra", "infrastructure", 1],
    ["browser_error", true, "item_transient", "item", 1],
    ["authentication_required", false, "auth_config", "auth_config", 2],
    ["provider_error", false, "permanent", "permanent", 1],
    ["invalid_request", false, "permanent", "policy", 1],
    ["cancelled", false, "cancelled", "cancellation", 130],
  ] as const;

  for (const [
    failureClass,
    retryable,
    disposition,
    outcome,
    exitCode,
  ] of cases) {
    const envelope = {
      ...extractionEnvelope(url),
      status: "failure",
      final_url: null,
      artifacts: [],
      metadata: null,
      relations: [],
      failure: {
        failure_class: failureClass,
        retryable,
        message: "classified failure",
        evidence: "Cookie: secret-value",
      },
    };
    writeExecutable(
      executable,
      `#!/bin/sh\nprintf '%s\\n' 'stderr must not classify this' >&2\nprintf '%s' ${shellLiteral(JSON.stringify(envelope))}\nexit ${exitCode}\n`,
    );
    let caught: unknown;
    try {
      await extractWithAgentscrape(url);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AgentscrapeExtractionError);
    expect(caught).toMatchObject({ disposition, outcome });
    expect(String(caught)).not.toContain("secret-value");
    expect(String(caught)).not.toContain("stderr must not classify");
  }
});

test("malformed and unknown envelopes are visible protocol defects", async () => {
  const { executable } = installAgentscrape(`#!/bin/sh
printf '%s' '{"schema_version":"99"}'
`);
  await expect(
    extractWithAgentscrape("https://example.com/protocol"),
  ).rejects.toMatchObject({ disposition: "permanent", outcome: "protocol" });

  writeExecutable(executable, "#!/bin/sh\nprintf '%s' 'not-json'\n");
  await expect(
    extractWithAgentscrape("https://example.com/protocol"),
  ).rejects.toThrow("protocol defect");

  const url = "https://example.com/unsupported-relation";
  const unsupported = {
    ...extractionEnvelope(url),
    relations: [
      {
        relation_type: "reply",
        target_url: "https://x.com/i/status/123",
      },
    ],
  };
  writeExecutable(
    executable,
    `#!/bin/sh\nprintf '%s' ${shellLiteral(JSON.stringify(unsupported))}\n`,
  );
  await expect(extractWithAgentscrape(url)).rejects.toThrow(
    "relation type is unsupported",
  );
});

test("Agentscrape adapter resolves PATH and requests final Markdown with explicit argv", async () => {
  const { dir } = installAgentscrape(`#!/bin/sh
printf '%s\n' "$@" > "$LOG"
printf '%s\n' '# Provider markdown'
`);
  const log = join(dir, "argv.txt");
  process.env.LOG = log;

  const result = await scrapeWithAgentscrape(
    "https://twitter.com/person/status/123?from=request#section",
    { maxMarkdownBytes: 1000, maxMarkdownCodePoints: 1000 },
  );

  expect(readFileSync(log, "utf8")).toBe(
    "fetch-markdown\n--markdown\nhttps://twitter.com/person/status/123?from=request\n",
  );
  expect(result).toMatchObject({
    url: "https://twitter.com/person/status/123?from=request",
    requested_url: "https://twitter.com/person/status/123?from=request",
    markdown: "# Provider markdown\n",
  });
});

test("Agentscrape Markdown stdout is accepted without provider-schema parsing", async () => {
  installAgentscrape(`#!/bin/sh
printf '%s\n' '# Article title' '' 'Final **Markdown** from Agentscrape.'
`);

  const result = await scrapeWithAgentscrape("https://example.com/article");
  expect(result.markdown).toBe(
    "# Article title\n\nFinal **Markdown** from Agentscrape.\n",
  );
  expect(result.content).toBe(result.markdown);
});

test("transient provider failures retry with bounded exponential delays and resume", async () => {
  const { dir } = installAgentscrape(`#!/bin/sh
count=0
if [ -f "$COUNT_FILE" ]; then count=$(cat "$COUNT_FILE"); fi
count=$((count + 1))
printf '%s' "$count" > "$COUNT_FILE"
if [ "$count" -eq 1 ]; then
  printf '%s\n' 'failed to acquire browser from browserctl' >&2
  exit 7
fi
if [ "$count" -eq 2 ]; then
  printf '%s\n' 'browser backend unavailable token=retry-secret' >&2
  exit 7
fi
printf '%s\n' 'resumed markdown'
`);
  const countFile = join(dir, "count");
  process.env.COUNT_FILE = countFile;
  const delays: number[] = [];
  const diagnostics: string[] = [];

  const result = await scrapeWithAgentscrape("https://example.com/resumed", {
    retry: {
      maxAttempts: 4,
      initialDelayMs: 5,
      maxDelayMs: 8,
      sleep: (delay) => {
        delays.push(delay);
      },
      writeDiagnostic: (message) => diagnostics.push(message),
    },
  });

  expect(result.markdown).toBe("resumed markdown\n");
  expect(readFileSync(countFile, "utf8")).toBe("3");
  expect(delays).toEqual([5, 8]);
  expect(diagnostics).toHaveLength(2);
  expect(diagnostics.join(" ")).not.toContain("retry-secret");
  expect(diagnostics.join(" ")).not.toContain("token=");
  expect(diagnostics.join(" ")).not.toContain("backend unavailable");
});

test("retry delay environment overrides are bounded away from hot loops and overflow", async () => {
  const dir = tempDir();
  process.env.PATH = join(dir, "missing-bin");
  process.env.AGENTSTACK_BRAIN_AGENTSCRAPE_RETRY_INITIAL_MS = "0";
  process.env.AGENTSTACK_BRAIN_AGENTSCRAPE_RETRY_MAX_MS = "999999999999999999999";
  const fallbackDelays: number[] = [];

  await expect(
    scrapeWithAgentscrape("https://example.com/down", {
      retry: {
        maxAttempts: 2,
        sleep: (delay) => {
          fallbackDelays.push(delay);
        },
        writeDiagnostic: () => {},
      },
    }),
  ).rejects.toThrow("not installed on PATH");
  expect(fallbackDelays).toEqual([1000]);

  process.env.AGENTSTACK_BRAIN_AGENTSCRAPE_RETRY_INITIAL_MS = "100";
  process.env.AGENTSTACK_BRAIN_AGENTSCRAPE_RETRY_MAX_MS = "3600000";
  const configuredDelays: number[] = [];
  await expect(
    scrapeWithAgentscrape("https://example.com/down", {
      retry: {
        maxAttempts: 2,
        sleep: (delay) => {
          configuredDelays.push(delay);
        },
        writeDiagnostic: () => {},
      },
    }),
  ).rejects.toThrow("not installed on PATH");
  expect(configuredDelays).toEqual([100]);
});

test("a real Agentscrape agent-browser timeout is retried", async () => {
  const { dir } = installAgentscrape(`#!/bin/sh
count=0
if [ -f "$COUNT_FILE" ]; then count=$(cat "$COUNT_FILE"); fi
count=$((count + 1))
printf '%s' "$count" > "$COUNT_FILE"
if [ "$count" -eq 1 ]; then
  printf '%s\n' 'Browser error: agent-browser timed out after 30s' >&2
  exit 1
fi
printf '%s\n' 'recovered after browser timeout'
`);
  const countFile = join(dir, "count");
  process.env.COUNT_FILE = countFile;
  const delays: number[] = [];

  const result = await scrapeWithAgentscrape("https://example.com/timeout", {
    retry: {
      maxAttempts: 2,
      initialDelayMs: 7,
      maxDelayMs: 7,
      sleep: (delay) => {
        delays.push(delay);
      },
      writeDiagnostic: () => {},
    },
  });
  expect(result.markdown).toBe("recovered after browser timeout\n");
  expect(readFileSync(countFile, "utf8")).toBe("2");
  expect(delays).toEqual([7]);
});

test("an executable initially absent is found on a later retry", async () => {
  const dir = tempDir();
  const executable = executablePath(dir);
  process.env.PATH = join(dir, "bin");
  const delays: number[] = [];

  const result = await scrapeWithAgentscrape("https://example.com/appeared", {
    retry: {
      maxAttempts: 2,
      initialDelayMs: 0,
      maxDelayMs: 0,
      sleep: async (delay) => {
        delays.push(delay);
        writeExecutable(
          executable,
          "#!/bin/sh\nprintf '%s\\n' 'provider appeared'\n",
        );
        await sleep(1);
      },
      writeDiagnostic: () => {},
    },
  });

  expect(result.markdown).toBe("provider appeared\n");
  expect(delays).toEqual([0]);
});

test("permanent auth and input failures do not retry", async () => {
  const { dir } = installAgentscrape(`#!/bin/sh
printf x >> "$COUNT_FILE"
printf '%s\n' 'authentication required: Authorization: Bearer top.secret' >&2
exit 7
`);
  const countFile = join(dir, "count");
  process.env.COUNT_FILE = countFile;
  const delays: number[] = [];

  await expect(
    scrapeWithAgentscrape("https://example.com/failure", {
      retry: {
        maxAttempts: 5,
        sleep: (delay) => {
          delays.push(delay);
        },
        writeDiagnostic: () => {},
      },
    }),
  ).rejects.toThrow("agentscrape provider failed");
  expect(readFileSync(countFile, "utf8")).toBe("x");
  expect(delays).toEqual([]);

  writeExecutable(
    join(dir, "bin", "agentscrape"),
    `#!/bin/sh\nprintf x >> "$COUNT_FILE"\nprintf '%s\\n' 'invalid input URL' >&2\nexit 2\n`,
  );
  await expect(
    scrapeWithAgentscrape("https://example.com/failure", {
      retry: { maxAttempts: 5, sleep: () => {}, writeDiagnostic: () => {} },
    }),
  ).rejects.toThrow("invalid input");
  expect(readFileSync(countFile, "utf8")).toBe("xx");
});

test("per-attempt timeout is transient and obeys the injected attempt cap", async () => {
  const { dir } = installAgentscrape(`#!/bin/sh
printf x >> "$COUNT_FILE"
exec sleep 5
`);
  const countFile = join(dir, "count");
  process.env.COUNT_FILE = countFile;
  const delays: number[] = [];

  await expect(
    scrapeWithAgentscrape("https://example.com/slow", {
      timeoutMs: 100,
      retry: {
        maxAttempts: 2,
        initialDelayMs: 1,
        maxDelayMs: 1,
        sleep: (delay) => {
          delays.push(delay);
        },
        writeDiagnostic: () => {},
      },
    }),
  ).rejects.toThrow("timed out");
  expect(readFileSync(countFile, "utf8")).toBe("xx");
  expect(delays).toEqual([1]);
});

test("provider timeout terminates the Agentscrape process group", async () => {
  const { dir } = installAgentscrape(`#!/bin/sh
sh -c 'trap "" TERM; exec sleep 30' &
printf '%s' "$!" > "$CHILD_PID_FILE"
wait
`);
  const pidFile = join(dir, "child.pid");
  process.env.CHILD_PID_FILE = pidFile;

  await expect(
    scrapeWithAgentscrape("https://example.com/process-tree", {
      timeoutMs: 500,
      retry: { maxAttempts: 1, writeDiagnostic: () => {} },
    }),
  ).rejects.toThrow("timed out");

  const descendantPid = Number(readFileSync(pidFile, "utf8"));
  expect(Number.isInteger(descendantPid)).toBe(true);
  const alive = !(await waitForProcessExit(descendantPid));
  if (alive) {
    try {
      process.kill(descendantPid, "SIGKILL");
    } catch {
      // It exited between the final probe and cleanup.
    }
  }
  expect(alive).toBe(false);
});

test("extraction abort kills detached Agentscrape descendants", async () => {
  if (process.platform === "win32") return;
  const { dir } = installAgentscrape(`#!/bin/sh
sh -c 'trap "" HUP INT TERM; exec sleep 30' &
printf '%s' "$!" > "$CHILD_PID_FILE"
wait
`);
  const pidFile = join(dir, "extraction-child.pid");
  process.env.CHILD_PID_FILE = pidFile;
  const controller = new AbortController();
  const pending = extractWithAgentscrape("https://example.com/cancel", {
    signal: controller.signal,
    timeoutMs: 30_000,
  });

  for (let attempt = 0; attempt < 1_000 && !existsSync(pidFile); attempt += 1) {
    await sleep(10);
  }
  if (!existsSync(pidFile)) {
    controller.abort();
    await pending.catch(() => {});
    throw new Error(
      "provider fixture did not start for extraction cancellation",
    );
  }
  const descendantPid = Number(readFileSync(pidFile, "utf8"));
  controller.abort();
  await expect(pending).rejects.toMatchObject({
    disposition: "cancelled",
    outcome: "cancellation",
  });

  const alive = !(await waitForProcessExit(descendantPid));
  if (alive) {
    try {
      process.kill(descendantPid, "SIGKILL");
    } catch {
      // It exited between the final probe and cleanup.
    }
  }
  expect(alive).toBe(false);
});

test("parent cancellation kills detached Agentscrape descendants and preserves signal exits", async () => {
  if (process.platform === "win32") return;
  const { dir } = installAgentscrape(`#!/bin/sh
printf '%s' "$$" > "$PROVIDER_PID_FILE"
sh -c 'trap "" HUP INT TERM; exec sleep 30' &
printf '%s' "$!" > "$CHILD_PID_FILE"
wait
`);
  const providerPidFile = join(dir, "provider.pid");
  process.env.PROVIDER_PID_FILE = providerPidFile;

  const parentScript = join(dir, "provider-parent.ts");
  writeFileSync(
    parentScript,
    `import { scrapeWithAgentscrape } from ${JSON.stringify(join(import.meta.dirname, "..", "src", "agentscrape.js"))};\nawait scrapeWithAgentscrape("https://example.com/cancel");\n`,
  );

  for (const [signal, expectedExitCode] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const) {
    const pidFile = join(dir, `${signal}.pid`);
    process.env.CHILD_PID_FILE = pidFile;
    const parent = spawn({
      cmd: [process.execPath, parentScript],
      cwd: join(import.meta.dirname, ".."),
      env: { ...process.env, PATH: process.env.PATH },
      stdout: "ignore",
      stderr: "pipe",
    });

    for (
      let attempt = 0;
      attempt < 1_000 && !existsSync(pidFile);
      attempt += 1
    ) {
      await sleep(10);
    }
    if (!existsSync(pidFile)) {
      parent.kill("SIGKILL");
      await parent.exited;
      throw new Error(`provider fixture did not start for ${signal}`);
    }
    const providerPid = Number(readFileSync(providerPidFile, "utf8"));
    const descendantPid = Number(readFileSync(pidFile, "utf8"));
    const descendant = processSnapshot(descendantPid);
    const descendantIdentity = descendant?.identity;
    expect(descendantIdentity).toBeDefined();
    expect(descendant?.processGroup).toBe(providerPid);
    parent.kill(signal);
    const exitCode = await parent.exited;

    const alive = !(await waitForProcessExit(
      descendantPid,
      descendantIdentity,
    ));
    const descendantAfterWait = processSnapshot(descendantPid);
    if (alive) {
      try {
        process.kill(descendantPid, "SIGKILL");
      } catch {
        // It exited between the final probe and cleanup.
      }
    }
    expect(exitCode).toBe(expectedExitCode);
    expect(alive).toBe(false);
  }
});

test("empty and oversized Markdown plus oversized command output fail without retry", async () => {
  const { dir, executable } = installAgentscrape(`#!/bin/sh
printf x >> "$COUNT_FILE"
printf '   '
`);
  const countFile = join(dir, "count");
  process.env.COUNT_FILE = countFile;
  const retry = {
    maxAttempts: 4,
    sleep: () => {},
    writeDiagnostic: () => {},
  };

  await expect(
    scrapeWithAgentscrape("https://example.com/empty", { retry }),
  ).rejects.toThrow("empty markdown");
  expect(readFileSync(countFile, "utf8")).toBe("x");

  writeExecutable(
    executable,
    `#!/bin/sh\nprintf x >> "$COUNT_FILE"\nprintf '0123456789'\n`,
  );
  await expect(
    scrapeWithAgentscrape("https://example.com/large", {
      maxMarkdownBytes: 5,
      maxMarkdownCodePoints: 5,
      retry,
    }),
  ).rejects.toThrow("exceeds max_bytes");
  expect(readFileSync(countFile, "utf8")).toBe("xx");

  writeExecutable(
    executable,
    `#!/bin/sh\nprintf x >> "$COUNT_FILE"\nprintf '%0200d' 0\n`,
  );
  await expect(
    scrapeWithAgentscrape("https://example.com/output", {
      maxOutputBytes: 32,
      retry,
    }),
  ).rejects.toThrow("max_output_bytes");
  expect(readFileSync(countFile, "utf8")).toBe("xxx");
});
