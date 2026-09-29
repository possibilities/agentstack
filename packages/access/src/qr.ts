import QRCode from "qrcode";
import { decodeQr } from "./enrollment-protocol.js";

/** Render data locally. No URL fetch, remote image service, theme-dependent colors or raw SVG. */
export function renderQr(text: string, now = Date.now()) {
  decodeQr(text, now);
  const { modules } = QRCode.create([{ data: new TextEncoder().encode(text), mode: "byte" }], { errorCorrectionLevel: "M" });
  const rows = Array.from({ length: modules.size }, (_, y) =>
    Array.from({ length: modules.size }, (_, x) => modules.get(y, x) ? "1" : "0").join(""));
  return { text, size: modules.size, rows, quietZone: 4 as const };
}
