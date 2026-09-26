import { spawn, spawnSync } from "./process.js";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { expect } from "expect";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliError } from "../src/errors.js";
import {
  mergeSourceOverlay,
  readSourceManifest,
  validateSourceManifest,
} from "../src/sources.js";

/**
 * Characterization of the manifest file-parsing slice in src/sources.ts.
 * These tests pin the loader's CURRENT accept/reject set, its normalized
 * output (which feeds the durable definition hash), and its failure modes
 * (CliError code + exit code versus a plain Error), ahead of the zod port.
 * They pin behavior, not prose: messages are matched only tightly enough to
 * prove the offending key is named.
 */

function blog(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "blog-one",
    version: 1,
    kind: "blog_source",
    display_name: "Blog One",
    enabled: false,
    payload: { homepage_url: "https://blog.example/" },
    schedule: { cadence: "daily" },
    limits: { max_items_per_run: 20, max_pages_per_run: 2 },
    collections: ["blogs"],
    sensitivity: "public",
    credential_refs: [],
    ...overrides,
  };
}

function manifest(...sources: unknown[]): Record<string, unknown> {
  return { schema_version: 1, sources };
}

function cliError(run: () => unknown): CliError {
  try {
    run();
  } catch (error) {
    if (!(error instanceof CliError)) {
      throw new Error(`expected CliError, got ${String(error)}`);
    }
    return error;
  }
  throw new Error("expected the call to throw");
}

/** The credential and URL scans throw plain Errors, not CliErrors. */
function plainError(run: () => unknown): Error {
  try {
    run();
  } catch (error) {
    if (error instanceof CliError) {
      throw new Error(`expected a plain Error, got CliError ${error.code}`);
    }
    if (!(error instanceof Error)) {
      throw new Error(`expected an Error, got ${String(error)}`);
    }
    return error;
  }
  throw new Error("expected the call to throw");
}

test("manifest envelope faults carry their codes and name the offending path", () => {
  for (const root of [null, 7, "x", []]) {
    const fault = cliError(() => validateSourceManifest(root));
    expect(fault.code).toBe("bad_source_manifest");
    expect(fault.exitCode).toBe(2);
    expect(fault.message).toContain("source manifest");
  }
  for (const version of [2, "1", null, undefined]) {
    const fault = cliError(() =>
      validateSourceManifest({ schema_version: version, sources: [] }),
    );
    expect(fault.code).toBe("unsupported_source_manifest_version");
    expect(fault.message).toContain("schema_version");
  }
  // 1.0 === 1: an integer-valued float is the same version.
  expect(
    validateSourceManifest({ schema_version: 1.0, sources: [] }).sources,
  ).toEqual([]);

  const notArray = cliError(() =>
    validateSourceManifest({ schema_version: 1, sources: "x" }),
  );
  expect(notArray.code).toBe("bad_source_manifest");
  expect(notArray.message).toContain("sources");

  const tooMany = cliError(() =>
    validateSourceManifest({
      schema_version: 1,
      sources: Array.from({ length: 1001 }, (_, i) => blog({ id: `s-${i}` })),
    }),
  );
  expect(tooMany.message).toContain("1000");

  const badEntry = cliError(() => validateSourceManifest(manifest(blog(), 7)));
  expect(badEntry.message).toContain("sources[1]");
});

test("overlay faults are reported against the overlay by name", () => {
  const fault = cliError(() =>
    mergeSourceOverlay(manifest(blog()), { schema_version: 2, sources: [] }),
  );
  expect(fault.code).toBe("unsupported_source_manifest_version");
  expect(fault.message).toContain("source overlay");
});

