import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

// Regenerate only from the consumer's exact runtime pin, never a moving checkout HEAD.
const root = resolve(import.meta.dirname, "..");
const revision = readFileSync(resolve(root, "scripts/install.sh"), "utf8").match(/^integration_sha=([a-f0-9]{40})$/m)?.[1];
if (!revision || process.argv.length !== 3) throw new Error("Usage: node scripts/update-codex-settings-schema.mjs /path/to/codex-source");
const schema = JSON.parse(execFileSync("git", ["show", `${revision}:codex-rs/core/config.schema.json`], { cwd: process.argv[2], encoding: "utf8", maxBuffer: 4_000_000 }));
writeFileSync(resolve(root, "packages/settings/src/codex-schema.json"), JSON.stringify({ revision, schema }, null, 2) + "\n");
