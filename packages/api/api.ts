import { z } from "zod";
import { loadCatalog } from "./src/catalog.js";
import { operation, type PackageApi } from "./src/operation.js";
import { workspaceRoot } from "./src/workspace.js";

export type DocsContext = {
  env: NodeJS.ProcessEnv;
  root: string;
};

const jsonSchemaRecord = z.record(z.string(), z.unknown());

const transportDocSchema = z.object({
  type: z.string().describe("Configured transport name."),
  description: z.string(),
  supported: z.boolean().describe("The transport is implemented and configured; it does not report liveness."),
  subscriptions: z.boolean().describe("The transport delivers event change notices."),
  endpoint: z.string().nullable().describe("Socket path or HTTP URL when the transport has a fixed address."),
});

const operationDocSchema = z.object({
  name: z.string(),
  title: z.string().nullable(),
  description: z.string(),
  annotations: z.record(z.string(), z.union([z.boolean(), z.string()])),
  inputSchema: jsonSchemaRecord.describe("JSON Schema for the operation input."),
  outputSchema: jsonSchemaRecord.describe("JSON Schema for the operation output."),
});

const packageDocSchema = z.object({
  name: z.string().describe("Package API name; also its socket namespace."),
  description: z.string(),
  packageName: z.string().describe("Workspace package name."),
  operations: z.array(operationDocSchema),
  events: z.record(z.string(), z.string()).describe("Event topics and descriptions; empty when the package serves none."),
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
  async call(ctx: DocsContext, input) {
    const catalog = await loadCatalog(ctx.env, ctx.root);
    const server = catalog.servers.find((item) => item.name === input.package);
    if (!server) throw new Error(`unknown package API: ${input.package}`);
    return {
      ...server,
      operations: server.operations.map((item) => ({ ...item, title: item.title ?? null })),
    };
  },
});

export const api: PackageApi<DocsContext> = {
  operations: [docsList, docsGet],
  async createContext(env) {
    return { env, root: workspaceRoot(import.meta.dirname) };
  },
  async closeContext() {},
};
