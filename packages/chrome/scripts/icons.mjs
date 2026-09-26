import { mkdir, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";

const root = new URL("../", import.meta.url);
const source = await readFile(new URL("assets/layers.svg", root), "utf8");
const paths = source.match(/<path[^>]+\/>/g).join("\n");
const launcher = `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 24 24"><rect width="24" height="24" rx="5" fill="#171717"/><g transform="translate(2.4 2.4) scale(.8)" fill="none" stroke="#fafafa" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</g></svg>\n`;
await writeFile(new URL("assets/launcher.svg", root), launcher);
await mkdir(new URL("icons/", root), { recursive: true });
for (const size of [16, 32, 48, 128]) {
  const bytes = execFileSync("rsvg-convert", ["--width", String(size), "--height", String(size)], { input: launcher });
  await writeFile(new URL(`icons/icon${size}.png`, root), bytes);
}
console.log("Generated Chrome icons from the canvas Layers mark (requires rsvg-convert only for regeneration).");
