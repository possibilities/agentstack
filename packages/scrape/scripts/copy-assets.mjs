import { cpSync, mkdirSync } from "node:fs";
mkdirSync("dist/config", { recursive: true });
mkdirSync("dist/test", { recursive: true });
cpSync("config/presets", "dist/config/presets", { recursive: true });
cpSync("config/preset-canaries.json", "dist/config/preset-canaries.json");
cpSync("test/corpus", "dist/test/corpus", { recursive: true });
cpSync("test/fixtures", "dist/test/fixtures", { recursive: true });
