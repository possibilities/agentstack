import { createHash } from "node:crypto";
import { lstat, readFile, realpath, readdir } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");
const packageManifest = JSON.parse(
  await readFile(join(repositoryRoot, "package.json"), "utf8"),
);
const stage = resolve(
  process.argv[2] ??
    join(
      repositoryRoot,
      "artifacts",
      `stage-agentstack-${packageManifest.version}-linux-x64`,
    ),
);
const manifest = JSON.parse(
  await readFile(join(stage, "manifest.json"), "utf8"),
);

async function digest(path) {
  const hash = createHash("sha256");
  hash.update(await readFile(path));
  return hash.digest("hex");
}

async function walk(path) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    const info = await lstat(child);
    if (info.isSymbolicLink()) {
      const resolved = await realpath(child);
      const root = await realpath(stage);
      if (resolved !== root && !resolved.startsWith(`${root}${sep}`))
        throw new Error(`escaping symlink: ${child}`);
    } else if (entry.isDirectory()) await walk(child);
  }
}

await walk(stage);
for (const component of [
  manifest.runtime,
  manifest.engines.codex,
]) {
  const executable = resolve(stage, component.executable);
  const root = await realpath(stage);
  const resolved = await realpath(executable);
  if (!resolved.startsWith(`${root}${sep}`))
    throw new Error(`executable escapes stage: ${component.executable}`);
  const actual = await digest(executable);
  if (actual !== component.sha256)
    throw new Error(`digest mismatch: ${component.executable}`);
}
for (const app of ["apps/cli.mjs", "apps/daemon.mjs"])
  await readFile(join(stage, app));
for (const evidence of [
  "licenses/node-LICENSE.txt",
  "licenses/codex-LICENSE.txt",
  "licenses/codex-NOTICE.txt",
  "provenance/vendor-manifest.json",
  "provenance/VENDOR.md",
]) {
  await readFile(join(stage, evidence));
}
if (
  manifest.engines.codex.source?.archiveSha256 !==
  "a1784b0f3991e4853caaddcc167d2bc8c540f12eddb1b5e40b1ec49f2dbcc024"
) {
  throw new Error("Codex archive provenance digest mismatch");
}
console.log(
  JSON.stringify({
    ok: true,
    stage,
    productVersion: manifest.productVersion,
    target: manifest.target,
  }),
);
