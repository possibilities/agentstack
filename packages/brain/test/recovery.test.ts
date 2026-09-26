import { spawn, spawnSync } from "./process.js";
import { setTimeout as sleep } from "node:timers/promises";
import type { Database } from "../src/sqlite.js";
import { afterEach, test } from "node:test";
import { expect } from "expect";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { admitRecoveryGeneration, RECOVERY_JOB_PREFIX } from "../src/admission.js";
import { ArtifactStore } from "../src/artifacts.js";
import {
  readRecoveryGeneration,
  type VerifiedRecoveryCandidate,
  type VerifiedRecoveryGeneration,
} from "../src/recovery.js";
import { RECOVERY_OFFLINE_SCOPE_KIND, ResearchStore } from "../src/store.js";
import { runWorker } from "../src/worker.js";

const REPO = join(import.meta.dirname, "..");
const roots: string[] = [];
const originalPath = process.env.PATH;

const DISPOSITIONS = [
  ["import_offline", 581],
  ["exclude_infrastructure", 25],
  ["exclude_probable_test", 12],
  ["review", 98],
  ["review_discord", 356],
  ["review_fetch", 4],
  ["review_retry", 5],
  ["approved_online_backfill_telegram_human", 2],
  ["review_telegram_bot_generated", 5],
] as const;

interface Fixture {
  root: string;
  artifactRoot: string;
  manifestsRoot: string;
  generationRoot: string;
  descriptor: string;
  artifactPaths: string[];
}

interface FixtureOptions {
  mutateRows?: (rows: Array<Record<string, unknown>>, root: string) => void;
  mutatePrivateRows?: (rows: Array<Record<string, unknown>>) => void;
  malformedArtifact?: boolean;
}

function digest(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stable(item)]),
    );
  }
  return value;
}

function canonical(value: unknown): string {
  return `${JSON.stringify(stable(value))}\n`;
}