// Flipped by the zod port (the one sanctioned behavior change): unknown keys
// at the manifest root used to be ignored and are now rejected, with the key
// and the known-key list named. `$schema` stays tolerated, whatever its value.
test("unknown manifest root keys are rejected; $schema stays tolerated", () => {
  expect(
    validateSourceManifest({
      $schema: "./sources.schema.json",
      schema_version: 1,
      sources: [],
    }).sources,
  ).toEqual([]);
  expect(
    validateSourceManifest({ $schema: 7, schema_version: 1, sources: [] })
      .sources,
  ).toEqual([]);
  const fault = cliError(() =>
    validateSourceManifest({ schema_version: 1, sources: [], mystery: true }),
  );
  expect(fault.code).toBe("bad_source_manifest");
  expect(fault.message).toContain("mystery");
  expect(fault.message).toContain("schema_version");
});

test("stable ids must be unique across the manifest, compared after trimming", () => {
  const duplicate = cliError(() =>
    validateSourceManifest(manifest(blog(), blog())),
  );
  expect(duplicate.code).toBe("duplicate_source_id");
  expect(duplicate.message).toContain("blog-one");

  const trimmed = cliError(() =>
    validateSourceManifest(manifest(blog(), blog({ id: " blog-one " }))),
  );
  expect(trimmed.code).toBe("duplicate_source_id");

  const badId = cliError(() =>
    validateSourceManifest(manifest(blog({ id: 7 }))),
  );
  expect(badId.code).toBe("bad_source_manifest");
  expect(badId.message).toContain("sources[0].id");
});

test("the overlay masks base values, deep-merges, appends, and pins kind", () => {
  // A base fault under an overlay-supplied value never surfaces: only the
  // merged result is validated. This placement must survive the port.
  const masked = mergeSourceOverlay(
    manifest(blog({ version: "not-a-version" })),
    { schema_version: 1, sources: [{ id: "blog-one", version: 3 }] },
  );
  expect(masked.sources[0]?.version).toBe(3);

  const merged = mergeSourceOverlay(manifest(blog()), {
    schema_version: 1,
    sources: [
      { id: "blog-one", version: 2, limits: { max_items_per_run: 5 } },
      blog({ id: "blog-two" }),
    ],
  });
  expect(merged.sources[0]?.limits).toEqual({
    max_items_per_run: 5,
    max_pages_per_run: 2,
  });
  expect(merged.sources.map((source) => source.id)).toEqual([
    "blog-one",
    "blog-two",
  ]);

  const mismatch = cliError(() =>
    mergeSourceOverlay(manifest(blog()), {
      schema_version: 1,
      sources: [{ id: "blog-one", version: 2, kind: "x_account" }],
    }),
  );
  expect(mismatch.code).toBe("source_identity_mismatch");
});

test("id, kind, version, enabled, and sensitivity faults name their field", () => {
  const cases: Array<[Record<string, unknown>, string | RegExp]> = [
    // Blank and oversize ids fault at the pre-merge unique-id sweep, which
    // names the array slot; shape faults name the field once ids are known.
    [{ id: "" }, /id/],
    [{ id: "Upper" }, /source id/],
    [{ id: ".dot-lead" }, /source id/],
    [{ id: `x${"y".repeat(120)}` }, /id/],
    [{ version: 0 }, /version/],
    [{ version: 1_000_001 }, /version/],
    [{ version: 1.5 }, /version/],
    [{ version: "5" }, /version/],
    [{ version: null }, /version/],
    [{ version: true }, /version/],
    [{ kind: "" }, /kind/],
    [{ kind: "Weird" }, /kind/],
    [{ kind: "9lead" }, /kind/],
    [{ kind: `k${"x".repeat(80)}` }, /kind/],
    [{ kind: 5 }, /kind/],
    [{ enabled: 1 }, /enabled/],
    [{ enabled: "true" }, /enabled/],
    [{ enabled: null }, /enabled/],
    [{ sensitivity: "internal" }, /sensitivity/],
    [{ sensitivity: 4 }, /sensitivity/],
  ];
  for (const [overrides, needle] of cases) {
    const fault = cliError(() =>
      validateSourceManifest(manifest(blog(overrides))),
    );
    expect(fault.code).toBe("bad_source_manifest");
    expect(fault.exitCode).toBe(2);
    expect(fault.message).toMatch(needle);
  }
  // Integer-valued floats are integers.
  expect(
    validateSourceManifest(manifest(blog({ version: 2.0 }))).sources[0]
      ?.version,
  ).toBe(2);
});

