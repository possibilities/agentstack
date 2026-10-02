import { z } from "zod";
import { loadCatalog, type CatalogServer } from "./src/catalog.js";
import { operation, type PackageApi } from "./src/operation.js";
import { workspaceRoot } from "./src/workspace.js";
import { withStateInventory, stateCategories } from "./src/state-inventory.js";
import { completionWatchSchema } from "./src/completion-watch.js";

export type DocsContext = {
  env: NodeJS.ProcessEnv;
  root: string;
};

const jsonSchemaRecord = z.record(z.string(), z.unknown());

const transportDocSchema = z.object({
  type: z.string().describe("Configured transport name."),
  description: z.string(),
  supported: z.boolean().describe("The transport is implemented and configured; it does not report liveness."),
  subscriptions: z.boolean().describe("Selected invalidation topics or MCP occurrence sources support delivery. Socket/WebSocket subscribe invalidations; MCP offers protocol polling and managed runtime subscription tools."),
  endpoint: z.string().nullable().describe("Socket path or network URL when the transport has a fixed address. MCP URLs are for external HTTP consumers; internal Stack launches use private stdio descriptors."),
  operations: z.array(z.string()).describe("Operations available through this transport; HTTP uses explicit routes instead."),
  workerOperations: z.array(z.string()).describe("Explicit Worker-visible operations intersected with MCP exposure; empty for other transports. Record ownership still applies. Read-only hints alone grant no disclosure authority."),
  workerEvents: z.array(z.string()).describe("Explicit Worker-visible occurrence names intersected with MCP event and poll operation exposure. Omission grants none."),
  events: z.array(z.string()).describe("Selected invalidation topics; MCP also includes typed occurrence names. Occurrence polling requires its read operation too. Socket/WebSocket invalidations remain payload-free."),
  routes: z.array(z.object({ surface: z.string(), surfaceDescription: z.string(), kind: z.enum(["json", "static"]), authentication: z.enum(["bearer", "none"]),
    method: z.string(), path: z.string(), description: z.string(), format: z.string(), operation: z.string().nullable(),
    inputSchema: jsonSchemaRecord.nullable(), querySchema: jsonSchemaRecord.nullable(),
    outputSchema: jsonSchemaRecord.nullable(), errorSchema: jsonSchemaRecord.nullable() }))
    .describe("Explicit HTTP routes, including static paths and HTTP-only typed operations."),
});

const operationDocSchema = z.object({
  name: z.string(),
  title: z.string().nullable(),
  description: z.string(),
  standalone: z.boolean().describe("Explicit owner opt-in for operator stdio execution when its private service is absent before dispatch. Managed callers still require live identity checks; HTTP and WebSocket require live services."),
  annotations: z.record(z.string(), z.union([z.boolean(), z.string()])),
  inputSchema: jsonSchemaRecord.describe("JSON Schema for the operation input."),
  outputSchema: jsonSchemaRecord.describe("JSON Schema for the operation output."),
  completionWatch: completionWatchSchema.nullable().describe("Optional owner-coordinated one-shot Bot completion watch. Requires live MCP operation, read and event exposure."),
  eventSource: z.object({ name: z.string(), description: z.string(), delivery: z.tuple([z.literal("poll")]), inputSchema: jsonSchemaRecord, payloadSchema: jsonSchemaRecord }).nullable(),
});

const standaloneDocs = { open(env: NodeJS.ProcessEnv): DocsContext { return { env, root: workspaceRoot(import.meta.dirname) }; }, close() {} };

const packageDocSchema = z.object({
  name: z.string().describe("Package API name; also its socket namespace."),
  description: z.string(),
  packageName: z.string().describe("Workspace package name."),
  operations: z.array(operationDocSchema),
  events: z.record(z.string(), z.string()).describe("Event topics and descriptions; empty when the package serves none."),
  eventScope: z.object({
    description: z.string().describe("Meaning of the subscription scope."),
    example: z.string().describe("Example scope value for events/subscribe."),
    required: z.boolean().describe("Whether events/subscribe requires a scope."),
  }).nullable().describe("Socket event subscription scope, when supported."),
  transports: z.array(transportDocSchema),
});

const packageSummarySchema = z.object({
  name: z.string(),
  description: z.string(),
  packageName: z.string(),
});

export const docsList = operation({
  name: "docs_list",
  description: "List the workspace Package APIs with their names and summaries. Follow with docs_get for one package's full document.",
  input: z.strictObject({}),
  output: z.object({ packages: z.array(packageSummarySchema) }),
  annotations: { title: "List API docs", readOnlyHint: true },
  standalone: standaloneDocs,
  async call(ctx: DocsContext) {
    const catalog = await loadCatalog(ctx.env, ctx.root);
    return {
      packages: catalog.servers.map((server) => ({
        name: server.name,
        description: server.description,
        packageName: server.packageName,
      })),
    };
  },
});

export const docsGet = operation({
  name: "docs_get",
  description: "Return one package's structured API document: metadata, operations with JSON Schemas, event topics, and configured transports with their subscription capability.",
  input: z.strictObject({ package: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/).describe("Package API name from docs_list.") }),
  output: packageDocSchema,
  annotations: { title: "Read API doc", readOnlyHint: true },
  standalone: standaloneDocs,
  async call(ctx: DocsContext, input) {
    const catalog = await loadCatalog(ctx.env, ctx.root);
    const server = catalog.servers.find((item) => item.name === input.package);
    if (!server) throw new Error(`unknown package API: ${input.package}`);
    return documentFor(server);
  },
});

export const docsSnapshot = operation({
  name: "docs_snapshot",
  description: "Return one current, consistent document for every workspace Package API. Use this to render the complete reference with one discovery call.",
  input: z.strictObject({}),
  output: z.object({ packages: z.array(packageDocSchema) }),
  annotations: { title: "Snapshot API docs", readOnlyHint: true },
  standalone: standaloneDocs,
  async call(ctx: DocsContext) {
    const catalog = await loadCatalog(ctx.env, ctx.root);
    return { packages: catalog.servers.map(documentFor) };
  },
});

function documentFor(server: CatalogServer) {
  return { ...server, operations: server.operations.map((item) => ({ ...item, title: item.title ?? null })) };
}

const packageApi: PackageApi<DocsContext> = {
  operations: [docsList, docsGet, docsSnapshot],
  async createContext(env) {
    return { env, root: workspaceRoot(import.meta.dirname) };
  },
  async closeContext() {},
};
export const api = withStateInventory("api", stateCategories("api", [{ id: "discovery", kind: "cache", paths: [], authority: "derived", sensitivity: "ordinary",
  reads: ["docs_snapshot"], retention: "API discovery reads built declarations and manifests without creating contexts. Transport sessions are owned by Serve.", regeneration: "Each discovery read loads current declarations; no authoritative user content is stored here." }]), packageApi);
