import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  agentRules: false,
  async redirects() {
    return [{ source: "/", destination: "/x", permanent: true }];
  },
};

export default nextConfig;