test("string fields are trimmed into the stored definition", () => {
  const parsed = validateSourceManifest(
    manifest(
      blog({
        id: " blog-one ",
        kind: " blog_source ",
        display_name: "  Blog One  ",
        sensitivity: " public ",
        collections: [" blogs "],
        credential_refs: [" keychain:agentstack-brain/blog-one "],
      }),
    ),
  );
  expect(parsed.sources[0]).toMatchObject({
    id: "blog-one",
    kind: "blog_source",
    display_name: "Blog One",
    sensitivity: "public",
    collections: ["blogs"],
    credential_refs: ["keychain:agentstack-brain/blog-one"],
  });
});

test("display_name defaults to the id, counts code points, and refuses blank", () => {
  const source = { ...blog() };
  delete (source as Record<string, unknown>).display_name;
  expect(
    validateSourceManifest(manifest(source)).sources[0]?.display_name,
  ).toBe("blog-one");

  // 300 astral code points are 600 UTF-16 units; the loader counts points.
  const emoji = "\u{1F600}".repeat(300);
  expect(
    validateSourceManifest(manifest(blog({ display_name: emoji }))).sources[0]
      ?.display_name,
  ).toBe(emoji);
  const tooLong = cliError(() =>
    validateSourceManifest(manifest(blog({ display_name: "x".repeat(501) }))),
  );
  expect(tooLong.message).toContain("display_name");
  for (const value of [null, "", "   ", 7]) {
    const fault = cliError(() =>
      validateSourceManifest(manifest(blog({ display_name: value }))),
    );
    expect(fault.message).toContain("display_name");
  }
});

test("the parsed definition is fully normalized, and re-validation is a fixed point", () => {
  const parsed = validateSourceManifest(
    manifest(
      blog({
        schedule: { cadence: "hourly" },
        limits: { max_items: 9, max_pages: 3 },
        payload: { homepage_url: "https://blog.example/", note: "kept" },
      }),
    ),
  );
  const expected = {
    id: "blog-one",
    version: 1,
    kind: "blog_source",
    display_name: "Blog One",
    enabled: false,
    payload: { homepage_url: "https://blog.example/", note: "kept" },
    schedule: { cadence_seconds: 3_600 },
    limits: { max_items_per_run: 9, max_pages_per_run: 3 },
    collections: ["blogs"],
    sensitivity: "public" as const,
    credential_refs: [] as string[],
  };
  expect(parsed.sources[0]).toEqual(expected);
  // Applying stored definitions re-validates them; the normal form must be
  // stable or the durable definition hash would shift on replay.
  expect(validateSourceManifest(parsed).sources[0]).toEqual(expected);
});

test("payload stays an open passthrough for unknown kinds", () => {
  const parsed = validateSourceManifest(
    manifest(
      blog({
        id: "future-one",
        kind: "future_connector",
        payload: {
          locator: "opaque:item",
          homepage_url: 12345,
          nested: { deep: true },
        },
      }),
    ),
  );
  // No kind-specific rule applies, so even a number under a blog-shaped key
  // survives untouched.
  expect(parsed.sources[0]?.payload).toEqual({
    locator: "opaque:item",
    homepage_url: 12345,
    nested: { deep: true },
  });
  const badPayload = cliError(() =>
    validateSourceManifest(manifest(blog({ payload: "x" }))),
  );
  expect(badPayload.message).toContain("payload");
});

test("x_account_candidate payloads are not held to the x_account rules", () => {
  const parsed = validateSourceManifest(
    manifest(
      blog({ id: "cand-one", kind: "x_account_candidate", payload: {} }),
    ),
  );
  expect(parsed.sources[0]?.kind).toBe("x_account_candidate");
});

