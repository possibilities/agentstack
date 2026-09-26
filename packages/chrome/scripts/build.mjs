import { cp, mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const dist = path.join(root, "dist/agentstack-chrome");
await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
for (const file of [
  "manifest.json", "background.js", "shared.js", "storage.js", "outbox.js", "history.js", "status.js",
  "popup.html", "popup.js", "options.html", "options.js", "theme.css", "icons", "assets", "LICENSE", "NOTICE.md",
]) {
  await cp(path.join(root, file), path.join(dist, file), { recursive: true });
}
console.log(`Unpacked Chrome distribution: ${dist}`);
