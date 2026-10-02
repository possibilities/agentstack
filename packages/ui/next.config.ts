import type { NextConfig } from "next";
import { resolve } from "node:path";

const nextConfig: NextConfig = {
  agentRules: false,
  serverExternalPackages: ["@stack/api"],
  // Packaging has its own output tree. The platform's ordinary .next build and
  // packages/serve's guarded `next start` must not become standalone implicitly.
  ...(process.env.STACK_UI_PORTABLE_BUILD === "1" ? {
    output: "standalone",
    distDir: "dist/next",
    typescript: { tsconfigPath: "dist/portable-tsconfig.json" },
    outputFileTracingRoot: resolve(import.meta.dirname, "../.."),
  } : {}),
};

export default nextConfig;