test("credential-shaped payload members are refused as their own fault class", () => {
  for (const payload of [
    { homepage_url: "https://blog.example/", api_key: "nope" },
    { homepage_url: "https://blog.example/", nested: { access_token: "no" } },
    { homepage_url: "https://blog.example/?token=raw" },
    {
      homepage_url: "https://blog.example/",
      extra: ["https://x.example/?api_key=v"],
    },
  ]) {
    const fault = cliError(() =>
      validateSourceManifest(manifest(blog({ payload }))),
    );
    expect(fault.code).toBe("source_contains_credential");
    expect(fault.exitCode).toBe(2);
  }
});

test("malformed and credentialed payload URLs fail as plain errors, not CliErrors", () => {
  // The URL scan inside the credential sweep throws bare Errors, which the
  // CLI reports as `unexpected error` and exit 1. The port must not silently
  // upgrade these to bad_source_manifest.
  const malformed = plainError(() =>
    validateSourceManifest(
      manifest(blog({ payload: { homepage_url: "https://" } })),
    ),
  );
  expect(malformed.message).toContain("http(s) URL");
  const credentialed = plainError(() =>
    validateSourceManifest(
      manifest(
        blog({ payload: { homepage_url: "https://user:pass@blog.example/" } }),
      ),
    ),
  );
  expect(credentialed.message).toContain("credentialed URLs");
  // Even under a key no kind-specific rule reads.
  const stray = plainError(() =>
    validateSourceManifest(
      manifest(
        blog({
          payload: { homepage_url: "https://blog.example/", stray: "http://" },
        }),
      ),
    ),
  );
  expect(stray.message).toContain("http(s) URL");
});

test("blog payloads need a homepage or feed and bounded timeouts", () => {
  const missing = cliError(() =>
    validateSourceManifest(manifest(blog({ payload: {} }))),
  );
  expect(missing.code).toBe("bad_source_manifest");
  expect(missing.message).toMatch(/homepage_url or feed_url/);

  expect(
    validateSourceManifest(
      manifest(blog({ payload: { feed_url: "https://blog.example/feed" } })),
    ).sources[0]?.payload,
  ).toEqual({ feed_url: "https://blog.example/feed" });

  const badType = cliError(() =>
    validateSourceManifest(manifest(blog({ payload: { homepage_url: 7 } }))),
  );
  expect(badType.message).toContain("payload.homepage_url");

  for (const timeout of [0, 300_001, 1.5, "50"]) {
    const fault = cliError(() =>
      validateSourceManifest(
        manifest(
          blog({
            payload: {
              homepage_url: "https://blog.example/",
              timeout_ms: timeout,
            },
          }),
        ),
      ),
    );
    expect(fault.message).toContain("timeout_ms");
  }
});

test("live blog Sources cap at 10 pages unless a recorded input file lifts it", () => {
  const live = cliError(() =>
    validateSourceManifest(
      manifest(
        blog({ limits: { max_items_per_run: 20, max_pages_per_run: 11 } }),
      ),
    ),
  );
  expect(live.message).toContain("10 pages");
  expect(
    validateSourceManifest(
      manifest(
        blog({
          payload: {
            homepage_url: "https://blog.example/",
            recorded_input_file: "fixture.json",
          },
          limits: { max_items_per_run: 20, max_pages_per_run: 11 },
        }),
      ),
    ).sources[0]?.limits.max_pages_per_run,
  ).toBe(11);
});