function pretty(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function dispositionFor(index: number): string {
  let offset = 0;
  for (const [name, count] of DISPOSITIONS) {
    if (index < offset + count) return name;
    offset += count;
  }
  throw new Error("fixture disposition overflow");
}

function makeFixture(options: FixtureOptions = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), "agentstack-brain-recovery-test-"));
  roots.push(root);
  const artifactRoot = join(root, "legacy-artifacts");
  const manifestsRoot = join(root, "manifests");
  mkdirSync(artifactRoot, { recursive: true, mode: 0o700 });
  mkdirSync(manifestsRoot, { recursive: true, mode: 0o700 });

  const rows: Array<Record<string, unknown>> = [];
  const artifactPaths: string[] = [];
  for (let index = 0; index < 1088; index += 1) {
    const sourceUri = `https://candidate.test/item/${index + 1}?v=${index + 1}`;
    const candidateId = digest(sourceUri).slice(0, 16);
    const disposition = dispositionFor(index);
    const catalogPosition = index < 584 ? index + 1 : null;
    const provenance: Record<string, unknown> = {
      botctl_messages: [],
      catalog_positions: catalogPosition === null ? [] : [catalogPosition],
      discord_cache_messages: [],
      historical_document_ids: [],
      save_link_pipelines: [],
    };
    const reconciliation: Record<string, unknown> = {
      in_catalog: catalogPosition !== null,
    };
    if (disposition === "import_offline") {
      const path = join(
        artifactRoot,
        `link-${String(index + 1).padStart(5, "0")}.md`,
      );
      const markdown =
        options.malformedArtifact && index === 0
          ? `url: ${JSON.stringify(sourceUri)}\nsummary: broken\nbody\n`
          : [
              "---",
              `url: ${JSON.stringify(sourceUri)}`,
              `summary: ${JSON.stringify(`Independent summary ${index + 1}`)}`,
              "---",
              `Searchable legacy body ${index + 1}`,
              "",
            ].join("\n");
      writeFileSync(path, markdown, { mode: 0o600 });
      artifactPaths.push(path);
      reconciliation.artifact = {
        path,
        sha256: digest(markdown),
        size_bytes: Buffer.byteLength(markdown),
        status: "present",
      };
    }
    rows.push({
      candidate_id: candidateId,
      normalized_uri: index < 2 ? "https://comparison.test/shared" : sourceUri,
      provenance,
      reconciliation,
      recovery: {
        confidence: "synthetic_fixture",
        disposition,
        reasons: [`fixture_${disposition}`],
      },
      schema_version: 1,
      source_type: "url",
      source_uri: sourceUri,
    });
  }

  const secretaryIndexes = [
    ...Array.from({ length: 118 }, (_, index) => index),
    ...Array.from({ length: 6 }, (_, index) => 606 + index),
    1081,
    1082,
    1083,
    1084,
    1085,
    1086,
    1087,
  ];
  const privateRows: Array<Record<string, unknown>> = [];
  let observationSequence = 0;
  for (const [secretaryIndex, candidateIndex] of secretaryIndexes.entries()) {
    const row = rows[candidateIndex];
    if (row === undefined) throw new Error("fixture row missing");
    const count = secretaryIndex < 32 ? 3 : 2;
    const observations = Array.from({ length: count }, () => {
      observationSequence += 1;
      return {
        fields: ["entity_url"],
        observation_id: digest(`observation:${observationSequence}`).slice(
          0,
          24,
        ),
        observed_in: ["agentbot_db"],
        sender_kind: candidateIndex >= 1081 ? "human" : "unknown",
        soft_deleted_provenance: false,
      };
    });
    (row.provenance as Record<string, unknown>).agentbot_secretary = {
      observation_count: observations.length,
      observation_ids: observations.map((item) => item.observation_id),
      private_reconciliation: "private-reconciliation.jsonl",
    };
    privateRows.push({
      candidate_disposition: (row.recovery as Record<string, unknown>)
        .disposition,
      candidate_evidence_row_id: row.candidate_id,
      comparison_candidate_evidence_row_ids: [],
      comparison_uri: row.normalized_uri,
      exact_uri: row.source_uri,
      observations,
      reconciliation_action:
        secretaryIndex < 118
          ? "merge_existing_provenance"
          : "append_exact_candidate",
      resource_sensitivity: "normal",
      schema_version: 1,
    });
  }
  expect(observationSequence).toBe(294);
  options.mutateRows?.(rows, root);
  options.mutatePrivateRows?.(privateRows);

  const manifest = `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
  const privateReconciliation = `${privateRows
    .map((row) => JSON.stringify(row))
    .join("\n")}\n`;
  const summary = pretty({
    candidate_outcomes: {
      appended_exact_candidates: 13,
      baseline_candidate_ids_preserved: 1075,
      comparison_new_urls: 8,
      final_candidates: 1088,
    },
    controlled_online_backfill: {
      approved_human_candidate_evidence_rows: 2,
      network_fetches_performed: 0,
    },
    live_capture: {
      credential_session_copies_retained: 0,
      fixed_upper_cutoff: true,
      hard_cap_duration_ms: 600000,
      hard_cap_messages: 20000,
      history_exhausted: true,
      visible_messages: 119,
    },
    privacy: {
      exact_urls_in_summary: 0,
      private_locators_in_summary: 0,
      transport_privacy_alone_marks_resource_sensitive: false,
    },
    reconciliation: {
      exact_urls: 131,
      live_only_urls: 1,
      message_level_url_observations: 294,
      provenance_merges: 118,
    },
    schema_version: 1,
    secretary_additions: {
      approved_controlled_online_human_submissions: 2,
      bot_output_review_candidates: 5,
      probable_test_exclusions: 6,
    },
  });
  const onlineIds = rows
    .filter(
      (row) =>
        (row.recovery as Record<string, unknown>).disposition ===
        "approved_online_backfill_telegram_human",
    )
    .map((row) => row.candidate_id as string)
    .sort();
  const binding = {
    bound_checksum_inventory: {
      "candidate-manifest.jsonl": digest(manifest),
      "private-reconciliation.jsonl": digest(privateReconciliation),
      "public-summary.json": digest(summary),
    },
    candidate_counts: { baseline: 1075, final: 1088 },
    controlled_online_backfill_candidate_evidence_row_ids: onlineIds,
    cutoff_metadata: {
      completed_at: "2026-07-18T00:00:01.000Z",
      hard_caps: { duration_ms: 600000, messages: 20000 },
      message_count: 119,
      started_at: "2026-07-18T00:00:00.000Z",
      termination: "history_exhausted",
      upper_cutoff_message_id: "7215",
    },
    schema_versions: {
      candidate_manifest: 1,
      frozen_recovery_generation: 1,
      public_summary: 1,
    },
    tool_version: "synthetic-test-1",
  };
  const generationId = `sha256-${digest(canonical(binding))}`;
  const generation = pretty({
    binding,
    generation_id: generationId,
    schema_version: 1,
  });
  const allowlist = pretty({
    candidate_evidence_row_ids: onlineIds,
    entry_count: 2,
    generation_digest: generationId.slice(7),
    generation_id: generationId,
    schema_version: 1,
  });
  const files: Record<string, string> = {
    "candidate-manifest.jsonl": manifest,
    "generation.json": generation,
    "online-allowlist.json": allowlist,
    "private-reconciliation.jsonl": privateReconciliation,
    "public-summary.json": summary,
  };
  const checksums = `${Object.entries(files)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, content]) => `${digest(content)}  ${name}`)
    .join("\n")}\n`;
  const generationRoot = join(manifestsRoot, generationId);
  mkdirSync(generationRoot, { mode: 0o700 });
  for (const [name, content] of Object.entries({
    ...files,
    SHA256SUMS: checksums,
  })) {
    writeFileSync(join(generationRoot, name), content, { mode: 0o600 });
  }
  const descriptor = join(manifestsRoot, "current.json");
  writeFileSync(
    descriptor,
    pretty({ generation_id: generationId, schema_version: 1 }),
    { mode: 0o600 },
  );
  return {
    root,
    artifactRoot,
    manifestsRoot,
    generationRoot,
    descriptor,
    artifactPaths,
  };
}

function count(db: Database, sql: string): number {
  return (db.query(sql).get() as { count: number }).count;
}

function decoded(value: Uint8Array | string): string {
  return typeof value === "string" ? value : new TextDecoder().decode(value);
}

function directAdmissionFixture(): {
  store: ResearchStore;
  artifacts: ArtifactStore;
} {
  const root = mkdtempSync(join(tmpdir(), "agentstack-brain-recovery-admission-"));
  roots.push(root);
  return {
    store: new ResearchStore(join(root, "research.db")),
    artifacts: new ArtifactStore(join(root, "artifacts")),
  };
}

function directGeneration(
  overrides: Partial<VerifiedRecoveryCandidate> = {},
  generationId = `sha256-${"a".repeat(64)}`,
): VerifiedRecoveryGeneration {
  const sourceUri = "https://direct-admission.test/item/1";
  const candidate: VerifiedRecoveryCandidate = {
    candidateId: digest(sourceUri).slice(0, 16),
    sourceUri,
    comparisonUri: sourceUri,
    sourceType: "url",
    sensitivity: "normal",
    disposition: "review",
    confidence: "direct_test_fixture",
    reasons: ["direct_test"],
    catalogPosition: null,
    provenanceCounts: {
      botctlMessages: 0,
      discordMessages: 0,
      historicalDocuments: 0,
      saveLinkPipelines: 0,
    },
    observations: [],
    artifact: null,
    ...overrides,
  };
  const dispositionCounts = Object.fromEntries(
    DISPOSITIONS.map(([disposition]) => [disposition, 0]),
  ) as VerifiedRecoveryGeneration["dispositionCounts"];
  dispositionCounts[candidate.disposition] = 1;
  return {
    schemaVersion: 1,
    generationId,
    generationDigest: generationId.slice(7),
    generationRoot: "/direct-test-generation",
    manifestDigest: "b".repeat(64),
    onlineAllowlistDigest: "c".repeat(64),
    candidates: [candidate],
    onlineAllowlist: [],
    dispositionCounts,
    counts: {
      candidate_rows: 1,
      baseline_candidate_rows: 1,
      appended_candidate_rows: 0,
      telegram_candidate_rows: 0,
      telegram_observations: 0,
      telegram_provenance_merges: 0,
      catalog_memberships: candidate.catalogPosition === null ? 0 : 1,
      approved_offline_artifacts:
        candidate.disposition === "import_offline" ? 1 : 0,
      approved_online_jobs: 0,
      blocked_review_jobs: 0,
      excluded_candidates: 0,
      evidence_only_candidates: 0,
    },
  };
}

function expectRecoveryAdmissionCode(
  action: () => unknown,
  code: string,
): void {
  try {
    action();
    throw new Error(`expected recovery admission error ${code}`);
  } catch (error) {
    expect(error).toMatchObject({ code });
  }
}

afterEach(() => {
  process.env.PATH = originalPath;
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

test("dry-run verifies the complete locked generation without state or network", () => {
  const fixture = makeFixture();
  const bin = join(fixture.root, "bin");
  const invoked = join(fixture.root, "agentscrape-invoked");
  mkdirSync(bin);
  const agentscrape = join(bin, "agentscrape");
  writeFileSync(
    agentscrape,
    `#!/bin/sh\ntouch ${JSON.stringify(invoked)}\nexit 97\n`,
  );
  chmodSync(agentscrape, 0o755);
  const dbPath = join(fixture.root, "dry-run.db");
  const artifactStore = join(fixture.root, "dry-run-artifacts");
  const proc = spawnSync({
    cmd: [
      process.execPath,
      "src/cli.js",
      "recovery",
      "import",
      "--manifest-generation",
      fixture.descriptor,
      "--artifact-root",
      fixture.artifactRoot,
      "--artifact-store",
      artifactStore,
      "--dry-run",
      "--db",
      dbPath,
      "--json",
    ],
    cwd: REPO,
    env: { ...process.env, PATH: `${bin}:${originalPath}` },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(proc.exitCode).toBe(0);
  const output = JSON.parse(decoded(proc.stdout));
  expect(output.data).toMatchObject({
    status: "verified",
    dry_run: true,
    counts: {
      candidate_rows: 1088,
      telegram_observations: 294,
      approved_offline_artifacts: 581,
      catalog_memberships: 584,
    },
    dispositions: Object.fromEntries(DISPOSITIONS),
    jobs: { queued: 581, blocked: 11, excluded: 37, evidence_only: 459 },
    run: { id: null, state: "verified" },
  });
  expect(existsSync(dbPath)).toBe(false);
  expect(existsSync(artifactStore)).toBe(false);
  expect(existsSync(invoked)).toBe(false);
  expect(decoded(proc.stdout)).not.toContain("https://candidate.test");
  expect(decoded(proc.stderr)).not.toContain("https://candidate.test");
});

