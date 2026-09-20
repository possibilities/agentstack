import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { expect, test } from "vitest";

test("README begins with the canonical fleet line byte-for-byte", async () => {
  const readme = await readFile(
    resolve(import.meta.dirname, "../../README.md"),
    "utf8",
  );
  expect(readme.split("\n", 1)[0]).toBe(
    "> *Slop Made With Sweat: Made with a lot of love by someone who loves code but read none of it.*",
  );
});

test("GitHub Actions use full commit pins and least default permissions", async () => {
  const workflow = await readFile(
    resolve(import.meta.dirname, "../../.github/workflows/native-linux.yml"),
    "utf8",
  );
  const uses = [...workflow.matchAll(/^\s*uses:\s*([^\s#]+)/gm)].map(
    (match) => match[1]!,
  );
  expect(uses.length).toBeGreaterThan(0);
  expect(uses.every((value) => /@[a-f0-9]{40}$/.test(value))).toBe(true);
  expect(workflow).toContain("permissions:\n  contents: read");
  expect(workflow).not.toMatch(/pull_request_target/);
  expect(workflow).not.toMatch(/build-fx|engine-fx/);
});

test("release identity is pinned for 0.1.1 without fx", async () => {
  const repository = resolve(import.meta.dirname, "../..");
  const rootPackage = JSON.parse(
    await readFile(resolve(repository, "package.json"), "utf8"),
  ) as { version: string };
  const manifest = JSON.parse(
    await readFile(resolve(repository, "vendor/manifest.json"), "utf8"),
  ) as { components: Record<string, unknown> };
  expect(rootPackage.version).toBe("0.1.1");
  const packageFiles = execFileSync(
    "git",
    [
      "ls-files",
      "-z",
      "package.json",
      "apps/*/package.json",
      "packages/*/package.json",
    ],
    {
      cwd: repository,
      encoding: "utf8",
    },
  )
    .split("\0")
    .filter(Boolean);
  for (const packageFile of packageFiles) {
    const packageData = JSON.parse(
      await readFile(resolve(repository, packageFile), "utf8"),
    ) as { version: string };
    expect(packageData.version, packageFile).toBe("0.1.1");
  }
  expect(await readFile(resolve(repository, "README.md"), "utf8")).toContain(
    "agentstack_0.1.1_amd64.deb",
  );
  expect(manifest.components).not.toHaveProperty("fx");
  expect(manifest.components).toHaveProperty("codex");
  expect(manifest.components).toHaveProperty("node");
});

test("tracked product files exclude removed product concepts", async () => {
  const repository = resolve(import.meta.dirname, "../..");
  const tracked = execFileSync("git", ["ls-files", "-z"], {
    cwd: repository,
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean)
    .filter((path) => !path.startsWith("vendor/licenses/"));
  const forbidden = [
    new RegExp(["agent", "lab"].join(""), "i"),
    /\bai[\s_-]+sdk\b/i,
    /\bai[\s_-]+elements?\b/i,
    new RegExp(["har", "ness"].join(""), "i"),
    new RegExp(["sand", "box"].join(""), "i"),
    new RegExp(["compatibility", "layer"].join("[\\s_-]+"), "i"),
  ];
  const findings: string[] = [];
  for (const path of tracked) {
    const text = await readFile(resolve(repository, path), "utf8");
    for (const pattern of forbidden) {
      const match = pattern.exec(text);
      if (match) findings.push(`${path}: ${match[0]}`);
    }
  }
  expect(findings).toEqual([]);
  expect(tracked).toContain("packages/engine-codex/package.json");
  expect(tracked).not.toContain("packages/engine-fx/package.json");
});
