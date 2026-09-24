# 23. Render the reference from one discovery snapshot

Status: accepted, 2026-09-24. Extends [ADR 0009](0009-serve-docs-with-owner.md)'s live reference and preserves the `docs_list` and `docs_get` operations described in [ADR 0006](0006-live-package-api-reference.md).

The `api` Package API exposes `docs_snapshot`, a typed document for every configured Package API produced by one catalog load. The HTML and Markdown reference and its revision check use one snapshot per request, avoiding the previous list call followed by a full catalog rebuild for each package. Existing `docs_list` and `docs_get` callers retain their contracts. No cache is needed, so edits to configuration still appear on the next request.

The complete response must fit the socket's one-million-character line limit. Tests measure the serialized response with headroom; if the workspace grows near that bound, the snapshot contract needs pagination or another bounded transfer before the reference can safely expand.
