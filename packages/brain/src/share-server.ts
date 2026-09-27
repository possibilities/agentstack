import { admitSubmission } from "./admission.js";
import type { Server } from "node:http";
import { operation, serveHttp } from "@agentstack/api";
import { z } from "zod";
import { ArtifactStore } from "./artifacts.js";
import { CliError } from "./errors.js";
import { shareJobStates } from "./jobs.js";
import {
  bearerToken,
  parseShareRequest,
  parseShareStateIds,
  resolveShare,
  SHARE_CONTRACT_VERSION,
  SHARE_DEFAULT_HOST,
  SHARE_DEFAULT_PORT,
  SHARE_MAX_BODY_BYTES,
  SHARE_MAX_STATE_IDS,
  tokenMatches,
} from "./share.js";
import { shareUrlFor } from "./share-liveness.js";
import type { ResearchStore } from "./store.js";
import type { AdmissionStatus } from "./types.js";

export interface ShareServerOptions {
  store: ResearchStore;
  token: string | (() => string);
  host?: string;
  port?: number;
  artifactStore?: ArtifactStore;
  maxBodyBytes?: number;
  /** Invoked once per settled request for operational logging. */
  onEvent?: (event: ShareServerEvent) => void;
}

export interface ShareServerEvent {
  method: string;
  path: string;
  status: number;
  /** Safe outcome label; never contains shared content or the token. */
  outcome: string;
  job_id?: number;
}

export interface ShareIngestData {
  version: typeof SHARE_CONTRACT_VERSION;
  client: string;
  status: AdmissionStatus;
  job_id: number;
  idempotency_key: string;
  intent_hash: string;
  state: string;
  resolved_kind: "url" | "text";
  /** Present only for URL jobs; a text body is never echoed back. */
  resolved_url: string | null;
  extracted_from_text: boolean;
  collections: string[];
  tags: string[];
}

const normalizedShare = z.object({
  version: z.literal(SHARE_CONTRACT_VERSION), client: z.enum(["chrome-extension", "android-share"]),
  url: z.string().optional(), text: z.string().optional(), title: z.string().optional(),
  tags: z.array(z.string()), collections: z.array(z.string()), idempotencyKey: z.string().optional(),
});
const shareData = z.object({
  version: z.literal(SHARE_CONTRACT_VERSION), client: z.enum(["chrome-extension", "android-share"]),
  status: z.enum(["queued", "duplicate"]), job_id: z.number().int(), idempotency_key: z.string(),
  intent_hash: z.string(), state: z.string(), resolved_kind: z.enum(["url", "text"]),
  resolved_url: z.string().nullable(), extracted_from_text: z.boolean(),
  collections: z.array(z.string()), tags: z.array(z.string()),
});

/** Explicit HTTP-only operations. They are not in Brain's socket/MCP/WebSocket
 * operation list, and a route must name one to expose it to device clients. */
export const shareHealth = operation({
  name: "share_health", description: "Check authenticated device-share ingress health and contract version.",
  input: z.strictObject({}), output: z.object({ version: z.literal(SHARE_CONTRACT_VERSION), ok: z.literal(true) }),
  annotations: { readOnlyHint: true },
  async call() { return { version: SHARE_CONTRACT_VERSION, ok: true } as const; },
});

export const shareStates = operation({
  name: "share_states", description: "Read bounded job states for IDs retained by a device share client.",
  input: z.strictObject({ ids: z.array(z.number().int().positive()).max(SHARE_MAX_STATE_IDS) }),
  output: z.object({ version: z.literal(SHARE_CONTRACT_VERSION), shares: z.array(z.object({
    job_id: z.number().int(), state: z.enum(["queued", "running", "retry_wait", "blocked", "failed", "completed", "excluded", "cancelled"]),
    failure_class: z.string().nullable(), document_id: z.number().int().nullable(),
  })) }),
  annotations: { readOnlyHint: true },
  async call(ctx: ShareServerOptions, { ids }) { return { version: SHARE_CONTRACT_VERSION, shares: shareJobStates(ctx.store, ids) }; },
});

