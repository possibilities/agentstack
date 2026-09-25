import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

const uix = new URL("../", import.meta.url);
const brand = new URL("../../../brand/", import.meta.url);

test("web app icons come from the brand kit", async () => {
  for (const file of [
    "web/favicon.svg",
    "light-mode/png/icon-256.png",
    "dark-mode/png/icon-256.png",
    "light-mode/web/favicon.ico",
    "light-mode/web/favicon.svg",
    "light-mode/web/apple-touch-icon.png",
    "light-mode/web/icon-192.png",
    "light-mode/web/icon-512.png",
    "light-mode/web/icon-maskable-512.png",
    "dark-mode/web/favicon.svg",
  ]) {
    assert.deepEqual(
      await readFile(new URL(`public/brand/${file}`, uix)),
      await readFile(new URL(file, brand)),
      file,
    );
  }
  assert.deepEqual(
    await readFile(new URL("public/favicon.ico", uix)),
    await readFile(new URL("light-mode/web/favicon.ico", brand)),
  );
  const favicon = await readFile(new URL("public/brand/web/favicon.svg", uix), "utf8");
  assert.match(favicon, /@media \(prefers-color-scheme: dark\)/);
  assert.match(favicon, /fill: #ffffff/);
  const { brandIconUrl, brandMarkLightUrl, brandMarkDarkUrl } = await import("../lib/brand.ts");
  const version = createHash("sha256").update(favicon).digest("hex").slice(0, 12);
  assert.equal(brandIconUrl, `/brand/web/favicon.svg?v=${version}`);
  assert.equal(brandMarkLightUrl, `/brand/light-mode/png/icon-256.png?v=${version}`);
  assert.equal(brandMarkDarkUrl, `/brand/dark-mode/png/icon-256.png?v=${version}`);
});

test("installable app manifest references the bundled icons", async () => {
  const manifest = JSON.parse(await readFile(new URL("public/manifest.webmanifest", uix), "utf8"));
  assert.equal(manifest.name, "AgentStack");
  assert.equal(manifest.start_url, "/");
  assert.deepEqual(manifest.icons.map(({ src }) => src), [
    "/brand/light-mode/web/icon-192.png",
    "/brand/light-mode/web/icon-512.png",
    "/brand/light-mode/web/icon-maskable-512.png",
  ]);
  for (const { src } of manifest.icons) await readFile(new URL(`public${src}`, uix));
});
