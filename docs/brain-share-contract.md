# Share ingest JSON contract (v1)

The share ingress is one endpoint shared by every device client. It is served by
the owner-managed `brain` Package API under
[ADR 0059](adr/0059-isolated-brain-and-platform-clients.md).

```text
POST http://<agentstack-host>:8877/v1/share
GET  http://<agentstack-host>:8877/v1/shares?job_ids=1,2,3
GET  http://<agentstack-host>:8877/v1/health
```

Every data and health request requires `Authorization: Bearer <token>`.
Unauthenticated `OPTIONS` requests return only CORS preflight metadata;
network reachability is not authorization. The local `share_token_reveal`
operation requires `{ "reveal": true }`; `share_token_rotate` immediately
replaces the token accepted by the listener. Neither operation is exposed by
this device listener.

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
| `client` | yes | `chrome-extension` or `android-share`. Becomes the durable job `ingress`. |
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
The ingress owns no storage of its own.

## Success response

```json
{
  "schema_version": 1,
  "ok": true,
  "command": "share /v1/share",
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
  },
  "meta": {
    "db_path": "/Users/you/.local/state/agentstack/brain/research.db",
    "read_only": false,
    "generated_at": "2026-08-01T16:26:13.876Z"
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
  "command": "share /v1/shares",
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
reported as missing. The bearer token authorizes instance-wide status reads;
job IDs are not individually bound to a client. No
locator, title, or body is ever returned: a client asking about its own shares
already has the content it sent.

## Errors

Errors use the standard AgentStack Brain error envelope:

```json
{
  "schema_version": 1,
  "ok": false,
  "command": "share /v1/share",
  "error": { "code": "bad_payload", "message": "…", "recovery": "…" }
}
```

| HTTP | Code | Cause |
| --- | --- | --- |
| 400 | `bad_payload` | Not JSON, not an object, missing/unknown `client`, no `url` or `text`, wrong field type, oversized field, malformed `job_ids`. |
| 400 | `bad_source` | `url` is not a usable http(s) locator. |
| 400 | `unsupported_version` | `version` is not `1`. |
| 401 | `unauthorized` | Missing or non-matching bearer token. |
| 404 | `not_found` | Unknown path. |
| 405 | `method_not_allowed` | Wrong method for the route. |
| 409 | `idempotency_conflict` | An explicit `idempotency_key` already names a different intent. |
| 413 | `payload_too_large` | Body exceeds 1 MiB, or more than 50 `job_ids`. |
| 415 | `unsupported_media_type` | `Content-Type` is not JSON. |
| 500 | `share_failed` | Unexpected server fault. Details are logged locally, never returned. |

A 4xx other than 401 means the payload is wrong and must not be resent
unchanged. A 401 means the token is wrong. A 500 or a connection failure is
safely retryable — replays deduplicate.

## Cross-origin behavior

`OPTIONS` preflight is answered for `chrome-extension://` origins only, and the
allowed origin is echoed rather than wildcarded, so a web page on the tailnet
cannot read share responses. A Chrome MV3 service worker holding a host
permission does not need CORS at all; the preflight support exists for
completeness.

## Disclosure

Request logs contain method, path, HTTP status, a safe outcome label, and job id
only. Shared URLs, titles, text bodies, and the token never appear in logs.
