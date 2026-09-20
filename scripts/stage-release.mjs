import { createHash } from "node:crypto";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

const root = resolve(import.meta.dirname, "..");
const packageJson = JSON.parse(
  await readFile(join(root, "package.json"), "utf8"),
);
const target = "linux-x64";
const outputIndex = process.argv.indexOf("--output");
const output = resolve(
  outputIndex >= 0
    ? process.argv[outputIndex + 1]
    : join(
        root,
        "artifacts",
        `stage-agentstack-${packageJson.version}-${target}`,
      ),
);
const vendorRoot = join(root, "vendor");
const vendorManifest = JSON.parse(
  await readFile(join(vendorRoot, "manifest.json"), "utf8"),
);

function component(name) {
  const value = vendorManifest.components?.[name];
  if (!value || typeof value.sha256 !== "string") {
    throw new Error(`vendor manifest missing components.${name}`);
  }
  const payloadPath =
    value.payloadPath ?? join(vendorManifest.payloadRoot ?? "payloads", name);
  return { ...value, payloadPath };
}

async function sha256(path) {
  const hash = createHash("sha256");
  hash.update(await readFile(path));
  return hash.digest("hex");
}

async function copyVerified(name, destination, executableOnly = false) {
  const entry = component(name);
  const source = entry.payloadPath.startsWith("vendor/")
    ? resolve(root, entry.payloadPath)
    : resolve(vendorRoot, entry.payloadPath);
  const canonicalVendor = await realpath(vendorRoot);
  const canonicalSource = await realpath(source);
  if (
    canonicalSource !== canonicalVendor &&
    !canonicalSource.startsWith(`${canonicalVendor}${sep}`)
  )
    throw new Error(`${name} payload escapes vendor root`);
  const info = await lstat(source);
  if (info.isSymbolicLink())
    throw new Error(`${name} payload must not be a symlink`);
  await mkdir(dirname(destination), { recursive: true });
  let executable;
  if (executableOnly) {
    if (!info.isDirectory() || typeof entry.executable !== "string")
      throw new Error(`${name} executable path is required`);
    executable = destination;
    await cp(resolve(source, entry.executable), executable, {
      dereference: false,
      preserveTimestamps: false,
    });
  } else {
    await cp(source, destination, {
      recursive: true,
      dereference: false,
      preserveTimestamps: false,
    });
    executable = info.isDirectory()
      ? join(destination, entry.executable ?? basename(source))
      : destination;
  }
  const digest = await sha256(executable);
  if (digest !== entry.sha256)
    throw new Error(`${name} payload digest mismatch: ${digest}`);
  await chmod(executable, 0o755);
  return { entry, executable: relative(output, executable) };
}

await rm(output, { recursive: true, force: true });
await mkdir(join(output, "apps"), { recursive: true });
await cp(
  join(root, "apps", "cli", "dist", "cli.mjs"),
  join(output, "apps", "cli.mjs"),
);
await cp(
  join(root, "apps", "daemon", "dist", "daemon.mjs"),
  join(output, "apps", "daemon.mjs"),
);
await chmod(join(output, "apps", "cli.mjs"), 0o755);
await chmod(join(output, "apps", "daemon.mjs"), 0o755);
await cp(join(vendorRoot, "licenses"), join(output, "licenses"), {
  recursive: true,
  dereference: false,
  preserveTimestamps: false,
});
await mkdir(join(output, "provenance"), { recursive: true });
await cp(
  join(vendorRoot, "manifest.json"),
  join(output, "provenance", "vendor-manifest.json"),
);
await cp(
  join(vendorRoot, "PROVENANCE.md"),
  join(output, "provenance", "VENDOR.md"),
);

const node = await copyVerified("node", join(output, "runtime", "node"), true);
const codex = await copyVerified("codex", join(output, "engines", "codex"));
const gitRevision = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).trim();
const manifest = {
  schemaVersion: 1,
  productVersion: packageJson.version,
  buildIdentity: `git:${gitRevision}`,
  target,
  runtime: {
    version: node.entry.version,
    executable: node.executable,
    sha256: node.entry.sha256,
  },
  engines: {
    codex: {
      version: codex.entry.version,
      executable: codex.executable,
      args:
        codex.entry.args?.length > 0
          ? codex.entry.args
          : ["--session-source", "app-server"],
      sha256: codex.entry.sha256,
      source: codex.entry.source,
    },
};
await writeFile(
  join(output, "manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
);
console.log(output);
