/**
 * The source-manifest file surface as a zod schema — the single source of
 * truth: `sources.ts` validates manifest files with it at load, and
 * `scripts/generate-sources-schema.ts` emits `config/sources.schema.json`
 * from it, so a manifest key exists exactly when it is declared (and
 * described) here.
 *
 * Contract:
 * - Parse-faithful to the hand-rolled validator it replaced: string fields
 *   trim before their checks, `display_name` counts code points, and the
 *   alias spellings inside `schedule` and `limits` carry no parse-time value
 *   checks because sources.ts resolves their precedence (with null
 *   fall-through) and bounds after the fact — a bound enforced at that
 *   resolution must not move into the parse. Their documented types ride
 *   `.meta()` into the published schema instead.
 * - The manifest root, each definition, `schedule`, and `limits` reject
 *   unknown keys; `payload` is an open passthrough and must stay open.
 *   `strictObject` alone does not finish that job: zod skips a literal own
 *   `__proto__` key, so sources.ts scans raw manifests for it separately.
 * - `$schema` appears only in the published-file schema; the loader
 *   tolerates and strips it before validation, whatever its value.
 * - URL validity, the credential sweep, the kind-specific payload rules, the
 *   live-blog page ceiling, and the definition byte cap stay in sources.ts:
 *   their placement and failure modes (the URL faults are plain Errors, not
 *   CliErrors) are part of the loader's observable contract.
 */
import { z } from "zod";
import { SOURCE_MANIFEST_VERSION } from "./source-types.js";

export const MAX_SOURCES = 1_000;

export const SOURCE_SENSITIVITIES = [
  "public",
  "normal",
  "sensitive",
  "private",
] as const;

const SOURCE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,99}$/;
const SOURCE_KIND_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
const COLLECTION_PATTERN = /^[a-z0-9][a-z0-9._-]{0,99}$/;
const CREDENTIAL_REF_PATTERN = /^[A-Za-z][A-Za-z0-9+._:/@-]{0,255}$/;

/** Alias-spelling keys accept anything at parse; sources.ts resolves them. */
const spelling = (documentation: Record<string, unknown>) =>
  z.unknown().optional().meta(documentation);

const distinct = (items: readonly string[]) =>
  new Set(items).size === items.length;

const sourceIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(SOURCE_ID_PATTERN)
  .describe(
    "The stable declarative identity of this Source, unique within the manifest and the key an overlay merges against. Mutable handles and homepages are payload, not identity, so an account rename must not change this. 1-100 characters: lowercase letters, digits, dots, underscores, or hyphens, starting with a letter or digit.",
  );

const versionSchema = z
  .int()
  .min(1)
  .max(1_000_000)
  .describe(
    "Definition version, an integer from 1 to 1000000. `sources apply` is version-gated: re-applying identical content is a no-op, raising this alongside a content change is an accepted update, and changing content without raising it is refused. Flipping `enabled` is a content change and must ride a version bump.",
  );

const kindSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(SOURCE_KIND_PATTERN)
  .describe(
    "What sort of Source this is, which selects the payload shape and the discovery path. blog_source, blog_feed, and x_account are executable; any other kind — x_account_candidate, for instance — stays listable and showable but Source sync will not admit work for it. 1-64 characters: a lowercase letter followed by lowercase letters, digits, underscores, or hyphens.",
  );

/** Trimmed and counted in code points, exactly like the check it replaced. */
const displayNameSchema = z
  .string()
  .trim()
  .min(1)
  .check((context) => {
    if (Array.from(context.value).length > 500) {
      context.issues.push({
        code: "too_big",
        maximum: 500,
        origin: "string",
        input: context.value,
      });
    }
  })
  .meta({
    description:
      "Human-readable label for listings. Defaults to the id when omitted. Trimmed, non-empty, at most 500 characters.",
    maxLength: 500,
  });

const enabledSchema = z
  .boolean()
  .describe(
    "Whether schedule evaluation may admit Runs for this Source. Required — there is no default, because an omitted flag must never be read as consent to start fetching. The bundled manifest ships every Source disabled; activation is a separate, explicit operator act, normally a version-bumped overlay.",
  );

