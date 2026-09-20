#!/usr/bin/env node
import { constants } from "node:fs";
import {
  access,
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packagingRoot = join(repositoryRoot, "packaging", "linux");
const debianTemplate = join(packagingRoot, "debian");

function usage() {
  return `Usage: node scripts/package-deb.mjs --stage DIRECTORY --output DIRECTORY [options]

Build an amd64 Debian package from a verified staged release.

Required:
  --stage DIRECTORY       staged release containing manifest.json, runtime/node,
                          apps/{cli,daemon}.mjs, engines/codex, and licenses/
  --output DIRECTORY      destination for agentstack_VERSION_amd64.deb

Options:
  --version VERSION       must equal manifest.productVersion
  --source-date-epoch N  Unix timestamp; defaults to SOURCE_DATE_EPOCH
  --plan                 validate and print the package plan without invoking
                         Debian build tools
  --keep-workspace       retain the temporary Debian source workspace
  --help                 show this help
`;
}

function fail(message) {
  throw new Error(`package-deb: ${message}`);
}

function parseArgs(argv) {
  const result = { plan: false, keepWorkspace: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--plan") {
      result.plan = true;
    } else if (argument === "--keep-workspace") {
      result.keepWorkspace = true;
    } else if (argument === "--help" || argument === "-h") {
      result.help = true;
    } else if (
      ["--stage", "--output", "--version", "--source-date-epoch"].includes(
        argument,
      )
    ) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--"))
        fail(`${argument} requires a value`);
      result[argument.slice(2).replaceAll("-", "_")] = value;
      index += 1;
    } else {
      fail(`unknown argument: ${argument}`);
    }
  }
  return result;
}

function isInside(root, candidate) {
  const path = relative(root, candidate);
  return (
    path === "" ||
    (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path))
  );
}

async function requireFile(path, description, executable = false) {
  let details;
  try {
    details = await lstat(path);
  } catch {
    fail(`missing ${description}: ${path}`);
  }
  if (!details.isFile()) fail(`${description} must be a regular file: ${path}`);
  if (executable) {
    try {
      await access(path, constants.X_OK);
    } catch {
      fail(`${description} is not executable: ${path}`);
    }
  }
}

async function validateNoEscapingLinks(root, current = root) {
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) {
      await validateNoEscapingLinks(root, path);
      continue;
    }
    if (!entry.isSymbolicLink()) continue;
    const target = await readlink(path);
    if (isAbsolute(target) || !isInside(root, resolve(dirname(path), target))) {
      fail(`staged payload link escapes release root: ${path} -> ${target}`);
    }
  }
}

function validateComponent(component, name) {
  if (!component || typeof component !== "object" || Array.isArray(component))
    fail(`manifest.${name} is required`);
  if (typeof component.version !== "string" || !component.version)
    fail(`manifest.${name}.version is required`);
  if (typeof component.executable !== "string" || !component.executable)
    fail(`manifest.${name}.executable is required`);
  if (
    typeof component.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(component.sha256)
  ) {
    fail(`manifest.${name}.sha256 must be a SHA-256 digest`);
  }
}

function validateManifest(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest))
    fail("manifest.json must be an object");
  const { productVersion, buildIdentity, target, runtime, engines } = manifest;
  if (
    typeof productVersion !== "string" ||
    !/^[0-9][A-Za-z0-9.+:~\-]*$/.test(productVersion)
  ) {
    fail("manifest.productVersion is not a Debian-compatible version");
  }
  if (typeof buildIdentity !== "string" || buildIdentity.length === 0)
    fail("manifest.buildIdentity is required");
  if (
    typeof target !== "string" ||
    !/linux/i.test(target) ||
    !/(amd64|x86_64|x64)/i.test(target)
  ) {
    fail("manifest.target must identify a Linux amd64 payload");
  }
  validateComponent(runtime, "runtime");
  if (!engines || typeof engines !== "object" || Array.isArray(engines))
    fail("manifest.engines is required");
  for (const name of ["codex"]) {
    const engine = engines[name];
    validateComponent(engine, `engines.${name}`);
    if (
      !Array.isArray(engine.args) ||
      !engine.args.every((argument) => typeof argument === "string")
    ) {
      fail(`manifest.engines.${name}.args must be a string array`);
    }
  }
  return manifest;
}

async function requireDeclaredExecutable(stage, executable, name) {
  if (isAbsolute(executable) || !isInside(stage, resolve(stage, executable))) {
    fail(
      `manifest ${name}.executable escapes the staged release: ${executable}`,
    );
  }
  try {
    await access(resolve(stage, executable), constants.X_OK);
  } catch {
    fail(`manifest ${name}.executable is not executable: ${executable}`);
  }
}

