import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { operation, type PackageApi } from "@agentstack/api";
import { ArtifactStore, artifactHome } from "./src/artifacts.js";
import type { Context, Handler } from "./src/context.js";
import { nowIso, openIndex } from "./src/context.js";
import { buildContract } from "./src/contract.js";
import * as documents from "./src/documents.js";
import { CliError, UsageError } from "./src/errors.js";
import { commitVault, ensureGit, gitReport, pushVault, syncVault } from "./src/git.js";
import { agentTools, invocationFor } from "./src/mcp-tools.js";
import * as publish from "./src/publish.js";
import { startServer, type RunningServer } from "./src/serve.js";
import { DEFAULT_ARTIFACT_PORT, DEFAULT_HOST, DEFAULT_PORT } from "./src/urls.js";
import { ensureVault } from "./src/vault.js";

type WikiContext = { command: Context; server: RunningServer; index: ReturnType<typeof openIndex>; store: ArtifactStore };

const handlers: Record<string, Handler> = {
  new: documents.newDocument, add: documents.addDocument, get: documents.getDocument,
  path: documents.documentPath, list: documents.listDocuments, search: documents.searchDocuments,
  tags: documents.listTags, resolve: documents.resolveCommand, links: documents.documentLinks,
  backlinks: documents.documentBacklinks, graph: documents.graphCommand, doctor: documents.doctorCommand,
  reindex: documents.reindexCommand, rm: documents.removeDocument, restore: documents.restoreDocument,
  publish: publish.publishCommand, artifacts: publish.artifactsCommand, gc: publish.gcCommand,
  commit: (context, flags) => {
    if (flags.positional.length) throw new UsageError("commit takes no positional arguments");
    ensureGit(context.vaultRoot);
    const committed = commitVault(context.vaultRoot, flags.values["message"]);
    if (committed) pushVault(context.vaultRoot);
    return { data: { committed, ...gitReport(context.vaultRoot) }, human: "" };
  },
};

const row = z.looseObject({ slug: z.string(), title: z.string() });
const artifact = z.looseObject({ name: z.string(), version: z.string(), kind: z.string(), url: z.string(), version_url: z.string() });
const outputSchemas: Record<string, z.ZodType> = {
  new: row.extend({ path: z.string() }),
  add: row.extend({ path: z.string(), markdown: z.boolean(), bytes: z.number() }),
  get: row.extend({ path: z.string(), content: z.string().optional(), frontmatter: z.record(z.string(), z.unknown()) }),
  path: z.object({ slug: z.string(), path: z.string() }),
  list: z.object({ documents: z.array(row.extend({ path: z.string(), tags: z.array(z.string()) })), count: z.number() }),
  search: z.object({ query: z.string(), hits: z.array(row.extend({ path: z.string(), snippet: z.string(), score: z.number() })), count: z.number() }),
  tags: z.object({ tags: z.array(z.object({ tag: z.string(), documents: z.number() })), count: z.number() }),
  resolve: z.object({ ref: z.string(), candidates: z.array(row.extend({ match: z.string(), score: z.number() })), count: z.number() }),
  links: row.extend({ outgoing: z.array(z.object({ to: z.string(), title: z.string(), kind: z.string() })), dangling: z.array(z.unknown()) }),
  backlinks: row.extend({ incoming: z.array(z.object({ from: z.string(), title: z.string(), kind: z.string() })) }),
  graph: z.looseObject({ nodes: z.array(z.unknown()), edges: z.array(z.unknown()), dangling: z.array(z.unknown()) }),
  doctor: z.looseObject({ vault: z.string(), healthy: z.boolean() }),
  reindex: z.looseObject({ documents: z.number(), index: z.string() }),
  rm: row.extend({ path: z.string(), deleted: z.string(), reason: z.string() }),
  restore: row.extend({ path: z.string(), restored: z.string() }),
  publish: artifact.extend({ status: z.enum(["created", "unchanged"]), stub: z.string() }),
  artifacts_list: z.object({ artifacts: z.array(artifact), count: z.number() }),
  artifacts_versions: z.object({ name: z.string(), versions: z.array(artifact) }),
  artifacts_show: artifact,
  artifacts_rm: z.object({ name: z.string(), tombstoned: z.array(artifact), reason: z.string(), stub: z.string().nullable() }),
  artifacts_restore: z.object({ name: z.string(), restored: z.array(artifact), stub: z.string().nullable() }),
  gc: z.looseObject({ reclaimed: z.array(z.unknown()), orphans: z.array(z.string()), bytes: z.number() }),
  commit: z.looseObject({ committed: z.boolean(), repo: z.boolean(), clean: z.boolean() }),
};

