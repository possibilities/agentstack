import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";

const { z } = createRequire(import.meta.resolve("@agentstack/api"))("zod");
export const passthrough = z.unknown();

/** Gateways resolve live metadata for every declared package. Fixture workspaces
 * must declare exactly their own sockets, independently of the real workspace. */
export async function fixtureWorkspace(directory, names) {
  const root = join(directory, "workspace");
  for (const name of names) {
    const dir = join(root, "packages", name);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "api.yaml"), `name: ${name}\ndescription: Fixture.\nsocket:\n  description: Fixture.\nwebsocket:\n  description: Fixture.\n  operations: all\n  events: all\n`);
  }
  return root;
}

export function transport(endpoint, operations = [], events = [], type = "websocket") {
  return { type, endpoint, description: "Isolated fixture", supported: true, subscriptions: events.length > 0, operations, events, routes: [] };
}