test("admission is offline, idempotent, and preserves every exact candidate outcome", async () => {
  const fixture = makeFixture();
  const generation = readRecoveryGeneration(fixture.descriptor, {
    artifactRoots: [fixture.artifactRoot],
  });
  const dbPath = join(fixture.root, "research.db");
  const artifactRoot = join(fixture.root, "artifact-store");
  const store = new ResearchStore(dbPath);
  const collidingCandidate = generation.candidates.find(
    (candidate) => candidate.disposition === "import_offline",
  );
  if (collidingCandidate === undefined) {
    throw new Error("fixture has no offline recovery candidate");
  }
  expect(collidingCandidate.sourceType).toBe("url");
  const existingDocument = store.upsertDocument({
    sourceType: collidingCandidate.sourceType,
    sourceUri: collidingCandidate.sourceUri,
    content: "pre-existing recovered body from another generation",
  });
  const priorCandidateId =
    collidingCandidate.candidateId === "0000000000000000"
      ? "1111111111111111"
      : "0000000000000000";
  expect(priorCandidateId).not.toBe(collidingCandidate.candidateId);
  const existingResourceId = Number(
    store.db
      .query(
        `INSERT INTO resources(
           key_type, key_value, kind, sensitivity, document_id, created_at, updated_at
         ) VALUES ('recovery_candidate', ?, ?, 'normal', ?, ?, ?)`,
      )
      .run(
        priorCandidateId,
        collidingCandidate.sourceType,
        existingDocument.document_id,
        "2026-07-18T00:00:00.000Z",
        "2026-07-18T00:00:00.000Z",
      ).lastInsertRowid,
  );
  store.db
    .query(
      `INSERT INTO resource_aliases(
         resource_id, alias_type, locator, evidence, first_observed_at,
         last_observed_at
       ) VALUES (?, 'legacy_exact_url', ?, 'prior recovery generation', ?, ?)`,
    )
    .run(
      existingResourceId,
      collidingCandidate.sourceUri,
      "2026-07-18T00:00:00.000Z",
      "2026-07-18T00:00:00.000Z",
    );
  store.db
    .query(
      `INSERT INTO provenance(
         resource_id, evidence_type, ingress, raw_metadata, observed_at
       ) VALUES (?, 'recovery_candidate_outcome', 'legacy-recovery', ?, ?)`,
    )
    .run(
      existingResourceId,
      JSON.stringify({
        schema_version: 1,
        candidate_evidence_row_id: priorCandidateId,
        disposition: "import_offline",
        generation_ids: [`sha256-${"f".repeat(64)}`],
      }),
      "2026-07-18T00:00:00.000Z",
    );
  const artifacts = new ArtifactStore(artifactRoot);
  const first = admitRecoveryGeneration(store, generation, {
    artifactStore: artifacts,
    authorizeOffline: true,
    now: new Date("2026-07-19T00:00:00.000Z"),
  });
  expect(first.jobs).toMatchObject({
    queued: 581,
    blocked: 11,
    excluded: 37,
    evidence_only: 459,
    created: 629,
    existing: 0,
  });
  expect(first.effects).toMatchObject({
    candidate_outcomes_created: 1088,
    observations_created: 294,
  });
  expect(
    store.db
      .query(
        `SELECT resource_id FROM jobs
         WHERE idempotency_key=?`,
      )
      .get(`${RECOVERY_JOB_PREFIX}${collidingCandidate.candidateId}`),
  ).toEqual({ resource_id: existingResourceId });
  expect(
    store.db
      .query(
        `SELECT COUNT(DISTINCT resource_id) AS count FROM resource_aliases
         WHERE alias_type='legacy_exact_url' AND locator=?`,
      )
      .get(collidingCandidate.sourceUri),
  ).toEqual({ count: 1 });
  expect(
    store.db
      .query(
        `SELECT id FROM resources
         WHERE key_type='recovery_candidate' AND key_value=?`,
      )
      .get(collidingCandidate.candidateId),
  ).toBeNull();
  expect(count(store.db, "SELECT COUNT(*) AS count FROM runs")).toBe(1);
  expect(count(store.db, "SELECT COUNT(*) AS count FROM jobs")).toBe(629);
  expect(
    count(store.db, "SELECT COUNT(*) AS count FROM jobs WHERE state='queued'"),
  ).toBe(581);
  expect(
    count(store.db, "SELECT COUNT(*) AS count FROM jobs WHERE state='blocked'"),
  ).toBe(11);
  expect(
    count(
      store.db,
      "SELECT COUNT(*) AS count FROM jobs WHERE state='excluded'",
    ),
  ).toBe(37);
  expect(
    count(
      store.db,
      "SELECT COUNT(*) AS count FROM provenance WHERE evidence_type='recovery_candidate_outcome'",
    ),
  ).toBe(1089);
  expect(count(store.db, "SELECT COUNT(*) AS count FROM observations")).toBe(
    294,
  );
  expect(
    count(store.db, "SELECT COUNT(*) AS count FROM collection_memberships"),
  ).toBe(584);
  expect(
    count(
      store.db,
      "SELECT COUNT(DISTINCT resource_id) AS count FROM provenance WHERE evidence_type='recovery_candidate_outcome'",
    ),
  ).toBe(1088);
  expect(
    count(
      store.db,
      "SELECT COUNT(*) AS count FROM resource_aliases WHERE alias_type='comparison_uri' AND locator='https://comparison.test/shared'",
    ),
  ).toBe(2);

  const artifact = store.db
    .query(
      "SELECT content_hash FROM artifacts WHERE artifact_role='imported_markdown' ORDER BY id LIMIT 1",
    )
    .get() as { content_hash: string };
  const body = artifacts.readUtf8(artifact.content_hash);
  expect(body.startsWith("---")).toBe(false);
  expect(body).not.toContain("url:");
  expect(body).toContain("Searchable legacy body");

  expect(first.run).toMatchObject({
    operator_controlled: true,
    authorization_digest: generation.generationDigest,
    allowed_job_kinds: [RECOVERY_OFFLINE_SCOPE_KIND],
    expected_job_count: 581,
  });
  expect(
    store.claimJob({
      worker: "ordinary-worker-must-skip-recovery",
      now: new Date("2026-07-19T00:30:00.000Z"),
    }),
  ).toEqual({ claimed: false });

  let networkCalls = 0;
  const worker = await runWorker(store, {
    once: true,
    scope: {
      runId: first.run.id as number,
      authorizationDigest: generation.generationDigest,
      allowedKinds: [RECOVERY_OFFLINE_SCOPE_KIND],
    },
    artifactStore: artifacts,
    installSignalHandlers: false,
    extract: async () => {
      networkCalls += 1;
      throw new Error("forbidden network extraction");
    },
  });
  expect(worker).toMatchObject({ claimed: 581, completed: 581, failed: 0 });
  expect(networkCalls).toBe(0);
  expect(
    store.db
      .query("SELECT state, failure_class FROM jobs WHERE idempotency_key=?")
      .get(`${RECOVERY_JOB_PREFIX}${collidingCandidate.candidateId}`),
  ).toEqual({ state: "completed", failure_class: null });
  expect(count(store.db, "SELECT COUNT(*) AS count FROM documents")).toBe(581);
  expect(
    count(
      store.db,
      "SELECT COUNT(*) AS count FROM resources WHERE document_id IS NOT NULL",
    ),
  ).toBe(581);
  expect(
    count(
      store.db,
      "SELECT COUNT(*) AS count FROM documents WHERE source_uri LIKE 'https://candidate.test/%'",
    ),
  ).toBe(581);

  const provenanceBeforeReplay = count(
    store.db,
    "SELECT COUNT(*) AS count FROM provenance",
  );
  const second = admitRecoveryGeneration(store, generation, {
    artifactStore: artifacts,
    authorizeOffline: true,
    now: new Date("2026-07-19T01:00:00.000Z"),
  });
  expect(second.jobs).toMatchObject({ created: 0, existing: 629 });
  expect(second.effects).toMatchObject({
    candidate_outcomes_created: 0,
    candidate_outcomes_existing: 1088,
    observations_created: 0,
    observations_existing: 294,
  });
  expect(count(store.db, "SELECT COUNT(*) AS count FROM runs")).toBe(1);
  expect(count(store.db, "SELECT COUNT(*) AS count FROM jobs")).toBe(629);
  expect(
    count(
      store.db,
      "SELECT COUNT(*) AS count FROM provenance WHERE evidence_type='recovery_candidate_outcome'",
    ),
  ).toBe(1089);
  expect(count(store.db, "SELECT COUNT(*) AS count FROM provenance")).toBe(
    provenanceBeforeReplay,
  );
  const mergedOutcomes = (
    store.db
      .query(
        `SELECT raw_metadata FROM provenance
         WHERE resource_id=? AND evidence_type='recovery_candidate_outcome'
         ORDER BY id`,
      )
      .all(existingResourceId) as Array<{ raw_metadata: string }>
  ).map(
    (row) =>
      (JSON.parse(row.raw_metadata) as { candidate_evidence_row_id: string })
        .candidate_evidence_row_id,
  );
  expect(mergedOutcomes.sort()).toEqual(
    [priorCandidateId, collidingCandidate.candidateId].sort(),
  );
  store.close();
});

