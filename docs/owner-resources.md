# Owner resource observations

`owner_resources` and `owner_resource_history` are read-only operations on the existing owner socket, MCP and WebSocket Transports. `owner_status` is unchanged. Subscribe to the payload-free `resources_changed` Event, then re-read after subscription and every invalidation. There is no UI resource presentation or new UI subscription.

## Read and drill down

Socket examples (one JSON object per line):

```json
{"id":1,"method":"tools/call","params":{"name":"owner_resources","arguments":{}}}
{"id":2,"method":"events/subscribe","params":{"topics":["resources_changed"]}}
```

The default selects `scopeId: "total"` and returns up to 50 scope summaries. `scope` always summarizes the full selection, independently of pagination. `observation` describes measurement freshness, source, capture time, monotonic age, collection duration, last attempt/error and coverage. `host` describes the same captured host context. The sampler starts with the owner API context; a first read can await its initial bounded attempt, but reads never request fresh collection.

Use returned IDs rather than constructing them. Scope kinds are:

| Kind | Meaning |
| --- | --- |
| `total` | All observed owned process identities, each counted once. |
| `component` | The owner itself and otherwise unnamed owner descendants, or one named required child and its descendants. Components partition the total. |
| `bot` | One Bot's observed app-server subtree, including its tools and MCP children; nested labelled roots have their own domain attribution. |
| `account` | Bot-account or Worker-account costs, with separate ID namespaces. Does not merge independently managed sign-ins. |
| `runtime` | One account-bound ACP launch and its descendants. Shared by all Worker sessions in that runtime. |
| `process` | Exactly one OS process, identified by PID and OS birth token. |
| `subtree` | That process plus surviving observed descendants, including retained ancestry after reparenting. |

`view: "scopes"` lists domain rollups within the selection. Optional `kind` filters them; `kind: "process"` or `"subtree"` lists process self or subtree summaries instead. `view: "processes"` lists member processes with both `self` and `subtree` metrics, parent identities, attribution and CPU interval state. Subtree fields always describe the process's full observed ancestry subtree, which can include a nested, differently labelled domain. Scope kinds and subtrees overlap: **do not sum arbitrary result rows**. Use the returned selected `scope.metrics`, sum process `self` metrics, or sum the disjoint component scopes.

For example, after discovering a returned Bot scope ID:

```json
{"id":3,"method":"tools/call","params":{"name":"owner_resources","arguments":{"scopeId":"bot:bot-1","view":"processes","limit":25}}}
```

Each process row has `id` for its own costs and `subtreeId` for inclusive costs. Select either as `scopeId` for subsequent reads/history. A process ID is stable for its observed OS birth; domain/account/component IDs remain stable across process replacements, and runtime IDs distinguish launches.

### Consistent pagination

Take `observation.snapshotId` from the first page and pass it on every subsequent page with `page.nextOffset`. A positive offset requires a snapshot ID. `limit` is 1–100, default 50; a response is bounded below the socket's one-million-character limit even with maximum-length record fields. All pages and rollups in a pinned snapshot use the same immutable sample. Unknown/expired snapshot or scope IDs are errors, never empty zero-cost success. Restart loses all snapshot IDs. Retry expired pagination from a new first page.

```json
{"id":4,"method":"tools/call","params":{"name":"owner_resources","arguments":{"snapshotId":"<returned snapshotId>","scopeId":"total","view":"processes","offset":25,"limit":25}}}
```

## Metrics and availability

| Field | Units and interpretation |
| --- | --- |
| `rssBytes` | Resident set bytes, summed across member processes. Shared pages are counted repeatedly; this is **not unique physical RAM**. |
| `virtualBytes` | Virtual address-space bytes; not committed or resident memory. macOS values can be very large. |
| `cpuTimeMs` | Cumulative self user+system CPU milliseconds of currently observed members. Does not include reaped-child CPU; can decrease as group membership changes. |
| `cpuPercent` | Sum of per-process cumulative CPU deltas divided by monotonic elapsed wall time × 100. 100% = one logical core; greater than 100% is valid. Null if any member lacks a valid interval. |
| `cpuMeasuredProcessCount` | Members with a usable CPU interval; compare with `processCount` before drawing an aggregate CPU chart. |
| `cpuIntervalMs`, `cpuStatus` | Process-specific elapsed interval and `measured`, `warmup` or `reset`. A new/reused PID, missing baseline, nonpositive elapsed time or falling counter cannot establish interval CPU. |
| `threads` | Linux OS thread count, summed; unavailable on this macOS collector. |

