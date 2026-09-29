import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const installer = join(root, "scripts/install.sh");

async function fixture(run) {
  const home = await mkdtemp(join(tmpdir(), "stack-install-"));
  const workshops = join(home, "workshops");
  const bin = join(home, "tools");
  const owner = join(workshops, "codexnk/scripts/install.sh");
  await mkdir(dirname(owner), { recursive: true });
  await mkdir(bin);
  await writeFile(owner, `#!/bin/bash
set -eu
runtime="$HOME/.local/libexec/codexnk/codex"
if [ "$1" = --print-bin ]; then printf '%s\\n' "\${TEST_RUNTIME:-$runtime}"; exit; fi
printf '%s\\n' "$*" >> "$HOME/runtime-calls"
[ "\${TEST_FAIL:-0}" != 1 ] || exit 42
[ "$*" = '--install --tag codexnk-v0.1.7 --sha 3aae20d1ad1d41734b7303b4f0a4bfe95eb56d8c' ]
mkdir -p "$(dirname "$runtime")"
printf '#!/bin/sh\\nexit 0\\n' > "$runtime"
chmod +x "$runtime"
`, { mode: 0o755 });
  await writeFile(join(bin, "pnpm"), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$HOME/build-calls"\n', { mode: 0o755 });
  const env = { ...process.env, HOME: home, PATH: `${bin}:/usr/bin:/bin`, STACK_WORKSHOPS_ROOT: workshops, STACK_INSTALL_BIN_DIR: join(home, ".local/bin") };
  delete env.CODEXNK_INSTALL_ROOT;
  const invoke = (mode = "--install", extra = {}) => spawnSync("/bin/bash", [installer, mode], { env: { ...env, ...extra }, encoding: "utf8" });
  try { await run({ home, owner, invoke }); }
  finally { await rm(home, { recursive: true, force: true }); }
}

test("setup provisions the exact release before building and is repeatable", () => fixture(async ({ home, invoke }) => {
  for (let i = 0; i < 2; i++) {
    const result = invoke();
    assert.equal(result.status, 0, result.stderr);
  }
  assert.equal((await readFile(join(home, "runtime-calls"), "utf8")).trim().split("\n").length, 2);
  assert.deepEqual((await readFile(join(home, "build-calls"), "utf8")).trim().split("\n"), ["install --frozen-lockfile", "build", "install --frozen-lockfile", "build"]);
}));

test("plan is read-only and missing runtime owner fails clearly", () => fixture(async ({ owner, invoke }) => {
  await rm(owner);
  const plan = invoke("--check");
  assert.equal(plan.status, 0);
  assert.match(plan.stdout, /workshops\/codexnk\/scripts\/install\.sh/);
  const defaultPlan = invoke("--check", { STACK_WORKSHOPS_ROOT: "" });
  assert.equal(defaultPlan.status, 0);
  assert.match(defaultPlan.stdout, /workshops\/codexnk\/scripts\/install\.sh/);
  const result = invoke();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Required codexnk installer is missing/);
}));

test("setup refuses foreign commands before installing anything", () => fixture(async ({ home, invoke }) => {
  const bin = join(home, ".local/bin");
  await mkdir(bin, { recursive: true });
  await symlink("/unrelated/stack", join(bin, "stack"));
  assert.match(invoke().stderr, /Refusing to replace an independent command/);
  await assert.rejects(readFile(join(home, "runtime-calls")), /ENOENT/);
}));

test("setup rejects runtime relocation and does not build after failed installation", () => fixture(async ({ home, invoke }) => {
  assert.match(invoke("--install", { TEST_RUNTIME: "/other/codex" }).stderr, /must install Stack runtime/);
  assert.equal(invoke("--install", { TEST_FAIL: "1" }).status, 42);
  await assert.rejects(readFile(join(home, "build-calls")), /ENOENT/);
}));