const contract = buildContract({ vaultRoot: "<AgentStack state>/wiki/vault", artifactHome: "<AgentStack state>/wiki/artifacts" });
const commandOperations = agentTools(contract)
  .filter((tool) => tool.name !== "guide")
  .map((tool) => {
    const output = outputSchemas[tool.name];
    if (!output || !handlers[tool.path[0]!]) throw new Error(`unmapped wiki operation: ${tool.name}`);
    return operation({
      name: tool.name, description: `${tool.leaf.summary}. ${tool.leaf.guidance ?? ""}`.slice(0, 400).trim(),
      input: tool.input, output,
      annotations: { title: tool.title, ...tool.annotations },
      async call(ctx: WikiContext, input: Record<string, unknown>) {
        const invocation = invocationFor(tool, input);
        try {
          const result = await handlers[invocation.name]!(ctx.command, invocation.flags);
          // As in agentwiki, the next API call also records edits made directly
          // to vault files. The fresh AgentStack vault has no remote by default.
          syncVault(ctx.command.vaultRoot);
          return result.data;
        } catch (error) {
          if (error instanceof CliError) {
            throw new Error([error.code, error.message, error.recovery].filter(Boolean).join("\n"));
          }
          throw error;
        }
      },
    });
  });

function port(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const value = env[name] === undefined ? fallback : Number(env[name]);
  if (!Number.isInteger(value) || value < 0 || value > 65535 || env[name] === "") {
    throw new Error(`${name} must be a port from 0 to 65535`);
  }
  return value;
}

export const api: PackageApi<WikiContext> = {
  operations: [
    operation({
      name: "wiki_status", description: "Read the isolated vault location and the document and artifact static origins. This store never reads the original agentwiki vault.",
      input: z.strictObject({}),
      output: z.object({ vault: z.string(), artifactStore: z.string(), documentsUrl: z.string(), artifactsUrl: z.string() }),
      annotations: { title: "Read wiki status", readOnlyHint: true },
      async call(ctx) { return { vault: ctx.command.vaultRoot, artifactStore: artifactHome(ctx.command.env, ctx.command.home), documentsUrl: ctx.server.url, artifactsUrl: ctx.server.artifactUrl }; },
    }),
    ...commandOperations,
  ],
  async createContext(env) {
    const home = homedir();
    const state = env.AGENTSTACK_STATE_DIR ?? join(home, ".local", "state", "agentstack");
    const vaultRoot = join(state, "wiki", "vault");
    ensureVault(vaultRoot);
    const command: Context = { env, home, cwd: process.cwd(), vaultRoot, now: nowIso,
      readStdin: async () => { throw new UsageError("use content or file; the Package API has no stdin"); }, stdinIsTerminal: true };
    const index = openIndex(command, { create: false });
    let store: ArtifactStore | undefined;
    try {
      store = ArtifactStore.open(env, home);
      const documentPort = port(env, "AGENTSTACK_WIKI_PORT", DEFAULT_PORT);
      const artifactPort = port(env, "AGENTSTACK_WIKI_ARTIFACT_PORT", DEFAULT_ARTIFACT_PORT);
      if (documentPort !== 0 && documentPort === artifactPort) throw new Error("wiki document and artifact ports must differ");
      const server = await startServer({ vaultRoot, casRoot: store.casRoot, index, store,
        port: documentPort, artifactPort, host: DEFAULT_HOST });
      return { command, server, index, store };
    } catch (error) { store?.close(); index.close(); throw error; }
  },
  async closeContext(ctx) {
    try { await ctx.server.stop(); }
    finally { ctx.store.close(); ctx.index.close(); }
  },
};
