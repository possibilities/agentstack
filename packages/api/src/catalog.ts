import { readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { PackageApi } from "./operation.js";
import { publishedJsonSchema } from "./schema.js";
import { configuredTransports } from "./config.js";
import { listPackages, socketPath, workspaceRoot } from "./workspace.js";

export type Catalog = {
  servers: Array<{
    name: string;
    description: string;
    packageName: string;
    operations: Array<{
      name: string;
      title?: string;
      description: string;
      annotations: Record<string, boolean | string>;
      inputSchema: Record<string, unknown>;
      outputSchema: Record<string, unknown>;
    }>;
    transports: Array<{
      type: string;
      description: string;
      available: boolean;
      endpoint?: string;
    }>;
  }>;
};

export async function loadCatalog(env: NodeJS.ProcessEnv = process.env, from = import.meta.dirname): Promise<Catalog> {
  const root = workspaceRoot(from);
  const packages = await listPackages(root);
  const servers = [];
  for (const item of packages) {
    const api = await loadPackageApi(item.dir);
    const manifest = JSON.parse(await readFile(join(item.dir, "package.json"), "utf8")) as { name?: string };
    servers.push({
      name: item.config.name,
      description: item.config.description,
      packageName: manifest.name || basename(item.dir),
      operations: api.operations.map((operation) => ({
        name: operation.name,
        title: operation.annotations?.title,
        description: operation.description,
        annotations: annotationsOf(operation.annotations),
        inputSchema: publishedJsonSchema(operation.input),
        outputSchema: publishedJsonSchema(operation.output),
      })),
      transports: configuredTransports(item.config).map((transport) =>
        transport.type === "socket"
          ? {
              type: transport.type,
              description: transport.description,
              available: true,
              endpoint: socketPath(item.config.name, env),
            }
          : { type: transport.type, description: transport.description, available: false },
      ),
    });
  }
  return { servers };
}

const importRuntimeFile = new Function("specifier", "return import(specifier)") as (
  specifier: string,
) => Promise<{ api?: PackageApi<unknown> }>;

export async function loadPackageApi(dir: string): Promise<PackageApi<unknown>> {
  const entry = join(dir, "dist", "src", "index.js");
  try {
    await stat(entry);
  } catch {
    throw new Error(`${basename(dir)} API is not built`);
  }
  const loaded = await importRuntimeFile(pathToFileURL(entry).href);
  if (!loaded.api || !Array.isArray(loaded.api.operations)) throw new Error(`${basename(dir)} does not export api`);
  return loaded.api;
}

function annotationsOf(annotations: PackageApi<unknown>["operations"][number]["annotations"]): Record<string, boolean | string> {
  if (!annotations) return {};
  const entries = Object.entries(annotations).filter((entry): entry is [string, boolean | string] => entry[1] !== undefined);
  return Object.fromEntries(entries);
}
