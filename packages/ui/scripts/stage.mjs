// Local release-candidate preparation only. Never publishes or changes the
// platform build, real HOME, package-manager policy or installed services.
import { spawn } from "node:child_process";
import { cp, mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { listPackages } from "@stack/api";

const ui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repository = resolve(ui, "../..");
const stage = resolve(process.argv[2] ?? join(ui, "dist", "package"));
const sourceManifest = JSON.parse(await readFile(join(ui, "package.json"), "utf8"));
const require = createRequire(join(ui, "package.json"));
// Fail rather than overwrite a candidate (including a partially built one).
await mkdir(dirname(stage), { recursive: true });
await mkdir(stage, { recursive: false });
await mkdir(join(ui, "dist"), { recursive: true });
await writeFile(join(ui, "dist", "portable-tsconfig.json"), JSON.stringify({
  extends: "../tsconfig.json",
  include: ["../next-env.d.ts", "../proxy.ts", "../app/**/*.ts", "../app/**/*.tsx", "../components/**/*.ts", "../components/**/*.tsx", "../lib/**/*.ts", "../lib/**/*.tsx", "./next/types/**/*.ts"],
  exclude: ["../node_modules", "./next/standalone"],
}));
await new Promise((done, reject) => {
  const child = spawn(process.execPath, [require.resolve("next/dist/bin/next"), "build"], {
    cwd: ui, stdio: "inherit", env: { ...process.env, STACK_UI_PORTABLE_BUILD: "1", NEXT_TELEMETRY_DISABLED: "1" },
  });
  child.once("error", reject);
  child.once("exit", code => code === 0 ? done() : reject(new Error(`portable_build_failed:${code}`)));
});

const build = join(ui, "dist", "next");
const standalone = join(build, "standalone", "packages", "ui", "dist", "next");
await cp(standalone, join(stage, ".next"), { recursive: true, dereference: true,
  filter: path => !path.endsWith(".nft.json") });
await cp(join(build, "static"), join(stage, ".next", "static"), { recursive: true, dereference: true });
if (await stat(join(ui, "public")).catch(() => null)) {
  await cp(join(ui, "public"), join(stage, "public"), { recursive: true, dereference: true });
}
await cp(join(ui, "bin"), join(stage, "bin"), { recursive: true, dereference: true });
await mkdir(join(stage, "lib", "client"), { recursive: true });
for (const name of ["security.mjs", "release.mjs"]) {
  await cp(join(ui, "lib", "client", name), join(stage, "lib", "client", name));
}

const serverFiles = JSON.parse(await readFile(join(build, "required-server-files.json"), "utf8"));
const config = serverFiles.config;
config.distDir = ".next";
config.outputFileTracingRoot = ".";
config.repoRoot = ".";
if (config.turbopack) config.turbopack.root = ".";
config.typescript.tsconfigPath = "tsconfig.json";
delete config.configFile;
delete config.outputFileTracingIncludes;
delete config.outputFileTracingExcludes;
await writeFile(join(stage, "next-runtime.json"), JSON.stringify(config));
// Next reads this serialized configuration too. No source checkout paths remain
// in the runtime manifest; build-time trace lists are not runtime resources.
await writeFile(join(stage, ".next", "required-server-files.json"), JSON.stringify({
  ...serverFiles, config, appDir: ".", relativeAppDir: ".", files: [], ignore: [],
}));
await writeFile(join(stage, "stack-package-resources.json"), JSON.stringify({ version: 1, kind: "package-api-resources" }));
for (const { dir, config } of await listPackages(repository)) {
  const target = join(stage, "packages", config.name);
  await mkdir(target, { recursive: true });
  await cp(join(dir, "api.yaml"), join(target, "api.yaml"));
}

// Next explicitly does not trace a custom server. Materialize the complete
// runtime closure ourselves, using Node's actual installed resolution, not
// workspace ranges or pnpm's virtual-store layout. Conflicting versions nest
// under their consumer just like an ordinary npm install. No symlinks survive.
const placed = new Map(), packages = [], omissions = new Set();
const scripts = ["preinstall", "install", "postinstall"];
const excluded = name => name === "sharp" || name.startsWith("@next/swc-") || name === "@playwright/test"
  || name === "babel-plugin-react-compiler" || name === "sass";
async function locate(from, name) {
  for (let dir = from; ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", name);
    if (await stat(join(candidate, "package.json")).catch(() => null)) return realpath(candidate);
    if (dirname(dir) === dir) throw new Error(`runtime_dependency_missing:${name}`);
  }
}
async function installed(consumer, name) {
  for (let dir = consumer; ; dir = dirname(dir)) {
    const target = join(dir, "node_modules", name);
    if (placed.has(target)) return { target, source: placed.get(target) };
    if (dir === stage) return null;
  }
}
async function materialize(source, name, consumer = stage) {
  const existing = await installed(consumer, name);
  if (existing?.source === source) return existing.target;
  const rootTarget = join(stage, "node_modules", name);
  const target = placed.has(rootTarget) ? join(consumer, "node_modules", name) : rootTarget;
  if (placed.has(target)) throw new Error(`runtime_dependency_conflict:${name}`);
  placed.set(target, source);
  const manifest = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
  const lifecycle = scripts.filter(key => manifest.scripts?.[key]);
  // A new lifecycle dependency requires a reviewed decision, not an implicit
  // approval or silent skipping of a potentially necessary native build.
  if (lifecycle.length) throw new Error(`unreviewed_runtime_build_script:${name}:${lifecycle.join(",")}`);
  const workspace = source.startsWith(`${repository}/packages/`);
  await mkdir(target, { recursive: true });
  if (workspace) {
    await cp(join(source, "dist"), join(target, "dist"), { recursive: true, dereference: true,
      filter: path => !relative(join(source, "dist"), path).split("/").includes("test") && !path.endsWith(".map") });
  } else {
    await cp(source, target, { recursive: true, dereference: true,
      filter: path => !relative(source, path).split("/").some(part => part === "node_modules" || part === ".git") });
  }
  const dependencies = {};
  const entries = new Map(Object.entries(manifest.dependencies ?? {}).map(([name]) => [name, false]));
  for (const name of Object.keys(manifest.optionalDependencies ?? {})) entries.set(name, true);
  for (const name of Object.keys(manifest.peerDependencies ?? {})) {
    if (!entries.has(name)) entries.set(name, manifest.peerDependenciesMeta?.[name]?.optional === true);
  }
  for (const [dependency, optional] of entries) {
    if (optional && excluded(dependency)) { omissions.add(dependency); continue; }
    let dependencySource;
    try { dependencySource = await locate(source, dependency); }
    catch (error) { if (!optional) throw error; omissions.add(dependency); continue; }
    const pinned = JSON.parse(await readFile(join(dependencySource, "package.json"), "utf8"));
    dependencies[dependency] = pinned.version;
    await materialize(dependencySource, dependency, target);
  }
  // Runtime bundles need no package-manager scripts, development dependencies,
  // workspace protocols, optional downloads or peer auto-installation.
  for (const key of ["scripts", "devDependencies", "peerDependencies", "peerDependenciesMeta", "optionalDependencies", "packageManager", "devEngines"]) delete manifest[key];
  manifest.dependencies = dependencies;
  await writeFile(join(target, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
  packages.push({ name: manifest.name, version: manifest.version, path: relative(stage, target) });
  return target;
}
// shadcn is authoring tooling, not a runtime dependency; do not ship its CLI,
// watchers, native parsers or their lifecycle scripts. CSS has already compiled.
for (const name of Object.keys(sourceManifest.dependencies).filter(name => !["shadcn", "tw-animate-css"].includes(name))) {
  await materialize(await locate(ui, name), name);
}
const dependencies = {};
for (const [target] of placed) {
  const manifest = JSON.parse(await readFile(join(target, "package.json"), "utf8"));
  if (target === join(stage, "node_modules", manifest.name)) {
    dependencies[manifest.name] = manifest.version;
  }
}
await writeFile(join(stage, "package.json"), JSON.stringify({
  name: sourceManifest.name, version: sourceManifest.version, private: true,
  description: "Independent Stack Client UI — unpublished release candidate",
  bin: sourceManifest.bin, engines: sourceManifest.engines,
  files: ["bin", "lib", ".next", "public", "next-runtime.json", "stack-package-resources.json", "packages", "packaging.json"],
  dependencies, bundledDependencies: Object.keys(dependencies).sort(),
}, null, 2) + "\n");
await writeFile(join(stage, "packaging.json"), JSON.stringify({
  version: 1, node: sourceManifest.engines.node, packages: packages.sort((a, b) => a.path.localeCompare(b.path)),
  omittedOptionalDependencies: [...omissions].sort(),
  excludedAuthoringDependencies: ["shadcn", "tw-animate-css"],
}, null, 2) + "\n");
let files = 0, bytes = 0;
async function inventory(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`stage_symlink_refused:${relative(stage, path)}`);
    if (entry.isDirectory()) await inventory(path);
    else { files++; bytes += (await stat(path)).size; }
  }
}
await inventory(stage);
console.log(JSON.stringify({ stage, files, bytes, packages: packages.length, engines: sourceManifest.engines }));