async function inspectStage(stageDirectory, requestedVersion) {
  const stage = resolve(stageDirectory);
  let stageInfo;
  try {
    stageInfo = await lstat(stage);
  } catch {
    fail(`staging directory does not exist: ${stage}`);
  }
  if (!stageInfo.isDirectory() || stageInfo.isSymbolicLink())
    fail(`staging directory must be a real directory: ${stage}`);
  await requireFile(join(stage, "manifest.json"), "manifest.json");
  await requireFile(join(stage, "runtime", "node"), "runtime/node", true);
  await requireFile(join(stage, "apps", "cli.mjs"), "apps/cli.mjs");
  await requireFile(join(stage, "apps", "daemon.mjs"), "apps/daemon.mjs");
  let licenseInfo;
  try {
    licenseInfo = await lstat(join(stage, "licenses"));
  } catch {
    fail("missing licenses directory");
  }
  if (!licenseInfo.isDirectory() || licenseInfo.isSymbolicLink())
    fail("licenses must be a real directory");
  for (const engine of ["codex"]) {
    let info;
    try {
      info = await lstat(join(stage, "engines", engine));
    } catch {
      fail(`missing engines/${engine} directory`);
    }
    if (!info.isDirectory() || info.isSymbolicLink())
      fail(`engines/${engine} must be a real directory`);
  }
  await validateNoEscapingLinks(stage);
  const manifest = validateManifest(
    JSON.parse(await readFile(join(stage, "manifest.json"), "utf8")),
  );
  await requireDeclaredExecutable(
    stage,
    manifest.runtime.executable,
    "runtime",
  );
  for (const name of ["codex"]) {
    await requireDeclaredExecutable(
      stage,
      manifest.engines[name].executable,
      `engines.${name}`,
    );
  }
  if (requestedVersion && requestedVersion !== manifest.productVersion) {
    fail(
      `--version ${requestedVersion} does not match manifest.productVersion ${manifest.productVersion}`,
    );
  }
  return { stage, manifest, version: manifest.productVersion };
}

function sourceDateEpoch(value) {
  if (!value || !/^[0-9]+$/.test(value)) {
    fail(
      "set SOURCE_DATE_EPOCH or pass --source-date-epoch with an integer Unix timestamp",
    );
  }
  const epoch = Number(value);
  if (!Number.isSafeInteger(epoch) || epoch < 0)
    fail("SOURCE_DATE_EPOCH must be a non-negative safe integer");
  return epoch;
}

function run(command, args, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: "inherit",
    });
    child.once("error", (error) => rejectRun(error));
    child.once("exit", (code, signal) => {
      if (code === 0) resolveRun();
      else
        rejectRun(
          new Error(
            `${command} ${args.join(" ")} failed (${signal ?? `exit ${code}`})`,
          ),
        );
    });
  });
}

async function copyFileWithMode(source, destination, mode) {
  await cp(source, destination, { force: true, preserveTimestamps: true });
  await chmod(destination, mode);
}

async function writeChangelog(path, version, epoch) {
  const date = new Date(epoch * 1000).toUTCString().replace("GMT", "+0000");
  await writeFile(
    path,
    `agentstack (${version}) unstable; urgency=medium\n\n  * Package the ${version} immutable AgentStack release.\n\n -- AgentStack contributors <maintainers@agentstack.invalid>  ${date}\n`,
    "utf8",
  );
}