test("x_account payloads require a well-formed handle and clean identifiers", () => {
  const account = (payload: Record<string, unknown>) =>
    blog({
      id: "x-one",
      kind: "x_account",
      payload,
      schedule: { cadence: "hourly" },
      limits: { max_items_per_run: 25, max_pages_per_run: 1 },
      collections: ["x-accounts"],
    });
  const missing = cliError(() => validateSourceManifest(manifest(account({}))));
  expect(missing.message).toContain("handle");
  for (const handle of ["@bad handle", "@toolonghandle_exceeds", "@", ""]) {
    const fault = cliError(() =>
      validateSourceManifest(manifest(account({ handle }))),
    );
    expect(fault.message).toContain("handle");
  }
  expect(
    validateSourceManifest(manifest(account({ handle: "no_at_sign" })))
      .sources[0]?.payload,
  ).toEqual({ handle: "no_at_sign" });

  const badAccountId = cliError(() =>
    validateSourceManifest(
      manifest(account({ handle: "@ok", account_id: "sp ace" })),
    ),
  );
  expect(badAccountId.message).toContain("account_id");
  const badProfile = plainError(() =>
    validateSourceManifest(
      manifest(account({ handle: "@ok", profile_url: "ftp://x.example/" })),
    ),
  );
  expect(badProfile.message).toContain("http(s) URL");
});

test("schedule spellings resolve in order with null fall-through", () => {
  const cadence = (schedule: Record<string, unknown>) =>
    validateSourceManifest(manifest(blog({ schedule }))).sources[0]?.schedule;

  expect(cadence({ cadence_seconds: 90 })).toEqual({ cadence_seconds: 90 });
  expect(cadence({ cadence_minutes: 2 })).toEqual({ cadence_seconds: 120 });
  expect(cadence({ cadence_minutes: 0.5 })).toEqual({ cadence_seconds: 30 });
  expect(cadence({ cadence: 45 })).toEqual({ cadence_seconds: 45 });
  expect(cadence({ every: "daily" })).toEqual({ cadence_seconds: 86_400 });

  // Precedence: cadence_seconds > cadence_minutes > cadence > every.
  expect(
    cadence({
      cadence_seconds: 60,
      cadence_minutes: 99,
      cadence: "daily",
      every: "hourly",
    }),
  ).toEqual({ cadence_seconds: 60 });
  expect(cadence({ cadence_minutes: 2, cadence: "daily" })).toEqual({
    cadence_seconds: 120,
  });

  // Null spellings fall through to the next one.
  expect(cadence({ cadence_seconds: null, cadence: "hourly" })).toEqual({
    cadence_seconds: 3_600,
  });
  // A string cadence_seconds rides the shared cadence parser.
  expect(cadence({ cadence_seconds: "hourly" })).toEqual({
    cadence_seconds: 3_600,
  });
  // A non-number cadence_minutes is skipped, not type-errored.
  expect(cadence({ cadence_minutes: "60", every: "daily" })).toEqual({
    cadence_seconds: 86_400,
  });

  // String spellings: trimmed, case-insensitive, bounded and ISO durations.
  expect(cadence({ cadence: " HOURLY " })).toEqual({ cadence_seconds: 3_600 });
  expect(cadence({ cadence: "30s" })).toEqual({ cadence_seconds: 30 });
  expect(cadence({ cadence: "15m" })).toEqual({ cadence_seconds: 900 });
  expect(cadence({ cadence: "6h" })).toEqual({ cadence_seconds: 21_600 });
  expect(cadence({ cadence: "2d" })).toEqual({ cadence_seconds: 172_800 });
  expect(cadence({ cadence: "PT6H30M" })).toEqual({ cadence_seconds: 23_400 });
  expect(cadence({ cadence: "pt90s" })).toEqual({ cadence_seconds: 90 });
});

test("schedule faults name the cadence and enforce the 1s..31d window", () => {
  const scheduleFault = (schedule: unknown): CliError =>
    cliError(() => validateSourceManifest(manifest(blog({ schedule }))));

  expect(scheduleFault("x").message).toContain("schedule");
  expect(scheduleFault(null).message).toContain("schedule");
  for (const schedule of [
    {},
    { cadence_minutes: "60" },
    { cadence_seconds: 0 },
    { cadence_seconds: 2_678_401 },
    { cadence_seconds: 1.5 },
    { cadence: "40d" },
    { cadence: "0s" },
    { cadence: "weekly" },
    { cadence: "P1D" },
    { cadence: "1w" },
    { cadence: "pt" },
    { cadence: true },
    { cadence_minutes: 44_641 },
    { cadence_minutes: 0.001 },
  ]) {
    const fault = scheduleFault(schedule);
    expect(fault.code).toBe("bad_source_manifest");
    expect(fault.message).toContain("cadence");
  }
});