`null` is unavailable/unknown, never zero. `capabilities` explicitly reports unsupported thread, disk I/O, file-descriptor, network, GPU and per-session-allocation measurements. CPU after a collection gap averages over the longer interval between successful observations; do not reinterpret it as an exact five-second interval. CPU quantization follows the OS source (macOS `ps` time, Linux clock ticks).

`host.logicalCpuCount`, `totalMemoryBytes`, `freeMemoryBytes` and the 1/5/15-minute `loadAverage` are host-wide context, not stack totals. Free memory is not available/reclaimable memory. Linux values describe the OS/proc namespace and are not a promise of cgroup limits. Remote inference, provider services, disk-space consumption and other machines are outside the census.

## Freshness, history and failure

The default cycle is five seconds, with one attempt in flight and a four-second cancellation budget. `ps` has a three-second subprocess timeout and 8 MiB output cap. Domain reads run concurrently with collection, each with a one-second socket timeout and the existing response-size cap. Linux filesystem concurrency is 16. Enumeration is limited to 20,000 host processes and 2,048 owned processes; exceeding a cap fails the attempt rather than returning silently truncated totals. Sampler subprocesses are excluded and counted in coverage; sampler work performed by the owner itself remains part of its costs.

An attempt failure preserves the last good snapshot with `freshness: "stale"`, the new `lastAttemptAt` and a fixed error code. A snapshot also ages stale after two configured intervals plus the attempt timeout (14 seconds by default). With no good sample, metrics, scope and host are null and freshness is `unavailable`. An unsupported OS reports `unsupported_platform`. Process-capacity exhaustion reports `process_capacity` and stops scheduling further attempts. Closing the API cancels and drains the sampler. Error values contain no command arguments, upstream response bodies or credentials.

`owner_resource_history` takes one `scopeId` (default `total`), optional inclusive ISO `since`/`until`, and `limit` 1–120 (default 120). It returns the most recent matching attempts, oldest first:

```json
{"id":5,"method":"tools/call","params":{"name":"owner_resource_history","arguments":{"scopeId":"total","limit":60}}}
```

Every point has an attempt ID/time. `measured` points have metrics, host and coverage; `gap` points have a collection error and null metrics; `absent` points mean a known scope was not present in that successful observation and also have null metrics. Unknown scopes across the retained ring are errors. A warmup point may be measured for memory with null CPU. Do not bridge a gap or absent period with a fabricated zero. There is no interpolation or downsampling.

Retention is at most 120 attempts (about ten minutes at default cadence) and 50,000 retained process records. Process pressure shortens the window. `retention` gives actual boundaries, caps and dropped-attempt count; `truncated` signals that the requested history was cut by retention or `limit`. The last good snapshot remains readable while stale even if its history point has expired. No durable database is written.

## Attribution and sampling limits

An attached owner admits its own process and all observed descendants. Required children receive component names only after their current OS parent is the owner. Standalone `agentstack api owner socket` reports `self_only`, not unrelated process descendants or another running stack. Bot and ACP labels are accepted only for an already owned process under the corresponding named component. A record with an unverified Bot `recoveryIssue` cannot label a process. Inventories never add foreign PIDs. Unmatched running/fenced records increment the relevant domain's coverage count.

On a domain-source failure, collection can still succeed: current memory/CPU remain available while `coverage.domains` reports stale/unavailable labels and their last successful times. Labels are retained only on known birth identities, and each process reports attribution provenance and `attributedAt`. Previously observed descendants may survive reparenting; `parentId` is the currently observed owned parent, `ancestryParentId` is the last observed owned parent (possibly exited), and `ownership: "retained"` exposes that evidence. Process names are bounded executable basenames, never full command lines or environments.

This is a sampled census, not complete accounting. Processes that start and exit between attempts, descendants detached before first observation, recovered processes outside the observed tree, inaccessible proc entries and unobserved descendants of exited parents can be missed. Host unreadable/disappearing-entry counts and domain mismatch counts are explicit. A process absent from an observation loses its CPU baseline. macOS `ps` birth tokens have **one-second resolution**; same-PID reuse within that second cannot be distinguished. Linux identity uses boot ID and start ticks. Enumeration and label lookup are not atomic; the capture timestamp describes the completed collection window, whose duration is reported.

The finest honest allocation is an OS process (or process subtree). ACP runtimes serve multiple Workers; Bots serve multiple chats/threads. All returned scopes flag shared costs. No per-Worker, per-chat, per-thread or per-turn resource allocation is claimed.
