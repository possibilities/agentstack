import { execFile } from "node:child_process";

function exactUrl(value, expectedOrigin) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || expectedOrigin && url.origin !== expectedOrigin) throw new Error("navigation_destination_refused");
  return url;
}
function open(url) {
  const command = process.platform === "darwin" ? "open" : "xdg-open";
  return new Promise((resolve, reject) => execFile(command, [url], { maxBuffer: 4096, timeout: 10_000 }, error => {
    // Native opener errors can embed their arguments. Never propagate them.
    if (error) reject(new Error("navigation_open_failed")); else resolve();
  }));
}

/** Browser adapter today; desk implements this same boundary later. Only the
 * client surface can receive a future bridge; platform pages never inherit it. */
export function browserNavigation(clientOrigin) {
  return {
    openClientSurface(url) { return open(exactUrl(url, clientOrigin).href); },
    openPlatform({ url, expectedOrigin, serverId }) {
      if (!expectedOrigin || serverId !== undefined && typeof serverId !== "string") throw new Error("navigation_destination_refused");
      return open(exactUrl(url, expectedOrigin).href);
    },
    focusConnections() { return open(`${clientOrigin}/client`); },
    openExternal(url) { return open(exactUrl(url).href); },
  };
}
