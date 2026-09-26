/**
 * Shared configuration and transport for the AgentStack share extension.
 *
 * The extension is deliberately thin: it reports what the browser observed and
 * lets the server resolve the ingestion intent. See docs/brain-share-contract.md.
 */

export const SHARE_CLIENT = "chrome-extension";
export const SHARE_VERSION = 1;
export const CONFIG_KEY = "agentstack.chrome.share.config.v1";
export const DEFAULT_SERVER_URL = "http://127.0.0.1:8877";

export function normalizeServerUrl(value) {
  const url = new URL(value.trim());
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("Use an http(s) server URL without credentials, a query, or a fragment.");
  }
  return url.href.replace(/\/+$/, "");
}

export async function readConfig() {
  const stored = await chrome.storage.local.get({ [CONFIG_KEY]: {} });
  return stored[CONFIG_KEY];
}

/**
 * A share that has not answered in this long is treated as unreachable rather
 * than left in flight. The outbox will try it again, and the ingress
 * deduplicates a request that did in fact land.
 */
const SHARE_TIMEOUT_MS = 15_000;

/** Device-local configuration; credentials are never synced to another browser. */
export async function loadConfig() {
  const stored = await readConfig();
  const serverUrl = (stored.serverUrl || "").trim().replace(/\/+$/, "");
  const token = (stored.token || "").trim();
  if (serverUrl === "" || token === "") return null;
  return { serverUrl, token };
}

export function shareEndpoint(serverUrl) {
  return `${serverUrl}/v1/share`;
}

export function statesEndpoint(serverUrl) {
  return `${serverUrl}/v1/shares`;
}

export function healthEndpoint(serverUrl) {
  return `${serverUrl}/v1/health`;
}

/**
 * Chrome only allows a background fetch to a host the extension holds a
 * permission for. The server address is user-configured, so the permission is
 * requested for that exact origin instead of being declared broadly up front.
 */
export function originPatternFor(serverUrl) {
  return `${new URL(serverUrl).origin}/*`;
}

export async function hasHostPermission(serverUrl) {
  return chrome.permissions.contains({
    origins: [originPatternFor(serverUrl)],
  });
}

/**
 * POSTs one share payload and normalizes the outcome.
 *
 * Returns {ok, status, code, message, data}. A duplicate is a success: the
 * server recognized an already-queued intent and returned the same job.
 */
export async function postShare(config, payload) {
  let response;
  try {
    response = await fetch(shareEndpoint(config.serverUrl), {
      method: "POST",
      signal: AbortSignal.timeout(SHARE_TIMEOUT_MS),
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.token}`,
      },
      body: JSON.stringify({
        version: SHARE_VERSION,
        client: SHARE_CLIENT,
        ...payload,
      }),
    });
  } catch {
    return {
      ok: false,
      status: 0,
      code: "unreachable",
      message: `Cannot reach ${config.serverUrl}. Check the connection and AgentStack Brain share listener.`,
    };
  }

  let body = null;
  try {
    body = await response.json();
  } catch {
    // A non-JSON body is still reported through the HTTP status below.
  }

  const receipt = body?.data;
  const identity = receipt?.status === "already_indexed" ? receipt.document_id : receipt?.job_id;
  if (response.ok && body?.ok && ["queued", "duplicate", "already_indexed"].includes(receipt?.status) && Number.isSafeInteger(identity) && identity > 0) {
    return { ok: true, status: response.status, data: body.data };
  }
  if (response.ok) {
    return { ok: false, status: 0, code: "invalid_receipt", message: "The server did not confirm admission. Held for a safe retry." };
  }
  return {
    ok: false,
    status: response.status,
    code: body?.error?.code ?? `http_${response.status}`,
    message:
      body?.error?.message ??
      `AgentStack rejected the share (HTTP ${response.status}).`,
    recovery: body?.error?.recovery,
  };
}

/**
 * Asks the ingress what became of jobs it already acknowledged. Read-only and
 * best effort: an ingress that is down leaves the popover showing what the
 * client itself knows, which is never wrong, only less complete.
 */
export async function fetchShareStates(config, jobIds) {
  if (jobIds.length === 0) return { ok: true, states: [] };
  let response;
  try {
    response = await fetch(
      `${statesEndpoint(config.serverUrl)}?job_ids=${jobIds.join(",")}`,
      {
        method: "GET",
        signal: AbortSignal.timeout(SHARE_TIMEOUT_MS),
        headers: { authorization: `Bearer ${config.token}` },
      },
    );
  } catch {
    return { ok: false, states: [] };
  }
  if (!response.ok) return { ok: false, states: [] };
  try {
    const body = await response.json();
    if (body?.ok !== true || !Array.isArray(body.data?.shares)) return { ok: false, states: [] };
    return { ok: true, states: body.data.shares };
  } catch {
    return { ok: false, states: [] };
  }
}

/**
 * Whether a failed share is worth sending again unchanged, per share-ingest-v1:
 * a connection failure or a server fault is safely retryable, and a 4xx other
 * than 401 means the payload itself is wrong and never will be.
 *
 * 401 is retryable on purpose. A rejected token is a configuration fault the
 * user can repair, and discarding what they shared in the meantime is the one
 * outcome the outbox exists to prevent.
 */
export function isRetryable(result) {
  if (result.ok) return false;
  if (result.status === 0) return true;
  if (result.status >= 500) return true;
  return (
    result.status === 401 || result.status === 408 || result.status === 429
  );
}
