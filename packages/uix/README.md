# UI Experiments

Next.js runtime index at `/` and the experiment canvas at `/x`, with Tailwind CSS and shadcn/ui. `/x` is a live, read-only workbench: every Package API as draggable windows of cards, fed by the loopback WebSocket (`lib/stack/`) with components in `components/canvas/`. Both pages serve markdown twins (`/index.md`, `/x.md`). `agentstack serve` owns the built app. For live iteration, run `pnpm --filter @agentstack/uix dev` from the workspace root, edit `components/canvas/`, and add UI primitives from this package with `pnpm dlx shadcn@latest add <component>`.
