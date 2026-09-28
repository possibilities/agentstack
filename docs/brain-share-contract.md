# Share ingest JSON contract (v1)

**Access migration:** device requests now use the shared [Access ingress](access.md)
and a short-lived Brain audience credential. The payload/admission semantics
below remain v1; the old shared token is retired. Access responses contain
`schema_version`, `ok`, and `data` (no server-local database path). Status reads
are filtered by durable client/job admission receipts, including duplicate
admissions. The old Brain listener is loopback-only with an ephemeral internal
liveness credential. It is not a device connection URL. See
[ADR 0091](adr/0091-shared-access-and-direct-tailnet-ingress.md).

The share ingress is shared by every paired device client. Its remote routes are
declared by the owner-managed `access` Package API; Brain owns admission and job
state through `packages/brain/api.ts` and `packages/brain/src/share-server.ts`;
the common HTTP listener implementation lives in `packages/api/src/http.ts`.
The live `docs_snapshot` Package API and UIX API reference publish the HTTP
wire schemas (including the `idempotency_key` request spelling, query string,
success/error envelopes), formats and per-origin authentication policy. These
are distinct from the share operations' normalized internal inputs.

```text
POST https://<tailnet-host>:8943/v1/share
GET  https://<tailnet-host>:8943/v1/shares?job_ids=1,2,3
GET  https://<tailnet-host>:8943/v1/health
```

Every data and health request requires an Access Brain audience bearer token
and `X-AgentStack-Server-ID` matching its paired server, over direct verified
tailnet traffic. `OPTIONS` returns only CORS metadata but
also requires tailnet provenance. `share_token_reveal` and `share_token_rotate`
are removed; pair and revoke through Access instead.

## Request

`POST /v1/share` with `Content-Type: application/json` and a body of at most
1 MiB:

```json
{
  "version": 1,
  "client": "chrome-extension",
  "url": "https://example.com/article",
  "title": "Example article",
  "tags": ["reading"],
  "collections": ["saved-links"],
  "idempotency_key": null
}
```

| Field | Required | Meaning |
| --- | --- | --- |
| `version` | no | Contract version; defaults to `1`. Any other value is rejected. |
| `client` | no | Access sets this from the approved Client kind, overriding any supplied value. Becomes the durable job `ingress`. |
| `url` | one of | An http(s) locator. Credentialed URLs are rejected. |
| `text` | one of | Free text, up to 100,000 characters. |
| `title` | no | Up to 500 characters. |
| `tags` | no | Up to 32 strings, normalized by the usual tag rules. |
| `collections` | no | Up to 32 names. Defaults to `["saved-links"]`. |
| `idempotency_key` | no | Overrides the derived key. Up to 200 characters. |

At least one of `url` or `text` must be present.

## Resolution

The server, not the client, decides what was shared:

1. If `url` is present, it is the locator and `text` is ignored.
2. Otherwise `text` is scanned for the **first** valid http(s) URL. Trailing
   prose punctuation (`.,;:!?`) and unmatched closing brackets are stripped, so
   `worth reading https://example.com/post, really` resolves to
   `https://example.com/post` while `/wiki/Foo_(bar)` is preserved intact.
3. If no URL is found, the payload is admitted as a text job.

Taking the first URL is a deliberate policy. Android places no contract on how
an app lays out `EXTRA_TEXT`; Chromium currently appends the URL after any
selected text, but that ordering is sender- and version-specific rather than
guaranteed.

The resolved intent is passed to the same `admitSubmission` path Package API submission uses.
Access stores client/job admission receipts, not a separate ingestion queue.

## Success response

```json
{
  "schema_version": 1,
  "ok": true,
  "data": {
    "version": 1,
    "client": "chrome-extension",
    "status": "queued",
    "job_id": 41,
    "idempotency_key": "submit:v1:f6fdcae2…",
    "intent_hash": "f6fdcae2…",
    "state": "queued",
    "resolved_kind": "url",
    "resolved_url": "https://example.com/article",
    "extracted_from_text": false,
    "collections": ["saved-links"],
    "tags": ["reading"]
  }
}
```