const sensitivitySchema = z
  .string()
  .trim()
  .pipe(z.enum(SOURCE_SENSITIVITIES))
  .meta({
    description:
      "Handling policy for everything this Source yields, ranked public < normal < sensitive < private. It bounds how the resulting Documents may be surfaced and shared.",
    enum: [...SOURCE_SENSITIVITIES],
  });

/**
 * Documentation for the payload members the executable kinds read. Parsing
 * deliberately validates none of them: the payload is stored as given, and
 * sources.ts applies the kind-specific rules (and the credential sweep) so
 * that unknown kinds keep a fully open locator space.
 */
const PAYLOAD_MEMBER_DOCS = {
  homepage_url: {
    description:
      "Blog kinds: the site's homepage, from which the feed is discovered. An http or https URL, at most 2000 characters. At least one of homepage_url or feed_url is required.",
    type: "string",
    maxLength: 2000,
  },
  feed_url: {
    description:
      "Blog kinds: the feed to poll directly, when it is already known. An http or https URL, at most 2000 characters. At least one of homepage_url or feed_url is required.",
    type: "string",
    maxLength: 2000,
  },
  timeout_ms: {
    description:
      "Blog kinds: optional per-fetch timeout in milliseconds, an integer from 1 to 300000. Omitted leaves the fetcher's own default in place.",
    type: "integer",
    minimum: 1,
    maximum: 300000,
  },
  recorded_input_file: {
    description:
      "Blog kinds: a recorded fixture to read instead of polling the live web, used by offline tests. Its presence is what lifts the 10-page ceiling that live blog Sources are held to.",
    type: "string",
  },
  handle: {
    description:
      "X kinds: the account handle, with or without a leading @. 1-20 characters of letters, digits, or underscores. Required for x_account.",
    type: "string",
    maxLength: 21,
    pattern: "^@?[A-Za-z0-9_]{1,20}$",
  },
  account_id: {
    description:
      "X kinds: the account's stable upstream id, when known, which survives a handle rename. At most 100 characters of letters, digits, dots, underscores, colons, or hyphens.",
    type: "string",
    maxLength: 100,
    pattern: "^[A-Za-z0-9._:-]+$",
  },
  profile_url: {
    description:
      "X kinds: the account's profile URL. An http or https URL, at most 2000 characters.",
    type: "string",
    maxLength: 2000,
  },
} as const;

const payloadSchema = z.looseObject({}).meta({
  description:
    "The kind-specific locator: where to poll and how, distinct from the identity in `id`. Unknown members are preserved as given, but no member anywhere in the payload may be credential-shaped — a key or URL query parameter named like a token, api_key, password, cookie, secret, session, signature, or authorization is refused with source_contains_credential. Name the secret in credential_refs instead; the manifest is a committed file and never holds a credential value.",
  properties: PAYLOAD_MEMBER_DOCS,
});

/** The number-or-string cadence forms `cadence` and `every` both accept. */
const CADENCE_SPELLING_DOCS = {
  anyOf: [
    {
      description: "Whole seconds, stated as a number.",
      type: "integer",
      minimum: 1,
      maximum: 2678400,
    },
    {
      description:
        "A duration string: hourly, daily, a bounded duration, or an ISO 8601 time duration.",
      type: "string",
      pattern:
        "^\\s*(?:[Hh][Oo][Uu][Rr][Ll][Yy]|[Dd][Aa][Ii][Ll][Yy]|[0-9]+[SsMmHhDd]|[Pp][Tt](?=[0-9])(?:[0-9]+[Hh])?(?:[0-9]+[Mm])?(?:[0-9]+[Ss])?)\\s*$",
    },
  ],
} as const;