// Flipped by the zod port: unknown schedule keys used to be ignored and are
// now rejected with the key named.
test("unknown schedule keys are rejected", () => {
  const fault = cliError(() =>
    validateSourceManifest(
      manifest(blog({ schedule: { cadence: "daily", cadenza: 1 } })),
    ),
  );
  expect(fault.code).toBe("bad_source_manifest");
  expect(fault.message).toContain("cadenza");
  expect(fault.message).toContain("cadence_seconds");
});

test("limits aliases resolve with null fall-through and both ceilings stated", () => {
  const limits = (value: Record<string, unknown>) =>
    validateSourceManifest(manifest(blog({ limits: value }))).sources[0]
      ?.limits;

  expect(limits({ max_items: 9, max_pages: 3 })).toEqual({
    max_items_per_run: 9,
    max_pages_per_run: 3,
  });
  expect(
    limits({
      max_items_per_run: 5,
      max_items: 9,
      max_pages_per_run: 2,
      max_pages: 7,
    }),
  ).toEqual({ max_items_per_run: 5, max_pages_per_run: 2 });
  expect(
    limits({ max_items_per_run: null, max_items: 9, max_pages_per_run: 3 }),
  ).toEqual({ max_items_per_run: 9, max_pages_per_run: 3 });

  const limitsFault = (value: unknown): CliError =>
    cliError(() => validateSourceManifest(manifest(blog({ limits: value }))));
  expect(limitsFault("x").message).toContain("limits");
  expect(limitsFault(null).message).toContain("limits");
  for (const [value, needle] of [
    [{ max_pages_per_run: 3 }, "max_items_per_run"],
    [{ max_items_per_run: 9 }, "max_pages_per_run"],
    [{ max_items_per_run: 0, max_pages_per_run: 3 }, "max_items_per_run"],
    [{ max_items_per_run: 10_001, max_pages_per_run: 3 }, "max_items_per_run"],
    [{ max_items_per_run: 9, max_pages_per_run: 101 }, "max_pages_per_run"],
    [{ max_items_per_run: 9, max_pages_per_run: "3" }, "max_pages_per_run"],
    [{ max_items_per_run: 1.5, max_pages_per_run: 3 }, "max_items_per_run"],
  ] as Array<[unknown, string]>) {
    expect(limitsFault(value).message).toContain(needle);
  }
});

// Flipped by the zod port: unknown limits keys used to be ignored and are
// now rejected with the key named.
test("unknown limits keys are rejected", () => {
  const fault = cliError(() =>
    validateSourceManifest(
      manifest(
        blog({
          limits: { max_items_per_run: 9, max_pages_per_run: 3, max_depth: 4 },
        }),
      ),
    ),
  );
  expect(fault.code).toBe("bad_source_manifest");
  expect(fault.message).toContain("max_depth");
});

test("collections are slugs, trimmed, deduplicated, and may be empty", () => {
  expect(
    validateSourceManifest(manifest(blog({ collections: [] }))).sources[0]
      ?.collections,
  ).toEqual([]);
  const faults: Array<[unknown, string | RegExp]> = [
    [null, /collections/],
    ["x", /collections/],
    [[""], /collections\[0\]/],
    [[7], /collections\[0\]/],
    [["Upper"], /collections\[0\]/],
    [["ok", ".lead"], /collections\[1\]/],
    [[`c${"x".repeat(120)}`], /collections\[0\]/],
    [["dup", "dup"], /duplicates/],
    [["dup", " dup "], /duplicates/],
  ];
  for (const [collections, needle] of faults) {
    const fault = cliError(() =>
      validateSourceManifest(manifest(blog({ collections }))),
    );
    expect(fault.code).toBe("bad_source_manifest");
    expect(fault.message).toMatch(needle);
  }
});

