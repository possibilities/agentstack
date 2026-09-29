import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  agentRules: false,
  serverExternalPackages: ["@agentstack/api"],
  async redirects() {
    return [{ source: "/", destination: "/x", permanent: true }];
  },
};

export default nextConfig;
