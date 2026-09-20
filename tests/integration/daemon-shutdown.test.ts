import { spawn } from "node:child_process";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, expect, test } from "vitest";
import { build } from "esbuild";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function waitForFile(path: string, timeout = 2_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      await access(path);
      return;
    } catch {
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
  }
  throw new Error(`timed out waiting for ${path}`);
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("SIGTERM during readiness closes control and leaves no child orphan", async () => {
  const root = await mkdtemp(join("/tmp", "agentstack-daemon-shutdown-"));
  roots.push(root);
  const release = join(root, "release");
  const fixture = resolve(import.meta.dirname, "../fixtures/fake-child.mjs");
  const daemon = join(release, "apps", "daemon.mjs");
  await mkdir(join(release, "apps"), { recursive: true });
  await build({
    entryPoints: [
      resolve(import.meta.dirname, "../../apps/daemon/src/main.ts"),
    ],
    outfile: daemon,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
  });

  const pids = { codex: join(root, "codex.pid"), fx: join(root, "fx.pid") };
  for (const id of ["codex", "fx"] as const) {
    const wrapper = join(release, "engines", id, id);
    await mkdir(join(release, "engines", id), { recursive: true });
    await writeFile(
      wrapper,
      `#!/bin/sh\nprintf '%s\\n' "$$" > ${JSON.stringify(pids[id])}\nFAKE_MODE=hang exec ${JSON.stringify(process.execPath)} ${JSON.stringify(fixture)} "$@"\n`,
      { mode: 0o755, flush: true },
    );
    await chmod(wrapper, 0o755);
  }
  await writeFile(
    join(release, "manifest.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      productVersion: "test",
      buildIdentity: "test",
      target: "test",
      engines: {
        codex: {
          version: "test",
          executable: "engines/codex/codex",
          args: [],
          sha256: "a".repeat(64),
          source: "fixture",
        },
        fx: {
          version: "test",
          executable: "engines/fx/fx",
          args: [],
          sha256: "b".repeat(64),
          source: "fixture",
        },
      },
    })}\n`,
  );

  const child = spawn(process.execPath, [daemon], {
    env: {
      ...process.env,
      AGENTSTACK_RELEASE_ROOT: release,
      XDG_RUNTIME_DIR: join(root, "runtime"),
      XDG_STATE_HOME: join(root, "state"),
      XDG_CONFIG_HOME: join(root, "config"),
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  const stderr: Buffer[] = [];
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  try {
    await Promise.all([waitForFile(pids.codex), waitForFile(pids.fx)]);
  } catch (error) {
    throw new Error(
      `${String(error)}\ndaemon stderr:\n${Buffer.concat(stderr).toString("utf8")}`,
    );
  }
  const codexPid = Number((await readFile(pids.codex, "utf8")).trim());
  const fxPid = Number((await readFile(pids.fx, "utf8")).trim());
  const exited = new Promise<number | null>((resolveExit) =>
    child.once("exit", (code) => resolveExit(code)),
  );
  child.kill("SIGTERM");
  const exit = await Promise.race([
    exited,
    new Promise<"timeout">((resolveWait) =>
      setTimeout(() => resolveWait("timeout"), 2_000),
    ),
  ]);
  expect(exit).toBe(0);
  expect(processExists(codexPid)).toBe(false);
  expect(processExists(fxPid)).toBe(false);
  await expect(
    access(join(root, "runtime", "agentstack", "control.sock")),
  ).rejects.toMatchObject({ code: "ENOENT" });
  expect(Buffer.concat(stderr).toString("utf8")).toContain("shutdown_complete");
});