test("credential_refs default to empty, accept null, and refuse value-shaped entries", () => {
  const source = { ...blog() };
  delete (source as Record<string, unknown>).credential_refs;
  expect(
    validateSourceManifest(manifest(source)).sources[0]?.credential_refs,
  ).toEqual([]);
  expect(
    validateSourceManifest(manifest(blog({ credential_refs: null }))).sources[0]
      ?.credential_refs,
  ).toEqual([]);

  const faults: unknown[] = [
    5,
    "x",
    [""],
    [7],
    ["9-starts-with-digit"],
    ["has=equals"],
    ["has space"],
    [`r${"x".repeat(300)}`],
    ["dup", "dup"],
    ["dup", " dup "],
  ];
  for (const credential_refs of faults) {
    const fault = cliError(() =>
      validateSourceManifest(manifest(blog({ credential_refs }))),
    );
    expect(fault.code).toBe("bad_source_manifest");
    expect(fault.message).toContain("credential_refs");
  }
});

// Flipped by the zod port: unknown definition keys used to be ignored and
// dropped, and are now rejected with the key named. The rejection lands
// after every fault the old validator could report, so an already-invalid
// definition still names its old first fault.
test("unknown definition keys are rejected", () => {
  const fault = cliError(() =>
    validateSourceManifest(manifest(blog({ retries: 3 }))),
  );
  expect(fault.code).toBe("bad_source_manifest");
  expect(fault.message).toContain("retries");
  const priorFault = cliError(() =>
    validateSourceManifest(manifest(blog({ retries: 3, version: 0 }))),
  );
  expect(priorFault.message).toContain("version");
});

/**
 * Splice a literal own `__proto__` into a document. It has to go through
 * JSON.parse: a `__proto__` key written in a TS object literal is special-cased
 * by the language and sets the prototype instead of creating the own property
 * a manifest file actually carries.
 */
function withProtoKey<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value).replace(/^\{/, '{"__proto__": {"mystery": true}, '),
  ) as T;
}

// zod skips a literal own `__proto__`, so `strictObject` never lists it among
// its unrecognized keys — it would be the one unknown key the flip above still
// accepted in silence. It is rejected at the same levels, in the manifest and
// in the overlay, with the same prose and known-key list.
test("a __proto__ key is an unknown key at every strict level", () => {
  const root = cliError(() =>
    validateSourceManifest(withProtoKey(manifest(blog()))),
  );
  expect(root.code).toBe("bad_source_manifest");
  expect(root.message).toBe(
    "source manifest has unknown key '__proto__'; known keys: schema_version, sources",
  );

  const definition = cliError(() =>
    validateSourceManifest(manifest(withProtoKey(blog()))),
  );
  expect(definition.code).toBe("bad_source_manifest");
  expect(definition.message).toContain(
    "source blog-one has unknown key '__proto__'",
  );
  expect(definition.message).toContain("credential_refs");

  const schedule = cliError(() =>
    validateSourceManifest(
      manifest(blog({ schedule: withProtoKey({ cadence: "daily" }) })),
    ),
  );
  expect(schedule.message).toContain(
    "source blog-one schedule has unknown key '__proto__'",
  );
  expect(schedule.message).toContain("cadence_seconds");

  const limits = cliError(() =>
    validateSourceManifest(
      manifest(
        blog({
          limits: withProtoKey({ max_items_per_run: 9, max_pages_per_run: 3 }),
        }),
      ),
    ),
  );
  expect(limits.message).toContain(
    "source blog-one limits has unknown key '__proto__'",
  );
  expect(limits.message).toContain("max_pages_per_run");

  // The overlay is the same file surface, scanned before the merge — the only
  // point at which the key is still visible.
  const overlayRoot = cliError(() =>
    mergeSourceOverlay(manifest(blog()), withProtoKey(manifest())),
  );
  expect(overlayRoot.message).toContain(
    "source overlay has unknown key '__proto__'",
  );
  const overlayEntry = cliError(() =>
    mergeSourceOverlay(
      manifest(blog()),
      manifest(withProtoKey({ id: "blog-one", version: 2 })),
    ),
  );
  expect(overlayEntry.message).toContain(
    "source blog-one has unknown key '__proto__'",
  );

  expect(Object.hasOwn(Object.prototype, "mystery")).toBe(false);
});