export const scheduleValuesSchema = z
  .strictObject({
    cadence_seconds: spelling({
      description:
        "Cadence in whole seconds, from 1 to 2678400 (31 days). Read first, ahead of every other spelling.",
      type: "integer",
      minimum: 1,
      maximum: 2678400,
    }),
    cadence_minutes: spelling({
      description:
        "Cadence in minutes, multiplied by 60 to reach seconds. Read only when cadence_seconds is absent, and the product must land on a whole number of seconds from 1 to 2678400 — so at most 44640 minutes.",
      type: "number",
      exclusiveMinimum: 0,
      maximum: 44640,
    }),
    cadence: spelling({
      description:
        "Cadence as a number of whole seconds, or as a duration string: `hourly`, `daily`, a bounded duration like `30s`, `15m`, `6h`, or `2d`, or an ISO 8601 time duration like `PT6H30M`. Strings are trimmed and matched case-insensitively. However it is spelled, the result must fall between 1 second and 2678400 seconds (31 days). Read only when cadence_seconds and cadence_minutes are absent.",
      ...CADENCE_SPELLING_DOCS,
    }),
    every: spelling({
      description:
        "Alias for cadence, accepting exactly the same forms and read last of the four spellings. Prefer cadence_seconds or cadence in new manifests.",
      ...CADENCE_SPELLING_DOCS,
    }),
  })
  .meta({
    description:
      "How often this Source becomes due. Required. Evaluation admits at most one catch-up Run per overdue Source and advances the next due time from the current evaluation rather than once per missed wall-clock tick, so a stopped worker cannot bank a backlog. Whichever spelling is used, the cadence is normalised to whole seconds, from 1 second to 31 days.",
    anyOf: [
      {
        description: "The canonical spelling, already in seconds.",
        required: ["cadence_seconds"],
      },
      {
        description: "Minutes, multiplied by 60.",
        required: ["cadence_minutes"],
      },
      {
        description:
          "The general spelling, a number of seconds or a duration string.",
        required: ["cadence"],
      },
      {
        description: "The alias for cadence, read last.",
        required: ["every"],
      },
    ],
  });

export const limitsValuesSchema = z
  .strictObject({
    max_items_per_run: spelling({
      description: "Most items one Run may admit, an integer from 1 to 10000.",
      type: "integer",
      minimum: 1,
      maximum: 10000,
    }),
    max_items: spelling({
      description:
        "Alias for max_items_per_run, read only when that key is absent. Same 1 to 10000 range.",
      type: "integer",
      minimum: 1,
      maximum: 10000,
    }),
    max_pages_per_run: spelling({
      description:
        "Most pages or scrolls one Run may request, an integer from 1 to 100. A live blog Source — a blog_feed or blog_source whose payload names no recorded_input_file — is held to at most 10. One page per run is the usual setting for X accounts: it forbids deep pagination, so forward-only polling can never claim resumable historical backfill.",
      type: "integer",
      minimum: 1,
      maximum: 100,
    }),
    max_pages: spelling({
      description:
        "Alias for max_pages_per_run, read only when that key is absent. Same 1 to 100 range and the same 10-page ceiling for live blog Sources.",
      type: "integer",
      minimum: 1,
      maximum: 100,
    }),
  })
  .meta({
    description:
      "The per-Run ceiling on how much this Source may pull. Required, and both ceilings must be stated — an unbounded Source is not expressible. They are what keeps polling forward-only and bounded rather than a silent historical backfill.",
    allOf: [
      {
        description: "The item ceiling, under either spelling.",
        anyOf: [
          { required: ["max_items_per_run"] },
          { required: ["max_items"] },
        ],
      },
      {
        description: "The page ceiling, under either spelling.",
        anyOf: [
          { required: ["max_pages_per_run"] },
          { required: ["max_pages"] },
        ],
      },
    ],
  });

const collectionsSchema = z
  .array(
    z
      .string()
      .trim()
      .min(1)
      .max(100)
      .regex(COLLECTION_PATTERN)
      .describe("One collection slug."),
  )
  .refine(distinct, { message: "collections contains duplicates" })
  .meta({
    description:
      "The collections this Source's Documents are filed under. Required, and may be empty. Each entry is a stable lowercase slug of 1-100 characters — letters, digits, dots, underscores, or hyphens, starting with a letter or digit — and duplicates are refused.",
    uniqueItems: true,
  });

/**
 * The loader has always read a null credential_refs as "none stated"; the
 * published schema keeps documenting the array alone (the generator lifts
 * the array branch out of this union), so the tolerance stays a loader
 * detail rather than an advertised form.
 */