test("recovery admission fails closed on an exact identity conflict", () => {
  const { store, artifacts } = directAdmissionFixture();
  const generation = directGeneration();
  const candidate = generation.candidates[0];
  if (candidate === undefined) throw new Error("fixture candidate missing");
  const timestamp = "2026-07-19T00:00:00.000Z";
  const resourceId = Number(
    store.db
      .query(
        `INSERT INTO resources(
           key_type, key_value, kind, created_at, updated_at
         ) VALUES ('recovery_candidate', ?, 'url', ?, ?)`,
      )
      .run(candidate.candidateId, timestamp, timestamp).lastInsertRowid,
  );
  store.db
    .query(
      `INSERT INTO resource_aliases(
         resource_id, alias_type, locator, first_observed_at, last_observed_at
       ) VALUES (?, 'legacy_exact_url', ?, ?, ?)`,
    )
    .run(resourceId, candidate.sourceUri, timestamp, timestamp);
  const foreignResourceId = Number(
    store.db
      .query(
        `INSERT INTO resources(
           key_type, key_value, kind, created_at, updated_at
         ) VALUES ('url', 'duplicate-exact-owner', 'url', ?, ?)`,
      )
      .run(timestamp, timestamp).lastInsertRowid,
  );
  store.db
    .query(
      `INSERT INTO resource_aliases(
         resource_id, alias_type, locator, first_observed_at, last_observed_at
       ) VALUES (?, 'legacy_exact_url', ?, ?, ?)`,
    )
    .run(foreignResourceId, candidate.sourceUri, timestamp, timestamp);

  expectRecoveryAdmissionCode(
    () =>
      admitRecoveryGeneration(store, generation, { artifactStore: artifacts }),
    "recovery_identity_conflict",
  );
  store.close();
});

