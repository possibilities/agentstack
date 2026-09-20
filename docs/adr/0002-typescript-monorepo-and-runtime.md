# 0002: pnpm, Turbo, strict TypeScript, bundled apps

Status: accepted 2026-09-20; dual-engine package clause superseded 2026-09-20 by 0007.

Use pnpm workspaces and Turbo with applications under `apps/*` and compiled internal packages under `packages/*`. Use strict NodeNext TypeScript 6.0, Vitest, ESLint flat configuration, Prettier, and esbuild app bundles. TypeScript 7.0 was evaluated but its current compiler API is not supported by typescript-eslint 8.70.0, so the release pins the newest mutually compatible TypeScript line.

This follows current Vercel workspace boundaries while keeping release entrypoints independent of workspace symlinks or an end-user package manager.

Native protocol code uses direct ownership names: `packages/engine-codex` contains only the Codex app-server initialization/readiness exchange, and `packages/engine-fx` contains only the Fx ACP initialization/readiness exchange. Neither package is a general agent abstraction or integration facade.
