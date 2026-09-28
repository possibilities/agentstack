import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isIP } from "node:net";
import { request } from "node:http";
import { AccessError } from "./store.js";

const exec = promisify(execFile);
export type Peer = { remoteAddress: string; remotePort: number; localAddress: string };
const normalize = (ip: string) => ip.replace(/^::ffff:/, "");

/** Direct local daemon IPC avoids a CLI process per request where tailscaled
 * exposes its Unix LocalAPI socket. No network URL or forwarding proxy is used. */
export function localApi(socketPath: string): (args: string[]) => Promise<any> {
  return args => new Promise((resolve, reject) => {
    const path = args[0] === "status" ? "/localapi/v0/status" : `/localapi/v0/whois?addr=${encodeURIComponent(args.at(-1)!)}&proto=tcp`;
    const req = request({ socketPath, path, headers: { host: "local-tailscaled.sock" } }, response => {
      const chunks: Buffer[] = []; let size = 0;
      response.on("data", chunk => { size += chunk.length; if (size > 4 * 1024 * 1024) req.destroy(new Error("LocalAPI response too large")); else chunks.push(chunk); });
      response.on("end", () => { try { if (response.statusCode !== 200) throw new Error("LocalAPI refused"); resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch (error) { reject(error); } });
      response.on("error", reject);
    });
    req.setTimeout(3000, () => req.destroy(new Error("LocalAPI timeout")));
    req.on("error", reject); req.end();
  });
}
export function tailnetAddress(ip: string) {
  ip = normalize(ip);
  if (isIP(ip) === 4) { const parts = ip.split(".").map(Number); return parts[0] === 100 && parts[1]! >= 64 && parts[1]! <= 127; }
  return isIP(ip) === 6 && ip.toLowerCase().startsWith("fd7a:115c:a1e0:");
}
/** Direct ingress only: check the actual TCP source and destination against a
 * running local tailscaled on every request. A reverse proxy, Serve, Funnel,
 * forwarded header, MagicDNS name, or listener label is never proof. */
export function verifier(binary = "tailscale", run: (args: string[]) => Promise<any> = async args => {
  const { stdout } = await exec(binary, args, { timeout: 3000, maxBuffer: 4 * 1024 * 1024 });
  return JSON.parse(stdout);
}) {
  let inflight = 0;
  return async (peer: Peer) => {
    const remote = normalize(peer.remoteAddress), local = normalize(peer.localAddress);
    if (!tailnetAddress(remote) || !tailnetAddress(local)) throw new AccessError("tailnet_required", 403);
    if (inflight >= 8) throw new AccessError("verification_capacity", 429);
    inflight++;
    try {
      const status = await run(["status", "--json"]);
      if (status.BackendState !== "Running" || status.Self?.Online !== true || !status.TailscaleIPs?.includes(local)) throw new Error();
      const who = await run(["whois", "--json", "--proto=tcp", isIP(remote) === 6 ? `[${remote}]:${peer.remotePort}` : `${remote}:${peer.remotePort}`]);
      if (!who.Node?.ID || !Array.isArray(who.Node.Addresses) || !who.Node.Addresses.some((value: unknown) => typeof value === "string" && value.split("/")[0] === remote)) throw new Error();
    } catch { throw new AccessError("tailnet_unverified", 403); }
    finally { inflight--; }
  };
}
