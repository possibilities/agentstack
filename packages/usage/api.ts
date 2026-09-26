import { z } from "zod";
import { operation, stateDir, type PackageApi } from "@agentstack/api";
import { UsageObserver } from "./src/observer.js";
import { snapshotSchema } from "./src/schema.js";

export type UsageContext = { observer: UsageObserver };
export const usageSnapshot = operation({
  name: "usage_snapshot",
  description: "Read usage for Codex Bot and Codex, Grok and Devin Worker accounts by scope and immutable ID, plus the machine's Grok Bot login. Available dollar allocations, optional native-identity links, last-good values and freshness are explicit. No eligibility, balancing or recommendations.",
  input: z.strictObject({}), output: snapshotSchema,
  annotations: { title: "Read usage observations", readOnlyHint: true },
  async call(ctx: UsageContext) { return ctx.observer.snapshot(); },
});
export const topics = { usage_changed: "An account's usage, availability, or observation state changed. Re-read usage_snapshot." } as const;
export const api: PackageApi<UsageContext, keyof typeof topics> = {
  operations: [usageSnapshot],
  events: { topics, start(ctx, publish) {
    ctx.observer.onChange = () => publish("usage_changed");
    return () => { ctx.observer.onChange = undefined; };
  } },
  async createContext(env) {
    const observer = new UsageObserver(stateDir(env), env);
    await observer.load();
    observer.start();
    return { observer };
  },
  async closeContext(ctx) { await ctx.observer.close(); },
};