test("recovery admission fails closed on a catalog position conflict", () => {
  const { store, artifacts } = directAdmissionFixture();
  const generation = directGeneration({ catalogPosition: 1 });
  const timestamp = "2026-07-19T00:00:00.000Z";
  const collectionId = Number(
    store.db
      .query(
        `INSERT INTO collections(slug, title, created_at, updated_at)
         VALUES ('legacy-links', 'Legacy links', ?, ?)`,
      )
      .run(timestamp, timestamp).lastInsertRowid,
  );
  const foreignResourceId = Number(
    store.db
      .query(
        `INSERT INTO resources(
           key_type, key_value, kind, created_at, updated_at
         ) VALUES ('url', 'foreign-catalog-owner', 'url', ?, ?)`,
      )
      .run(timestamp, timestamp).lastInsertRowid,
  );
  store.db
    .query(
      `INSERT INTO collection_memberships(
         collection_id, resource_id, position, external_ref, added_at
       ) VALUES (?, ?, 1, 'link-00001', ?)`,
    )
    .run(collectionId, foreignResourceId, timestamp);

  expectRecoveryAdmissionCode(
    () =>
      admitRecoveryGeneration(store, generation, { artifactStore: artifacts }),
    "recovery_catalog_conflict",
  );
  store.close();
});

