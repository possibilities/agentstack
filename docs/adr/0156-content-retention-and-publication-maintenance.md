# 0156 — Content retention disclosure and publication maintenance

## Status

Accepted, following human-approved 07·D1 (disclosure only). Extends
[0135](0135-owner-state-maintenance.md); no Git history rewrite or external erasure.

## Decision

- `content_vault_history_plan` is read-only disclosure, **not** `StatePlan` admission
  for an erasure action. It lists every exact-slug path/commit/blob in commits
  reachable from all local refs/reflogs, including unchanged and deleted paths.
  Revision-paged output never includes bodies or credential-bearing remote URLs.
  Remote names/presence are disclosed; unreachable objects, renamed different
  slugs, external clones/backups and shallow older history are unobservable.
  Exceeding bounded inspection refuses rather than silently truncating coverage.
  No reconciliation, Git initialization, staging, commit, push or network occurs.
- Writable publishing admits unique temporary claims in `wiki/artifacts/publications.sqlite`
  before bytes, recording writer PID and directory incarnation. Portable bundles
  stage under `wiki/collections/publish/<UUID>`; CAS writes under
  `wiki/artifacts/cas/.publication-<UUID>/payload`. Successful publication releases
  its claim. A crash never schedules replay. The Artifact manifest schema and
  structurally read-only Artifact retrieval remain unchanged.
- Collection selects exact claims only, requires definitely absent writer PID,
  rechecks directory incarnation/file snapshots, and refuses symlink/special
  content. PID reuse stays conservatively blocked. Unattributed legacy UUID /
  `<hash>.staging.<pid>` paths and quarantine/recovery evidence are not adopted.
  The immutable CAS is addressable only through its hash-sharded objects; neither
  manifest references nor upload/item references point at these temporary paths.
- Use Content's existing maintenance journal/receipt getter. Persist admission
  before descriptor-relative removal; interruption is partial/unknown and never
  redispatches. Permanent publication claim/collected tombstones survive cleanup
  and reject same-path recreation. Published/source bytes, reference authority,
  Vault/Git, other destinations and external backups remain untouched.
- Operations require a trusted-local operator, are excluded from MCP and refused
  remotely. Content invalidation follows apply. Existing record schemas remain;
  new UI is a separate handoff, not implicitly added.

## Consequences

Ordinary document tombstoning is never represented as erasure. Known abandoned
publication bytes can be removed without weakening live publication recovery or
adopting unknown old directories. Legacy/unproven paths need future explicit
provenance recovery, not a blanket filesystem sweep. Device-local reset is a
separate proposed client contract, not a Server deletion operation.
