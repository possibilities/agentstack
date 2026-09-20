#!/usr/bin/env node
import { createHash } from "node:crypto";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

function usage() {
  return `Usage: node scripts/inspect-deb.mjs --package FILE [--version VERSION] [--json]\n`;
}

function fail(message) {
  throw new Error(`inspect-deb: ${message}`);
}

function parseArgs(argv) {
  const result = { json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") result.json = true;
    else if (argument === "--help" || argument === "-h") result.help = true;
    else if (argument === "--package" || argument === "--version") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--"))
        fail(`${argument} requires a value`);
      result[argument.slice(2)] = value;
      index += 1;
    } else fail(`unknown argument: ${argument}`);
  }
  return result;
}

function run(command, args, input) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      stdio: [input ? "pipe" : "ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", rejectRun);
    child.once("exit", (code, signal) => {
      if (code === 0) return resolveRun(Buffer.concat(stdout));
      rejectRun(
        new Error(
          `${command} ${args.join(" ")} failed (${signal ?? `exit ${code}`}): ${Buffer.concat(stderr).toString("utf8").trim()}`,
        ),
      );
    });
    if (input) child.stdin.end(input);
  });
}

function extractFile(packagePath, path) {
  return new Promise((resolveExtract, rejectExtract) => {
    const archive = spawn("dpkg-deb", ["--fsys-tarfile", packagePath], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const extract = spawn("tar", ["-xOf", "-", `.${path}`], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const chunks = [];
    const errors = [];
    archive.stdout.pipe(extract.stdin);
    archive.stderr.on("data", (chunk) => errors.push(chunk));
    extract.stderr.on("data", (chunk) => errors.push(chunk));
    extract.stdout.on("data", (chunk) => chunks.push(chunk));
    let archiveCode;
    let extractCode;
    const finish = () => {
      if (archiveCode === undefined || extractCode === undefined) return;
      if (archiveCode === 0 && extractCode === 0)
        resolveExtract(Buffer.concat(chunks));
      else
        rejectExtract(
          new Error(
            `failed to extract ${path}: ${Buffer.concat(errors).toString("utf8").trim()}`,
          ),
        );
    };
    archive.once("error", rejectExtract);
    extract.once("error", rejectExtract);
    archive.once("exit", (code) => {
      archiveCode = code;
      finish();
    });
    extract.once("exit", (code) => {
      extractCode = code;
      finish();
    });
  });
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function normalizedEntries(listing) {
  return listing
    .toString("utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const match = /(?:\s)(\.\/\S*)(?:\s+->\s+(.*))?$/.exec(line);
      if (!match?.[1]) fail(`cannot parse dpkg-deb contents line: ${line}`);
      return {
        path: match[1].replace(/^\.\//, "/"),
        linkTarget: match[2] ?? null,
      };
    });
}

function requireEntry(entries, path) {
  if (
    !entries.some(
      (entry) => entry.path === path || entry.path.startsWith(`${path}/`),
    )
  ) {
    fail(`missing required package path: ${path}`);
  }
}

async function inspect(packagePath, expectedVersion) {
  const file = resolve(packagePath);
  try {
    await access(file, constants.R_OK);
  } catch {
    fail(`cannot read package: ${file}`);
  }
  if (!basename(file).endsWith(".deb")) fail(`not a .deb file: ${file}`);
  const fields = (
    await run("dpkg-deb", [
      "--field",
      file,
      "Package",
      "Version",
      "Architecture",
    ])
  )
    .toString("utf8")
    .trim()
    .split("\n")
    .reduce((result, line) => {
      const separator = line.indexOf(":");
      if (separator > 0)
        result[line.slice(0, separator)] = line.slice(separator + 1).trim();
      return result;
    }, {});
  if (fields.Package !== "agentstack")
    fail(`expected Package: agentstack, got ${fields.Package ?? "(missing)"}`);
  if (fields.Architecture !== "amd64")
    fail(
      `expected Architecture: amd64, got ${fields.Architecture ?? "(missing)"}`,
    );
  if (expectedVersion && fields.Version !== expectedVersion)
    fail(
      `expected Version: ${expectedVersion}, got ${fields.Version ?? "(missing)"}`,
    );
  const version = fields.Version;
  if (!version) fail("package version is missing");

  const entries = normalizedEntries(
    await run("dpkg-deb", ["--contents", file]),
  );
  for (const path of [
    "/usr/bin/agentstack",
    `/usr/lib/agentstack/releases/${version}`,
    `/usr/lib/agentstack/releases/${version}/licenses`,
    "/usr/lib/systemd/user/agentstack.service",
    "/usr/share/doc/agentstack/copyright",
    "/usr/share/man/man1/agentstack.1.gz",
  ]) {
    requireEntry(entries, path);
  }
  const current = entries.find(
    (entry) => entry.path === "/usr/lib/agentstack/current",
  );
  if (!current || current.linkTarget !== `releases/${version}`) {
    fail(`/usr/lib/agentstack/current must link to releases/${version}`);
  }
  for (const forbidden of ["/usr/local", "/etc", "/var", "/home", "/run"]) {
    if (
      entries.some(
        (entry) =>
          entry.path === forbidden || entry.path.startsWith(`${forbidden}/`),
      )
    ) {
      fail(`package must not write ${forbidden}`);
    }
  }

  const controlEntries = (
    await run(
      "tar",
      ["-tf", "-"],
      await run("dpkg-deb", ["--ctrl-tarfile", file]),
    )
  )
    .toString("utf8")
    .split("\n")
    .filter(Boolean)
    .map((entry) => entry.replace(/^\.\//, ""));
  const maintainerScripts = ["preinst", "postinst", "prerm", "postrm"].filter(
    (name) => controlEntries.includes(name),
  );
  if (maintainerScripts.length > 0)
    fail(
      `package must not contain maintainer scripts: ${maintainerScripts.join(", ")}`,
    );

  const unit = (
    await run(
      "tar",
      ["-xOf", "-", "./usr/lib/systemd/user/agentstack.service"],
      await run("dpkg-deb", ["--fsys-tarfile", file]),
    )
  ).toString("utf8");
  for (const line of [
    "Type=exec",
    "ExecStart=/usr/bin/agentstack daemon",
    "Restart=on-failure",
    "KillMode=mixed",
    "RuntimeDirectory=agentstack",
    "RuntimeDirectoryMode=0700",
    "UMask=0077",
  ]) {
    if (!unit.includes(line)) fail(`unit is missing ${line}`);
  }
  const releaseRoot = `/usr/lib/agentstack/releases/${version}`;
  const manifest = JSON.parse(
    (await extractFile(file, `${releaseRoot}/manifest.json`)).toString("utf8"),
  );
  if (
    manifest.engines &&
    Object.prototype.hasOwnProperty.call(manifest.engines, "fx")
  ) {
    fail("retired manifest.engines.fx must not be present");
  }
  if (
    !manifest.engines ||
    typeof manifest.engines !== "object" ||
    Object.keys(manifest.engines).join(",") !== "codex"
  ) {
    fail("release manifest.engines must contain only codex");
  }
  for (const retired of [
    `${releaseRoot}/engines/fx`,
    `${releaseRoot}/engines/fx/fx`,
    `${releaseRoot}/licenses/fx-LICENSE.txt`,
    `${releaseRoot}/licenses/fx-THIRD_PARTY_NOTICES.md`,
  ]) {
    if (
      entries.some(
        (entry) =>
          entry.path === retired || entry.path.startsWith(`${retired}/`),
      )
    ) {
      fail(`package must not contain retired Fx path ${retired}`);
    }
  }
  const provenanceEntry = `${releaseRoot}/provenance/vendor-manifest.json`;
  if (entries.some((entry) => entry.path === provenanceEntry)) {
    const provenance = JSON.parse(
      (await extractFile(file, provenanceEntry)).toString("utf8"),
    );
    if (
      provenance?.components &&
      Object.prototype.hasOwnProperty.call(provenance.components, "fx")
    ) {
      fail("package provenance must not include retired fx");
    }
  }
  const payloadDigests = {};
  for (const component of [
    manifest.runtime,
    manifest.engines?.codex,
  ]) {
    if (
      !component ||
      typeof component.executable !== "string" ||
      !/^[a-f0-9]{64}$/.test(component.sha256)
    )
      fail("release manifest contains invalid payload metadata");
    const actual = sha256(
      await extractFile(file, `${releaseRoot}/${component.executable}`),
    );
    if (actual !== component.sha256)
      fail(`packaging changed payload digest: ${component.executable}`);
    payloadDigests[component.executable] = actual;
  }
  return {
    package: file,
    version,
    architecture: fields.Architecture,
    entries: entries.map((entry) => entry.path),
    controlEntries,
    maintainerScripts,
    payloadDigests,
    checks: "passed",
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  if (!options.package) fail("--package is required");
  const result = await inspect(options.package, options.version);
  if (options.json)
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else
    process.stdout.write(
      `AgentStack Debian package passed inspection: ${result.package}\n`,
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

export { inspect, normalizedEntries, parseArgs };
