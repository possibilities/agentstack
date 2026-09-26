import { mkdir, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";

const root = new URL("../", import.meta.url);
const source = await readFile(new URL("assets/layers.svg", root), "utf8");
const paths = [...source.matchAll(/<path d="([^"]+)"/g)].map((match) => match[1]);
const res = new URL("app/src/main/res/", root);
const xmlPaths = (color) => paths.map((path) => `    <path android:pathData="${path}" android:fillColor="@android:color/transparent" android:strokeColor="${color}" android:strokeWidth="2" android:strokeLineCap="round" android:strokeLineJoin="round"/>`).join("\n");
const vector = (size, viewport, body) => `<?xml version="1.0" encoding="utf-8"?>\n<vector xmlns:android="http://schemas.android.com/apk/res/android" android:width="${size}dp" android:height="${size}dp" android:viewportWidth="${viewport}" android:viewportHeight="${viewport}">\n${body}\n</vector>\n`;
for (const [name, content] of [
  ["drawable/ic_brand_layers.xml", vector(24, 24, xmlPaths("@color/stack_foreground"))],
  ["drawable/ic_notification_layers.xml", vector(24, 24, xmlPaths("#FFFFFFFF"))],
  ["drawable/ic_launcher_foreground.xml", vector(108, 108, `<group android:scaleX="2.5" android:scaleY="2.5" android:translateX="24" android:translateY="24">\n${xmlPaths("#FFFAFAFA")}\n</group>`)],
  ["drawable/ic_launcher_monochrome.xml", vector(108, 108, `<group android:scaleX="2.5" android:scaleY="2.5" android:translateX="24" android:translateY="24">\n${xmlPaths("#FFFFFFFF")}\n</group>`)],
  ["mipmap-anydpi-v26/ic_launcher.xml", '<?xml version="1.0" encoding="utf-8"?>\n<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n  <background android:drawable="@color/stack_launcher_background"/>\n  <foreground android:drawable="@drawable/ic_launcher_foreground"/>\n  <monochrome android:drawable="@drawable/ic_launcher_monochrome"/>\n</adaptive-icon>\n'],
]) {
  await mkdir(new URL(name.slice(0, name.lastIndexOf("/") + 1), res), { recursive: true });
  await writeFile(new URL(name, res), content);
}
const launcher = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 108 108"><rect width="108" height="108" rx="24" fill="#171717"/><g transform="translate(24 24) scale(2.5)" fill="none" stroke="#fafafa" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths.map((p) => `<path d="${p}"/>`).join("")}</g></svg>\n`;
await writeFile(new URL("assets/launcher.svg", root), launcher);
for (const [density, size] of [["mdpi", 48], ["hdpi", 72], ["xhdpi", 96], ["xxhdpi", 144], ["xxxhdpi", 192]]) {
  await mkdir(new URL(`mipmap-${density}/`, res), { recursive: true });
  await writeFile(new URL(`mipmap-${density}/ic_launcher.png`, res), execFileSync("rsvg-convert", ["--width", String(size), "--height", String(size)], { input: launcher }));
}
console.log("Generated Android Layers assets.");
