import { build } from "esbuild";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const app = process.argv[2];
if (app !== "cli" && app !== "daemon")
  throw new Error("expected cli or daemon");

const root = resolve(import.meta.dirname, "..");
const outputDirectory = resolve(root, "apps", app, "dist");
const result = await build({
  entryPoints: [resolve(root, "apps", app, "src", "main.ts")],
  outfile: resolve(outputDirectory, `${app}.mjs`),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  sourcemap: true,
  metafile: true,
  packages: "bundle",
  banner: { js: "#!/usr/bin/env node" },
});
await mkdir(outputDirectory, { recursive: true });
await writeFile(
  resolve(outputDirectory, `${app}.meta.json`),
  `${JSON.stringify(result.metafile, null, 2)}\n`,
);
