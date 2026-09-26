import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const read = (file) => readFile(new URL(file, root), "utf8");

test("the Android application has a fresh root identity and feature-scoped components", async () => {
  const gradle = await read("app/build.gradle.kts");
  const manifest = await read("app/src/main/AndroidManifest.xml");
  assert.match(gradle, /namespace = "dev\.agentstack\.app"/);
  assert.match(gradle, /applicationId = "dev\.agentstack\.app"/);
  assert.match(manifest, /android:allowBackup="false"/);
  for (const name of [".SettingsActivity", ".share.ShareActivity", ".share.RecentLinkActionReceiver", ".share.RecentLinkRestoreReceiver"]) {
    assert.ok(manifest.includes(`android:name="${name}"`));
  }
  const settings = await read("app/src/main/java/dev/agentstack/app/Settings.kt");
  assert.match(settings, /agentstack\.app\.share\.settings\.v1/);
  assert.match(settings, /http:\/\/127\.0\.0\.1:8877/);
});

test("adaptive, monochrome, in-app and notification assets retain the exact Layers paths", async () => {
  const svg = await read("assets/layers.svg");
  const paths = [...svg.matchAll(/<path d="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(paths.length, 3);
  for (const name of ["ic_launcher_foreground", "ic_launcher_monochrome", "ic_brand_layers", "ic_notification_layers"]) {
    const vector = await read(`app/src/main/res/drawable/${name}.xml`);
    for (const path of paths) assert.ok(vector.includes(`android:pathData="${path}"`));
  }
  const launcher = await read("app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml");
  assert.match(launcher, /<monochrome/);
  assert.equal(await read("LICENSE"), await read("app/src/main/assets/licenses/LICENSE"));
  assert.match(await read("app/src/main/assets/licenses/LICENSE.lucide"), /Copyright \(c\) 2026 Lucide/);
});
