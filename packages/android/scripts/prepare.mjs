import { mkdir, readFile, writeFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const gradle = await readFile(new URL("app/build.gradle.kts", root), "utf8");
if (!gradle.includes('applicationId = "dev.agentstack.app"')) throw new Error("Unexpected Android application identity");
await mkdir(new URL("dist/", root), { recursive: true });
await writeFile(new URL("dist/build-info.json", root), `${JSON.stringify({
  applicationId: "dev.agentstack.app",
  artifact: "app/build/outputs/apk/debug/app-debug.apk",
  build: "pnpm --filter @agentstack/android build:apk",
  verify: "pnpm --filter @agentstack/android test:android",
  toolchain: { jdk: 17, gradle: "8.7", androidPlatform: 34, buildTools: "34.0.0" },
}, null, 2)}\n`);
console.log("Android source package prepared. Build the APK with pnpm --filter @agentstack/android build:apk.");
