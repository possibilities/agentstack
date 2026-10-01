import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";

const directory = process.cwd();
const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
if (!["@stack/access", "@stack/api", "@stack/cli", "@stack/client", "@stack/signal", "@stack/auth", "@stack/bots", "@stack/browse", "@stack/roles", "@stack/serve", "@stack/worker", "@stack/usage", "@stack/infer", "@stack/content", "@stack/brain", "@stack/source", "@stack/xcom", "@stack/notify", "@stack/hud", "@stack/scrape", "@stack/proc", "@stack/settings"].includes(manifest.name)) {
  throw new Error(`refusing to clean dist outside an Stack package: ${directory}`);
}
await rm(join(directory, "dist"), { recursive: true, force: true });