export const shareAdmit = operation({
  name: "share_admit", description: "Resolve and durably admit one authenticated device share; admission does not imply indexing completion.",
  input: normalizedShare, output: shareData,
  async call(ctx: ShareServerOptions, parsed) {
    const resolved = resolveShare(parsed);
    const admitted = admitSubmission(ctx.store, {
      version: 1, source: resolved.source, kind: resolved.kind, ingress: resolved.ingress,
      collections: resolved.collections, tags: resolved.tags,
      ...(resolved.title === undefined ? {} : { title: resolved.title }),
      ...(resolved.idempotencyKey === undefined ? {} : { idempotencyKey: resolved.idempotencyKey }),
    }, { artifactStore: ctx.artifactStore ?? new ArtifactStore() });
    return {
      version: SHARE_CONTRACT_VERSION, client: resolved.ingress, status: admitted.status,
      job_id: admitted.job_id, idempotency_key: admitted.idempotency_key, intent_hash: admitted.intent_hash,
      state: admitted.state, resolved_kind: resolved.kind,
      resolved_url: resolved.kind === "url" ? resolved.source : null,
      extracted_from_text: resolved.extractedFromText, collections: resolved.collections, tags: resolved.tags,
    };
  },
});

export const shareRoutes = [
  { method: "GET", path: "/v1/health", operation: shareHealth },
  { method: "GET", path: "/v1/shares", operation: shareStates },
  { method: "POST", path: "/v1/share", operation: shareAdmit },
] as const;

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

/**
 * Error codes map onto HTTP status so clients can distinguish a retryable
 * server fault from a payload they must not resend unchanged.
 */
const STATUS_BY_CODE: Record<string, number> = {
  bad_payload: 400,
  bad_source: 400,
  unsupported_version: 400,
  unauthorized: 401,
  not_found: 404,
  method_not_allowed: 405,
  payload_too_large: 413,
  unsupported_media_type: 415,
  idempotency_conflict: 409,
};

function corsHeaders(origin: string | null): Record<string, string> {
  // Only extension origins are echoed. A browser page on the tailnet must not
  // be able to read responses, and `*` would allow exactly that.
  if (origin === null || !origin.startsWith("chrome-extension://")) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "authorization, content-type",
    "access-control-max-age": "600",
    vary: "origin",
  };
}

function jsonResponse(
  body: unknown,
  status: number,
  origin: string | null,
): Response {
  return new Response(`${JSON.stringify(body, null, 2)}\n`, {
    status,
    headers: { ...JSON_HEADERS, ...corsHeaders(origin) },
  });
}

function okBody(command: string, data: unknown, dbPath: string): unknown {
  return {
    schema_version: 1,
    ok: true,
    command,
    data,
    meta: {
      db_path: dbPath,
      read_only: false,
      generated_at: new Date().toISOString(),
    },
  };
}

function errorBody(command: string, error: CliError): unknown {
  return {
    schema_version: 1,
    ok: false,
    command,
    error: {
      code: error.code,
      message: error.message,
      ...(error.recovery === undefined ? {} : { recovery: error.recovery }),
    },
  };
}

function httpStatusFor(error: CliError): number {
  return STATUS_BY_CODE[error.code] ?? 500;
}

async function readJsonBody(
  request: Request,
  maxBytes: number,
): Promise<unknown> {
  const declared = request.headers.get("content-length");
  if (declared !== null && Number(declared) > maxBytes) {
    throw new CliError(
      "payload_too_large",
      `share payload exceeds ${maxBytes} bytes`,
    );
  }
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new CliError(
      "unsupported_media_type",
      "share payload must be sent as application/json",
    );
  }
  const chunks: Uint8Array[] = [];
  let length = 0;
  const reader = request.body?.getReader();
  if (reader) {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > maxBytes) {
          void reader.cancel().catch(() => {});
          throw new CliError("payload_too_large", `share payload exceeds ${maxBytes} bytes`);
        }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
  }
  const raw = Buffer.concat(chunks, length);
  try {
    return JSON.parse(new TextDecoder().decode(raw));
  } catch {
    throw new CliError("bad_payload", "share payload is not valid JSON");
  }
}

/**
 * Builds the request handler. Exported separately from `startShareServer` so
 * tests can exercise the full routing, authentication, and admission seam
 * without binding a socket.
 */
