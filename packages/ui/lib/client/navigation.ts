/** Prepare a separate browser page within the explicit click gesture. The future
 * desk adapter implements openPlatform with the same destination-pinned input. */
export function preparePlatformNavigation() {
  const child = window.open("about:blank", "_blank");
  if (!child) throw new Error("Allow a new browser tab, then choose Open again. Nothing was dispatched.");
  child.opener = null;
  return {
    openPlatform({ url, expectedOrigin, serverId }: { url: string; expectedOrigin: string; serverId: string }) {
      const target = new URL(url);
      if (!expectedOrigin || !serverId || target.protocol !== "https:" || target.origin !== expectedOrigin || target.username || target.password
        || target.pathname !== "/connect/device" || target.search || !/^[A-Za-z0-9_-]{43}$/.test(target.hash.slice(1))) throw new Error("Platform navigation destination refused.");
      child.location.replace(url);
    },
    close() { child.close(); },
  };
}