`status` is `queued` for a new intent and `duplicate` for a replay of an
identical one. **Both are HTTP 200 and both are successes**: a duplicate means
AgentStack Brain already holds that exact intent as the job named by `job_id`, so a
client that retries after a timeout cannot create a second job.

`resolved_url` is `null` for text jobs. A text body is never echoed back.

## Share states

`GET /v1/shares?job_ids=1,2,3` answers what became of jobs the client already
holds acknowledgements for. It is additive to v1 and read-only: a client written
against the original contract never calls it and is unaffected.

```json
{
  "schema_version": 1,
  "ok": true,
  "data": {
    "version": 1,
    "shares": [
      { "job_id": 4321, "state": "completed", "failure_class": null, "document_id": 970 }
    ]
  }
}
```

| Field | Meaning |
| --- | --- |
| `job_id` | The job identity `/v1/share` returned. |
| `state` | Ledger state: `queued`, `running`, `retry_wait`, `blocked`, `failed`, `completed`, `excluded`, `cancelled`. |
| `failure_class` | Safe class label when an attempt failed, else `null`. A `blocked` or `failed` job carrying one is stranded (see [Brain operations](brain.md)). |
| `document_id` | The Document the job produced, once one exists, else `null`. |

At most 50 ids per request, deduplicated, and `job_ids` may be omitted for an
empty answer. An id with no matching job is absent from `shares` rather than
reported as missing. Access returns only IDs admitted by this client, based on
durable admission receipts, including duplicate admissions. No
locator, title, or body is ever returned: a client asking about its own shares
already has the content it sent.

## Errors

Errors use the Access error envelope:

```json
{
  "schema_version": 1,
  "ok": false,
  "error": { "code": "bad_payload", "message": "…" }
}
```

| HTTP | Code | Cause |
| --- | --- | --- |
| 400 | `bad_payload` | Not JSON, not an object, no `url` or `text`, wrong field type, oversized field, malformed or excessive `job_ids`. |
| 400 | `bad_source` | `url` is not a usable http(s) locator. |
| 400 | `unsupported_version` | `version` is not `1`. |
| 401 | `unauthorized` | Missing, expired, revoked or wrong-audience Access token. |
| 403 | `tailnet_required`, `tailnet_unverified`, `insufficient_scope` | Direct tailnet provenance or explicit scope is missing. Keep held content for connection recovery. |
| 404 | `not_found` | Unknown path. |
| 405 | `method_not_allowed` | Wrong method for the route. |
| 409 | `idempotency_conflict` | An explicit `idempotency_key` already names a different intent. |
| 409 | `server_identity_mismatch` | The server differs from the paired destination; do not retarget held shares. |
| 413 | `payload_too_large` | Body exceeds 1 MiB. |
| 415 | `json_required` | `Content-Type` is not JSON. |
| 429 | `verification_capacity`, `pairing_capacity` | Bounded ingress capacity is occupied; retry later. |
| 503 | `service_unavailable` | A backend or verification dependency is unavailable. |

Validation failures require payload correction. Authentication, permissions,
tailnet, or destination failures keep held content for explicit recovery.
Capacity failures, 5xx responses and connection failures are safely retryable;
admission replays deduplicate.

## Cross-origin behavior

`OPTIONS` preflight is answered for `chrome-extension://` origins only, and the
allowed origin is echoed rather than wildcarded, so a web page on the tailnet
cannot read share responses. A Chrome MV3 service worker holding a host
permission does not need CORS at all; the preflight support exists for
completeness.

## Disclosure

Request logs contain method, path, HTTP status, a safe outcome label, and job id
only. Shared URLs, titles, text bodies, and the token never appear in logs.
