import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { dispatch } from "../src/dispatch.js";

test("package namespaces dispatch their own argv without API discovery or legacy aliases", async () => {
  const root = await mkdtemp(join(tmpdir(), "stack-cli-"));
  const roles = join(root, "packages", "roles");
  try {
    await mkdir(join(roles, "dist"), { recursive: true });
    await writeFile(join(root, "pnpm-workspace.yaml"), "packages: []\n");
    await writeFile(join(roles, "cli.yaml"), "description: Inspect roles.\n");
    await writeFile(join(roles, "cli.ts"), "// Built separately\n");
    await writeFile(join(roles, "dist", "cli.js"), `import { writeFileSync } from "node:fs";
export default { run(args) { writeFileSync(process.env.STACK_CLI_TEST_OUTPUT, JSON.stringify(args)); return 7; } };
`);
    await writeFile(join(roles, "package.json"), '{"type":"module"}');
    const solo = join(root, "packages", "solo");
    await mkdir(join(solo, "dist"), { recursive: true });
    await writeFile(join(solo, "package.json"), '{"type":"module"}');
    await writeFile(join(solo, "cli.ts"), "// Built separately\n");
    await writeFile(join(solo, "dist", "cli.js"), 'export default { description: "Standalone command", run() { return 4; } };\n');
    const output = join(root, "args.json");
    process.env.STACK_CLI_TEST_OUTPUT = output;
    assert.equal(await dispatch(["roles", "snapshot", "--verbose"], root), 7);
    assert.deepEqual(JSON.parse(await readFile(output, "utf8")), ["snapshot", "--verbose"]);
    assert.equal(await dispatch(["solo"], root), 4);
    assert.equal(await dispatch(["open"], root), 1);
    assert.equal(await dispatch(["roles", "--help"], root), 0);
  } finally {
    delete process.env.STACK_CLI_TEST_OUTPUT;
    await rm(root, { recursive: true, force: true });
  }
});

test("YAML-only packages invoke an argv executable and reject conflicting implementations", async () => {
  const root = await mkdtemp(join(tmpdir(), "stack-cli-"));
  const dir = join(root, "packages", "demo");
  try {
    await mkdir(dir, { recursive: true });
    const output = join(dir, "args.json");
    await writeFile(join(dir, "cli.yaml"), JSON.stringify({ description: "Demo command", exec: [process.execPath, "-e", `require('node:fs').writeFileSync(${JSON.stringify(output)}, JSON.stringify(process.argv.slice(1)))`] }));
    assert.equal(await dispatch(["demo", "one", "two"], root), 0);
    assert.deepEqual(JSON.parse(await readFile(output, "utf8")), ["one", "two"]);
    await writeFile(join(dir, "cli.ts"), "// Conflict\n");
    await assert.rejects(dispatch(["demo"], root), /exactly one of cli.ts or exec/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
