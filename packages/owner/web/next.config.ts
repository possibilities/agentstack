import type { NextConfig } from "next";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

export default {
  transpilePackages: ["@agentstack/api", "@agentstack/codex", "@agentstack/owner"],
  turbopack: { root },
  async rewrites() {
    return [{ source: "/_ui/:path*", destination: "/:path*" }];
  },
} satisfies NextConfig;
