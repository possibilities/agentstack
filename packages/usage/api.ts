import { z } from "zod";
import { withStateInventory, requireStateOperator, statePlan, stateApplyInput, stateReceipt } from "@stack/api";
import { usageStateCategories } from "./src/state-categories.js";
import { operation, stateDir, type PackageApi } from "@stack/api";
import { UsageObserver } from "./src/observer.js";
import { snapshotSchema } from "./src/schema.js";

export type UsageContext = { observer: UsageObserver };
export const usageSnapshot = operation({
  name: "usage_snapshot",
  description: "Read usage for Codex Bot and Codex, Grok, Devin and Claude Worker accounts by scope and ID, plus the machine's Grok Bot login beside a signed-in Grok Worker. Claude reports native quota windows and optional extra usage without refreshing credentials. Dollar allocations, subscription ends where exposed, Bot–Worker links, last-good values and freshness are explicit. No eligibility or balancing.",
  input: z.strictObject({}), output: snapshotSchema,
  annotations: { title: "Read usage observations", readOnlyHint: true },
  async call(ctx: UsageContext) { return ctx.observer.snapshot(); },
});
export const topics = { usage_changed: "An account's usage, availability, or observation state changed. Re-read usage_snapshot." } as const;
const packageApi: PackageApi<UsageContext, keyof typeof topics> = {
  operations: [usageSnapshot,
    operation({ name: "usage_observations_plan", description: "Preview clearing local usage measurements for exact account/scope pairs and optionally the separate Grok Bot observation. Clears no credentials and never resets provider quota or billing. Collectors can repopulate measurements on their next cycle.",
      input: z.strictObject({ accounts: z.array(z.strictObject({ id: z.uuid(), scope: z.enum(["bot", "worker"]) })).max(128), grokBot: z.boolean() }).refine(value => value.accounts.length > 0 || value.grokBot, "Select at least one observation"), output: statePlan,
      async call(ctx, input, invocation) { requireStateOperator(invocation); return ctx.observer.clearPlan(input); } }),
    operation({ name: "usage_observations_clear", description: "Apply one exact usage-observation plan, fence selected in-flight collector results and persist the cleared snapshot. Read the receipt after a lost response; normal later collection is independent regeneration.",
      input: stateApplyInput, output: stateReceipt, annotations: { destructiveHint: true, idempotentHint: true },
      async call(ctx, input, invocation) { requireStateOperator(invocation); return ctx.observer.clear(input); } }),
    operation({ name: "usage_state_receipt_get", description: "Read one durable usage-observation maintenance receipt.", input: z.strictObject({ requestId: z.uuid() }), output: z.strictObject({ receipt: stateReceipt.nullable() }), annotations: { readOnlyHint: true },
      async call(ctx, { requestId }, invocation) { requireStateOperator(invocation); return { receipt: ctx.observer.maintenance.receipt(requestId) }; } }),
  ],
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
export const api = withStateInventory("usage", usageStateCategories, packageApi);
