import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
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
});
