import { admitSubmission } from "./admission.js";
import { createServer, type Server } from "node:http";
import { Readable } from "node:stream";
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

      if (path === "/v1/health") {
        if (request.method !== "GET") {
          throw new CliError(
            "method_not_allowed",
            `${request.method} is not allowed on ${path}`,
          );
        }
        return settle(
          jsonResponse(
            okBody(
              command,
              { version: SHARE_CONTRACT_VERSION, ok: true },
              dbPath,
            ),
            200,
            origin,
          ),
          "health",
        );
      }

      // What became of the shares this client already sent. Read-only, and
      // bounded to ids the client received from its own acknowledgements.
      if (path === "/v1/shares") {
        if (request.method !== "GET") {
          throw new CliError(
            "method_not_allowed",
            `${request.method} is not allowed on ${path}`,
          );
        }
        const ids = parseShareStateIds(url.searchParams.get("job_ids"));
        const states = shareJobStates(store, ids);
        return settle(
          jsonResponse(
            okBody(
              command,
              { version: SHARE_CONTRACT_VERSION, shares: states },
              dbPath,
            ),
            200,
            origin,
          ),
          "states",
        );
      }

      if (path !== "/v1/share") {
        throw new CliError("not_found", `unknown share endpoint ${path}`);
      }
      if (request.method !== "POST") {
        throw new CliError(
          "method_not_allowed",
          `${request.method} is not allowed on ${path}`,
        );
      }

      const parsed = parseShareRequest(
        await readJsonBody(request, maxBodyBytes),
      );
      const resolved = resolveShare(parsed);
      const admitted = admitSubmission(
        store,
        {
          version: 1,
          source: resolved.source,
          kind: resolved.kind,
          ingress: resolved.ingress,
          collections: resolved.collections,
          tags: resolved.tags,
          ...(resolved.title === undefined ? {} : { title: resolved.title }),
          ...(resolved.idempotencyKey === undefined
            ? {}
            : { idempotencyKey: resolved.idempotencyKey }),
        },
        { artifactStore },
      );

      const data: ShareIngestData = {
        version: SHARE_CONTRACT_VERSION,
        client: resolved.ingress,
        status: admitted.status,
        job_id: admitted.job_id,
        idempotency_key: admitted.idempotency_key,
        intent_hash: admitted.intent_hash,
        state: admitted.state,
        resolved_kind: resolved.kind,
        resolved_url: resolved.kind === "url" ? resolved.source : null,
        extracted_from_text: resolved.extractedFromText,
        collections: resolved.collections,
        tags: resolved.tags,
      };
      return settle(
        jsonResponse(okBody(command, data, dbPath), 200, origin),
        admitted.status,
        admitted.job_id,
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
  const handler = createShareHandler(options);
  const server = createServer(async (incoming, outgoing) => {
    try {
      const headers = new Headers();
      for (const [key, value] of Object.entries(incoming.headers)) {
        if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(", ") : value);
      }
      const hasBody = incoming.method !== "GET" && incoming.method !== "HEAD";
      const request = new Request(`${shareUrlFor(hostname, port)}${incoming.url ?? "/"}`, {
        method: incoming.method, headers,
        ...(hasBody ? { body: Readable.toWeb(incoming) as ReadableStream<Uint8Array>, duplex: "half" } : {}),
      });
      const response = await handler(request);
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      // Reject unauthenticated bodies without draining an unbounded stream.
      if (!incoming.complete) outgoing.once("finish", () => incoming.destroy());
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      if (!outgoing.headersSent) outgoing.writeHead(500, JSON_HEADERS);
      outgoing.end(JSON.stringify({ schema_version: 1, ok: false, command: "share", error: { code: "share_failed", message: "share ingestion failed" } }));
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, hostname, () => { server.off("error", reject); resolve(); });
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
  const actualPort = (server.address() as { port: number }).port;
  return {
    server,
    port: actualPort,
    url: shareUrlFor(hostname, actualPort),
    stop: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    }),
  };
}