export function createShareHandler(
  options: ShareServerOptions,
): (request: Request) => Promise<Response> {
  const { store, token } = options;
  const artifactStore = options.artifactStore ?? new ArtifactStore();
  const maxBodyBytes = options.maxBodyBytes ?? SHARE_MAX_BODY_BYTES;
  const dbPath = store.dbPath;
  const emit = options.onEvent ?? (() => {});

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const origin = request.headers.get("origin");
    const command = `share ${path}`;

    const settle = (response: Response, outcome: string, jobId?: number) => {
      emit({
        method: request.method,
        path,
        status: response.status,
        outcome,
        ...(jobId === undefined ? {} : { job_id: jobId }),
      });
      return response;
    };

    if (request.method === "OPTIONS") {
      return settle(
        new Response(null, { status: 204, headers: corsHeaders(origin) }),
        "preflight",
      );
    }

    try {
      const presented = bearerToken(request.headers.get("authorization"));
      if (presented === null || !tokenMatches(typeof token === "function" ? token() : token, presented)) {
        throw new CliError("unauthorized", "a valid bearer token is required", {
          recovery:
            "Send Authorization: Bearer <token> from the share token file.",
        });
      }

      if (!shareRoutes.some((route) => route.path === path)) throw new CliError("not_found", `unknown share endpoint ${path}`);
      if (!shareRoutes.some((route) => route.path === path && route.method === request.method))
        throw new CliError("method_not_allowed", `${request.method} is not allowed on ${path}`);

      if (path === "/v1/health") {
        const data = shareHealth.output.parse(await shareHealth.call(options, shareHealth.input.parse({})));
        return settle(jsonResponse(okBody(command, data, dbPath), 200, origin), "health");
      }

      // What became of the shares this client already sent. Read-only, and
      // bounded to ids the client received from its own acknowledgements.
      if (path === "/v1/shares") {
        const ids = parseShareStateIds(url.searchParams.get("job_ids"));
        const data = shareStates.output.parse(await shareStates.call(options, shareStates.input.parse({ ids })));
        return settle(jsonResponse(okBody(command, data, dbPath), 200, origin), "states");
      }

      if (path !== "/v1/share") throw new CliError("not_found", `unknown share endpoint ${path}`);
      const parsed = parseShareRequest(await readJsonBody(request, maxBodyBytes));
      const data: ShareIngestData = shareAdmit.output.parse(await shareAdmit.call({ ...options, artifactStore }, shareAdmit.input.parse(parsed)));
      return settle(
        jsonResponse(okBody(command, data, dbPath), 200, origin),
        data.status,
        data.job_id,
      );
    } catch (error) {
      const cliError =
        error instanceof CliError
          ? error
          : new CliError(
              "share_failed",
              "share ingestion failed; see the server log",
            );
      const status = httpStatusFor(cliError);
      if (!(error instanceof CliError)) {
        // Unexpected faults are logged locally but never echoed to the client,
        // which could be any peer on the tailnet.
        console.error("[Brain share] unexpected request failure");
      }
      return settle(
        jsonResponse(errorBody(command, cliError), status, origin),
        cliError.code,
      );
    }
  };
}

export interface RunningShareServer {
  server: Server;
  port: number;
  url: string;
  stop: () => Promise<void>;
}

export async function startShareServer(
  options: ShareServerOptions,
): Promise<RunningShareServer> {
  const hostname = options.host ?? SHARE_DEFAULT_HOST;
  const port = options.port ?? SHARE_DEFAULT_PORT;
  let served: Awaited<ReturnType<typeof serveHttp>>;
  try {
    served = await serveHttp({ host: hostname, port, handle: createShareHandler(options), requestTimeout: 30_000, headersTimeout: 10_000,
      forceCloseConnections: true,
      onError: () => new Response(JSON.stringify({ schema_version: 1, ok: false, command: "share", error: { code: "share_failed", message: "share ingestion failed" } }), {
        status: 500, headers: JSON_HEADERS,
      }),
    });
  } catch (error) {
    throw new CliError(
      "share_bind_failed",
      `cannot bind ${shareUrlFor(hostname, port)}: ${(error as Error).message}`,
      {
        recovery:
          "Check whether another listener holds the port and whether the configured address exists on a local interface.",
      },
    );
  }
  return {
    server: served.server,
    port: served.port,
    url: shareUrlFor(hostname, served.port),
    stop: served.close,
  };
}
