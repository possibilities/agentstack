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