test("recovery admission fails closed on an idempotency conflict", () => {
  const { store, artifacts } = directAdmissionFixture();
  const generation = directGeneration({ disposition: "review_fetch" });
  const candidate = generation.candidates[0];
  if (candidate === undefined) throw new Error("fixture candidate missing");
  store.enqueueJob({
    idempotencyKey: `${RECOVERY_JOB_PREFIX}${candidate.candidateId}`,
    kind: "url",
    intent: { conflicting: true },
    now: new Date("2026-07-19T00:00:00.000Z"),
  });

  expectRecoveryAdmissionCode(
    () =>
      admitRecoveryGeneration(store, generation, { artifactStore: artifacts }),
    "recovery_idempotency_conflict",
  );
  store.close();
});

test("recovery admission fails closed on stored Artifact metadata conflict", () => {
  const { store, artifacts } = directAdmissionFixture();
  const body = "direct offline recovery body\n";
  const bodyDigest = digest(body);
  const generation = directGeneration({
    disposition: "import_offline",
    artifact: {
      sourceDigest: "c".repeat(64),
      sourceByteSize: 100,
      summary: "Direct offline fixture",
      body,
      bodyDigest,
      bodyByteSize: Buffer.byteLength(body),
    },
  });
  const stored = artifacts.captureBytes(body, { expectedDigest: bodyDigest });
  store.db
    .query(
      `INSERT INTO artifacts(
         content_hash, media_type, byte_size, artifact_role, sensitivity,
         storage_path, created_at
       ) VALUES (?, 'text/plain', ?, 'imported_markdown', 'normal', ?, ?)`,
    )
    .run(
      bodyDigest,
      stored.byteSize,
      stored.storagePath,
      "2026-07-19T00:00:00.000Z",
    );

  expectRecoveryAdmissionCode(
    () =>
      admitRecoveryGeneration(store, generation, { artifactStore: artifacts }),
    "recovery_artifact_conflict",
  );
  store.close();
});

