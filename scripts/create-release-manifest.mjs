#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (
      ["--package", "--stage", "--output", "--repository", "--tag"].includes(
        argument,
      )
    ) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--"))
        throw new Error(`${argument} requires a value`);
      result[argument.slice(2)] = value;
      index += 1;
    } else throw new Error(`unknown argument: ${argument}`);
  }
  return result;
}

async function sha256(path) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

const options = parseArgs(process.argv.slice(2));
if (
  !options.package ||
  !options.stage ||
  !options.output ||
  !options.repository ||
  !options.tag
)
  throw new Error(
    "--package, --stage, --output, --repository and --tag are required",
  );
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(options.repository))
  throw new Error("invalid repository");
if (!/^v[0-9][A-Za-z0-9.+~-]*$/.test(options.tag))
  throw new Error("invalid release tag");

const packagePath = resolve(options.package);
const stage = resolve(options.stage);
const release = JSON.parse(
  await readFile(resolve(stage, "manifest.json"), "utf8"),
);
if (options.tag !== `v${release.productVersion}`)
  throw new Error("release tag does not match productVersion");
const packageInfo = await stat(packagePath);
const packageSha256 = await sha256(packagePath);
const manifest = {
  schema: "agentstack.release.v1",
  productVersion: release.productVersion,
  source: {
    repository: options.repository,
    revision: release.buildIdentity.replace(/^git:/, ""),
    tag: options.tag,
  },
  target: release.target,
  artifact: {
    name: basename(packagePath),
    bytes: packageInfo.size,
    sha256: packageSha256,
  },
  runtime: release.runtime,
  engines: release.engines,
  signing: {
    kind: "github-artifact-attestation",
    subject: [basename(packagePath), "release-manifest.json"],
    verify: `gh attestation verify <file> --repo ${options.repository}`,
  },
};
await writeFile(
  resolve(options.output),
  `${JSON.stringify(manifest, null, 2)}\n`,
);
console.log(packageSha256);