test("payload keeps a __proto__ entry, staying an open passthrough", () => {
  const parsed = validateSourceManifest(
    manifest(
      blog({
        payload: withProtoKey({ homepage_url: "https://blog.example/" }),
      }),
    ),
  );
  const payload = parsed.sources[0]?.payload as Record<string, unknown>;
  expect(Object.getOwnPropertyNames(payload)).toContain("__proto__");
  expect(Object.getOwnPropertyDescriptor(payload, "__proto__")?.value).toEqual({
    mystery: true,
  });
  expect(Object.hasOwn(Object.prototype, "mystery")).toBe(false);
});

test("a definition larger than 128KiB is refused", () => {
  const fault = cliError(() =>
    validateSourceManifest(
      manifest(
        blog({
          payload: {
            homepage_url: "https://blog.example/",
            bulk: "x".repeat(131_072),
          },
        }),
      ),
    ),
  );
  expect(fault.message).toContain("too large");
});

test("unreadable or non-JSON manifest files fail as bad_source_manifest", () => {
  const root = mkdtempSync(join(tmpdir(), "agentstack-brain-manifest-"));
  try {
    const missing = cliError(() =>
      readSourceManifest(join(root, "absent.json")),
    );
    expect(missing.code).toBe("bad_source_manifest");

    const mangled = join(root, "mangled.json");
    writeFileSync(mangled, "{not json");
    expect(cliError(() => readSourceManifest(mangled)).code).toBe(
      "bad_source_manifest",
    );

    const good = join(root, "good.json");
    writeFileSync(good, JSON.stringify(manifest(blog())));
    expect(cliError(() => readSourceManifest(good, mangled)).code).toBe(
      "bad_source_manifest",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function decode(value: Uint8Array | string): string {
  return typeof value === "string" ? value : new TextDecoder().decode(value);
}

function runApply(manifestPath: string, extra: string[] = []) {
  const repo = join(import.meta.dirname, "..");
  const root = mkdtempSync(join(tmpdir(), "agentstack-brain-manifest-cli-"));
  const result = spawnSync({
    cmd: [
      process.execPath,
      "src/cli.js",
      "sources",
      "apply",
      "--manifest",
      manifestPath,
      ...extra,
      "--db",
      join(root, "research.db"),
    ],
    cwd: repo,
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  rmSync(root, { recursive: true, force: true });
  return {
    exitCode: result.exitCode,
    stdout: decode(result.stdout),
    stderr: decode(result.stderr),
  };
}

test("sources apply exits 2 for manifest faults and 1 for payload URL faults", () => {
  const root = mkdtempSync(join(tmpdir(), "agentstack-brain-manifest-files-"));
  try {
    const structural = join(root, "structural.json");
    writeFileSync(structural, JSON.stringify(manifest(blog({ version: "x" }))));
    const rejected = runApply(structural);
    expect(rejected.exitCode).toBe(2);
    expect(rejected.stderr.startsWith("AgentStack Brain: ")).toBe(true);
    expect(rejected.stderr).toContain("version");

    const envelope = runApply(structural, ["--json"]);
    expect(envelope.exitCode).toBe(2);
    expect(JSON.parse(envelope.stdout)).toMatchObject({
      ok: false,
      error: { code: "bad_source_manifest" },
    });

    const urlFault = join(root, "url-fault.json");
    writeFileSync(
      urlFault,
      JSON.stringify(manifest(blog({ payload: { homepage_url: "https://" } }))),
    );
    const unexpected = runApply(urlFault);
    expect(unexpected.exitCode).toBe(1);
    expect(unexpected.stderr).toContain("unexpected error");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
