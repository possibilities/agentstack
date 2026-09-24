import { socketCall, socketPath, type CatalogServer } from "@agentstack/api";

type PackageSummary = { name: string; description: string; packageName: string };

export async function loadDocs(env: NodeJS.ProcessEnv = process.env): Promise<CatalogServer[]> {
  const socket = socketPath("api", env);
  const listed = await socketCall(socket, "tools/call", { name: "docs_list", arguments: {} }) as { packages?: PackageSummary[] };
  if (!Array.isArray(listed?.packages)) throw new Error("api docs_list returned no packages");
  const packages = listed.packages.filter((item) => item.name !== "api");
  return Promise.all(packages.map(async ({ name }) => {
    const doc = await socketCall(socket, "tools/call", { name: "docs_get", arguments: { package: name } }) as CatalogServer;
    if (doc?.name !== name || !Array.isArray(doc.operations) || !Array.isArray(doc.transports)) {
      throw new Error(`api docs_get returned an invalid document for ${name}`);
    }
    return {
      ...doc,
      transports: doc.transports.filter((transport) => transport.supported),
    };
  }));
}