async function materializeSource(plan, epoch) {
  const workspace = await mkdtemp(join(tmpdir(), "agentstack-debian-"));
  const sourceRoot = join(workspace, `agentstack-${plan.version}`);
  const debianRoot = join(sourceRoot, "debian");
  await mkdir(sourceRoot, { recursive: true });
  await cp(debianTemplate, debianRoot, {
    recursive: true,
    preserveTimestamps: true,
    force: true,
  });
  await chmod(join(debianRoot, "rules"), 0o755);
  await writeChangelog(join(debianRoot, "changelog"), plan.version, epoch);

  const packageRoot = join(sourceRoot, "payload");
  const releaseRoot = join(
    packageRoot,
    "usr",
    "lib",
    "agentstack",
    "releases",
    plan.version,
  );
  await mkdir(dirname(releaseRoot), { recursive: true });
  await cp(plan.stage, releaseRoot, {
    recursive: true,
    preserveTimestamps: true,
    force: true,
  });
  await symlink(
    `releases/${plan.version}`,
    join(packageRoot, "usr", "lib", "agentstack", "current"),
  );
  await mkdir(join(packageRoot, "usr", "bin"), { recursive: true });
  await copyFileWithMode(
    join(packagingRoot, "agentstack-launcher"),
    join(packageRoot, "usr", "bin", "agentstack"),
    0o755,
  );
  await mkdir(join(packageRoot, "usr", "lib", "systemd", "user"), {
    recursive: true,
  });
  await copyFileWithMode(
    join(debianRoot, "agentstack.user.service"),
    join(packageRoot, "usr", "lib", "systemd", "user", "agentstack.service"),
    0o644,
  );
  await mkdir(join(packageRoot, "usr", "share", "doc", "agentstack"), {
    recursive: true,
  });
  await cp(
    join(debianRoot, "copyright"),
    join(packageRoot, "usr", "share", "doc", "agentstack", "copyright"),
    {
      force: true,
      preserveTimestamps: true,
    },
  );
  await mkdir(join(packageRoot, "usr", "share", "man", "man1"), {
    recursive: true,
  });
  return { workspace, sourceRoot };
}

async function compressManpage(sourceRoot, epoch) {
  const source = join(packagingRoot, "agentstack.1");
  const output = join(
    sourceRoot,
    "payload",
    "usr",
    "share",
    "man",
    "man1",
    "agentstack.1.gz",
  );
  await new Promise((resolveWrite, rejectWrite) => {
    const gzip = spawn("gzip", ["-n", "-9", "-c", source], {
      env: { ...process.env, SOURCE_DATE_EPOCH: String(epoch) },
    });
    const chunks = [];
    gzip.stdout.on("data", (chunk) => chunks.push(chunk));
    gzip.once("error", rejectWrite);
    gzip.once("exit", async (code) => {
      if (code !== 0)
        return rejectWrite(new Error(`gzip failed with exit ${code}`));
      try {
        await writeFile(output, Buffer.concat(chunks));
        resolveWrite();
      } catch (error) {
        rejectWrite(error);
      }
    });
  });
}

async function build(plan, outputDirectory, epoch, keepWorkspace) {
  const { workspace, sourceRoot } = await materializeSource(plan, epoch);
  try {
    await compressManpage(sourceRoot, epoch);
    const env = {
      ...process.env,
      SOURCE_DATE_EPOCH: String(epoch),
      DEB_BUILD_OPTIONS:
        `${process.env.DEB_BUILD_OPTIONS ?? ""} reproducible=+fixdebugpath`.trim(),
    };
    await run("dpkg-buildpackage", ["-us", "-uc", "-b"], {
      cwd: sourceRoot,
      env,
    });
    const built = join(workspace, `agentstack_${plan.version}_amd64.deb`);
    await requireFile(built, "built Debian package");
    await mkdir(outputDirectory, { recursive: true });
    const destination = join(outputDirectory, basename(built));
    await cp(built, destination, { force: true, preserveTimestamps: true });
    return { destination, workspace };
  } finally {
    if (!keepWorkspace) await rm(workspace, { recursive: true, force: true });
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  if (!options.stage) fail("--stage is required");
  if (!options.output && !options.plan)
    fail("--output is required unless --plan is used");
  const plan = await inspectStage(options.stage, options.version);
  const epoch = sourceDateEpoch(
    options.source_date_epoch ?? process.env.SOURCE_DATE_EPOCH,
  );
  const printable = {
    package: "agentstack",
    version: plan.version,
    architecture: "amd64",
    stage: plan.stage,
    sourceDateEpoch: epoch,
    files: [
      "/usr/bin/agentstack",
      `/usr/lib/agentstack/releases/${plan.version}/`,
      `/usr/lib/agentstack/releases/${plan.version}/licenses/`,
      "/usr/lib/agentstack/current",
      "/usr/lib/systemd/user/agentstack.service",
      "/usr/share/doc/agentstack/copyright",
      "/usr/share/man/man1/agentstack.1.gz",
    ],
    noMaintainerScripts: true,
  };
  if (options.plan) {
    process.stdout.write(`${JSON.stringify(printable, null, 2)}\n`);
    return;
  }
  const { destination, workspace } = await build(
    plan,
    resolve(options.output),
    epoch,
    options.keepWorkspace,
  );
  process.stdout.write(
    `${JSON.stringify({ ...printable, destination, ...(options.keepWorkspace ? { workspace } : {}) }, null, 2)}\n`,
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}

export { inspectStage, parseArgs, sourceDateEpoch, validateManifest };
