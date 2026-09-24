import { socketCall, socketPath, type CatalogServer } from "@agentstack/api";

export async function loadDocs(env: NodeJS.ProcessEnv = process.env): Promise<CatalogServer[]> {
  const socket = socketPath("api", env);
  const snapshot = await socketCall(socket, "tools/call", { name: "docs_snapshot", arguments: {} }) as { packages?: CatalogServer[] };
  if (!Array.isArray(snapshot?.packages) || snapshot.packages.some((doc) =>
    typeof doc?.name !== "string" || !Array.isArray(doc.operations) || !Array.isArray(doc.transports))) {
    throw new Error("api docs_snapshot returned invalid packages");
  }
  return snapshot.packages.filter((doc) => doc.name !== "api").map((doc) => ({
    ...doc, transports: doc.transports.filter((transport) => transport.supported),
  }));
}
