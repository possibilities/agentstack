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
if (manifest.engines && Object.prototype.hasOwnProperty.call(manifest.engines, "fx")) {
  throw new Error("retired manifest.engines.fx must not be present");
}
if (
  !manifest.engines ||
  typeof manifest.engines !== "object" ||
  Object.keys(manifest.engines).join(",") !== "codex"
) {
  throw new Error("manifest.engines must contain only codex");
}
for (const retired of [
  "engines/fx",
  "engines/fx/fx",
  "licenses/fx-LICENSE.txt",
  "licenses/fx-THIRD_PARTY_NOTICES.md",
]) {
  try {
    await lstat(join(stage, retired));
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") continue;
    throw error;
  }
  throw new Error(`retired Fx content must not be present: ${retired}`);
}
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
const vendorProvenance = JSON.parse(
  await readFile(join(stage, "provenance", "vendor-manifest.json"), "utf8"),
);
if (
  vendorProvenance.components &&
  Object.prototype.hasOwnProperty.call(vendorProvenance.components, "fx")
) {
  throw new Error("retired fx provenance must not be present");
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