test("recovery admission run-checkpoint guard rejects a mixed generation", () => {
  const { store, artifacts } = directAdmissionFixture();
  const generation = directGeneration();
  const timestamp = "2026-07-19T00:00:00.000Z";
  const sourceId = Number(
    store.db
      .query(
        `INSERT INTO sources(
           source_type, identifier, enabled, sensitivity, created_at, updated_at
         ) VALUES ('frozen_recovery_generation', ?, 0, 'normal', ?, ?)`,
      )
      .run(generation.generationId, timestamp, timestamp).lastInsertRowid,
  );
  store.db
    .query(
      `INSERT INTO runs(
         run_type, source_id, state, checkpoint, created_at, updated_at
       ) VALUES ('legacy_recovery_import', ?, 'pending', ?, ?, ?)`,
    )
    .run(
      sourceId,
      JSON.stringify({
        generation_id: generation.generationId,
        manifest_digest: "d".repeat(64),
      }),
      timestamp,
      timestamp,
    );

  expectRecoveryAdmissionCode(
    () =>
      admitRecoveryGeneration(store, generation, { artifactStore: artifacts }),
    "mixed_recovery_generation",
  );
  store.close();
});

test("generation validation fails closed for identity, paths, hashes, and private data", () => {
  const duplicate = makeFixture({
    mutateRows(rows) {
      const [first, second] = rows;
      if (first === undefined || second === undefined)
        throw new Error("fixture needs two rows");
      second.candidate_id = first.candidate_id;
      second.source_uri = first.source_uri;
      second.normalized_uri = first.normalized_uri;
    },
  });
  expect(() =>
    readRecoveryGeneration(duplicate.descriptor, {
      artifactRoots: [duplicate.artifactRoot],
    }),
  ).toThrow("duplicate exact outcomes");

  const changed = makeFixture();
  writeFileSync(changed.artifactPaths[0] ?? "", "changed bytes");
  expect(() =>
    readRecoveryGeneration(changed.descriptor, {
      artifactRoots: [changed.artifactRoot],
    }),
  ).toThrow("does not match frozen evidence");

  const malformed = makeFixture({ malformedArtifact: true });
  expect(() =>
    readRecoveryGeneration(malformed.descriptor, {
      artifactRoots: [malformed.artifactRoot],
    }),
  ).toThrow("missing Linkctl frontmatter");

  const linked = makeFixture();
  const [linkTarget, linkSource] = [
    linked.artifactPaths[0],
    linked.artifactPaths[1],
  ];
  if (linkTarget === undefined || linkSource === undefined)
    throw new Error("fixture needs two artifact paths");
  unlinkSync(linkTarget);
  symlinkSync(linkSource, linkTarget);
  expect(() =>
    readRecoveryGeneration(linked.descriptor, {
      artifactRoots: [linked.artifactRoot],
    }),
  ).toThrow("non-symlink file");

  const unsafe = makeFixture({
    mutateRows(rows, root) {
      const artifact = (rows[0]?.reconciliation as Record<string, unknown>)
        .artifact as Record<string, unknown>;
      artifact.path = join(root, "outside.md");
    },
  });
  expect(() =>
    readRecoveryGeneration(unsafe.descriptor, {
      artifactRoots: [unsafe.artifactRoot],
    }),
  ).toThrow("outside declared roots");

  const nonHumanApproval = makeFixture({
    mutatePrivateRows(rows) {
      const approved = rows.find(
        (row) =>
          row.candidate_disposition ===
          "approved_online_backfill_telegram_human",
      ) as Record<string, unknown>;
      const observations = approved.observations as Array<
        Record<string, unknown>
      >;
      const observation = observations[0];
      if (observation === undefined)
        throw new Error("fixture observation missing");
      observation.sender_kind = "bot";
    },
  });
  expect(() =>
    readRecoveryGeneration(nonHumanApproval.descriptor, {
      artifactRoots: [nonHumanApproval.artifactRoot],
    }),
  ).toThrow("allowlist is not bound to the approved cohort");

  const privateData = makeFixture({
    mutateRows(rows) {
      const secretary = (rows[0]?.provenance as Record<string, unknown>)
        .agentbot_secretary as Record<string, unknown>;
      secretary.message_body = "PRIVATE MESSAGE BODY";
    },
  });
  expect(() =>
    readRecoveryGeneration(privateData.descriptor, {
      artifactRoots: [privateData.artifactRoot],
    }),
  ).toThrow("forbidden private field");
});