const credentialRefsSchema = z
  .union([
    z
      .array(
        z
          .string()
          .trim()
          .min(1)
          .max(256)
          .regex(CREDENTIAL_REF_PATTERN)
          .describe("One opaque credential reference name."),
      )
      .refine(distinct, { message: "credential_refs contains duplicates" })
      .meta({ uniqueItems: true }),
    z.null(),
  ])
  .meta({
    description:
      "Opaque names of credentials this Source needs, resolved elsewhere at run time. Defaults to empty. These are references, never values: an entry must start with a letter, run at most 256 characters of letters, digits, plus, dot, underscore, colon, slash, at-sign, or hyphen, and may not contain `=` — the shapes a base64 secret pasted here would take. Duplicates are refused.",
  });

export const sourceDefinitionValuesSchema = z
  .strictObject({
    id: sourceIdSchema,
    version: versionSchema,
    kind: kindSchema,
    display_name: displayNameSchema.optional(),
    enabled: enabledSchema,
    sensitivity: sensitivitySchema,
    payload: payloadSchema,
    schedule: scheduleValuesSchema,
    limits: limitsValuesSchema,
    collections: collectionsSchema,
    credential_refs: credentialRefsSchema.optional(),
  })
  .meta({
    description:
      "One Source definition: a stable identity plus the policy under which AgentStack Brain is willing to poll it.",
    allOf: [
      {
        description:
          "A blog Source must name something to poll: discovery starts from the homepage or goes straight to a known feed.",
        if: {
          required: ["kind"],
          properties: { kind: { enum: ["blog_feed", "blog_source"] } },
        },
        // biome-ignore lint/suspicious/noThenProperty: `then` is the JSON Schema conditional keyword, not a thenable.
        then: {
          properties: {
            payload: {
              anyOf: [
                { required: ["homepage_url"] },
                { required: ["feed_url"] },
              ],
            },
          },
        },
      },
      {
        description:
          "An x_account is polled by handle, so the handle is not optional.",
        if: {
          required: ["kind"],
          properties: { kind: { const: "x_account" } },
        },
        // biome-ignore lint/suspicious/noThenProperty: `then` is the JSON Schema conditional keyword, not a thenable.
        then: {
          properties: { payload: { required: ["handle"] } },
        },
      },
    ],
  });

const schemaVersionSchema = z
  .literal(SOURCE_MANIFEST_VERSION)
  .describe(
    "Manifest format version. Must be exactly 1 — any other value is an unsupported_source_manifest_version error exiting 2, rather than a best-effort read of a format this build does not know.",
  );

/**
 * What the loader checks a manifest or overlay file against before the
 * overlay merge: the envelope alone, with `$schema` already stripped.
 * Definitions are validated one by one after the merge, because an overlay
 * entry is partial until it lands on its base.
 */
export const manifestEnvelopeSchema = z.strictObject({
  schema_version: schemaVersionSchema,
  sources: z.array(z.looseObject({})).max(MAX_SOURCES),
});

/**
 * What `config/sources.schema.json` documents: a complete standalone
 * manifest, plus the `$schema` key a file may carry for editor tooling.
 */
export const sourceManifestFileSchema = z.strictObject({
  $schema: z
    .string()
    .describe(
      "Path or URL of this schema, for editors that offer completion and validation. The loader never reads it: the key is tolerated whatever its value, stripped before validation, and dropped from the definitions that `sources apply` stores.",
    )
    .optional(),
  schema_version: schemaVersionSchema,
  sources: z.array(sourceDefinitionValuesSchema).max(MAX_SOURCES).meta({
    description:
      "Every Source definition the manifest declares, in order. At most 1000 entries. Ids must be unique across the array or the manifest is refused with duplicate_source_id. An overlay passed with --overlay is matched against this array by id and deep-merged over it before validation, so an overlay entry may carry just an id, a raised version, and the fields it changes.",
  }),
});

export type SourceDefinitionValues = z.infer<
  typeof sourceDefinitionValuesSchema
>;

/** Key lists for unknown-key messages, straight from the shapes. */
export const MANIFEST_KEYS: ReadonlyArray<string> = Object.keys(
  manifestEnvelopeSchema.shape,
);
export const SOURCE_DEFINITION_KEYS: ReadonlyArray<string> = Object.keys(
  sourceDefinitionValuesSchema.shape,
);
export const SCHEDULE_KEYS: ReadonlyArray<string> = Object.keys(
  scheduleValuesSchema.shape,
);
export const LIMITS_KEYS: ReadonlyArray<string> = Object.keys(
  limitsValuesSchema.shape,
);
