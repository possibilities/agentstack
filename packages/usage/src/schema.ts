import { z } from "zod";

export const provider = z.enum(["codex", "grok", "devin", "claude"]);
export type Provider = z.infer<typeof provider>;
export const accountScope = z.enum(["bot", "worker"]);
export type AccountScope = z.infer<typeof accountScope>;
const nullableString = z.string().max(256).nullable();
const nullableNumber = z.number().finite().nullable();
const nullableBoolean = z.boolean().nullable();
const window = z.strictObject({ role: z.enum(["primary", "secondary", "code_review", "other"]),
  label: z.string().max(80), windowSeconds: nullableNumber, usedPercent: z.number().finite(),
  remainingPercent: z.number().finite(), resetsAt: nullableString,
  limitName: nullableString, meteredFeature: nullableString });
export const codexUsage = z.strictObject({ planType: nullableString, limitReached: nullableBoolean,
  resetCreditsAvailable: nullableNumber, resetCreditExpirations: z.array(nullableString).nullable(),
  lanes: z.array(z.strictObject({ id: z.string().max(100), title: z.string().max(80), windows: z.array(window).max(2) })).max(36) });
export const grokUsage = z.strictObject({ subscriptionTier: nullableString,
  included: z.strictObject({ usedPercent: nullableNumber, remainingPercent: nullableNumber,
    periodType: nullableString, periodStart: nullableString, resetsAt: nullableString,
    allocatedUsd: nullableNumber.describe("Included monthly dollar allocation from Grok's monthlyLimit in the legacy billing response; null when the provider omits it. Not a remaining balance.") }),
  prepaidBalanceUsd: nullableNumber, paygEnabled: nullableBoolean,
  paygUsedUsd: nullableNumber, paygCapUsd: nullableNumber, paygRemainingUsd: nullableNumber });
export const devinUsage = z.strictObject({ planLabel: nullableString, billing: nullableString,
  dailyRemainingPercent: nullableNumber, weeklyRemainingPercent: nullableNumber,
  dailyResetsAt: nullableString, weeklyResetsAt: nullableString, periodStart: nullableString,
  periodEnd: nullableString, promptCreditsMonthly: nullableNumber, promptCreditsAvailable: nullableNumber,
  weeklyQuotaHidden: nullableBoolean, displayName: nullableString });
export const claudeUsage = z.strictObject({
  windows: z.array(z.strictObject({ id: z.string().max(80), label: z.string().max(80),
    usedPercent: z.number().finite().nonnegative(), remainingPercent: z.number().finite().min(0).max(100), resetsAt: nullableString })).max(32),
  extraUsage: z.strictObject({ enabled: nullableBoolean,
    monthlyLimit: nullableNumber.describe("Native extra_usage.monthly_limit, in provider units; not converted to dollars."),
    usedCredits: nullableNumber.describe("Native extra_usage.used_credits, in provider units; not an inferred balance."),
    utilization: nullableNumber.describe("Native extra_usage.utilization percentage, when reported.") }).nullable(),
});
export const grokBotUsage = z.strictObject({ usedPercent: z.number().finite(), periodStart: z.string(),
  resetsAt: z.string(), hasAvailableUsage: z.boolean(), planLabel: nullableString,
  fundingPlan: nullableString, onDemandEligible: nullableBoolean, onDemandEnabled: nullableBoolean,
  trial: nullableBoolean, teamSeat: nullableBoolean });
export type Measurement = z.infer<typeof codexUsage> | z.infer<typeof grokUsage> | z.infer<typeof devinUsage> | z.infer<typeof claudeUsage>;

export const observationError = z.enum(["credentials_unavailable", "credentials_unsafe", "account_invalid",
  "response_invalid", "provider_unavailable", "auth_unavailable", "rate_limited", "not_found", "provider_error",
  "identity_invalid", "grok_bot_unavailable", "grok_bot_invalid", "observation_failed"]);
export type ObservationError = z.infer<typeof observationError>;
const observation = {
  observedAtMs: z.number().int().nullable().describe("Epoch milliseconds of the last successful measurement, not the latest attempt."),
  lastAttemptAtMs: z.number().int().nullable().describe("Epoch milliseconds of the last observation attempt."),
  fresh: z.boolean().describe("Successful observation no older than five minutes; account freshness also requires a current inventory and completed sign-in."),
  error: observationError.nullable().describe("Sanitized code for the latest failed attempt; last-good usage may remain alongside it."),
};
const linkedAccounts = z.array(z.strictObject({ scope: accountScope, id: z.uuid() }))
  .describe("Other AgentStack accounts with a matching native sign-in identity; no credential or provider account ID is exposed.");
export const account = z.discriminatedUnion("provider", [
  z.strictObject({ id: z.uuid(), scope: accountScope, provider: z.literal("codex"), enabled: z.boolean(), ready: z.boolean(), linkedAccounts,
    ...observation, usage: codexUsage.nullable() }),
  z.strictObject({ id: z.uuid(), scope: z.literal("worker"), provider: z.literal("grok"), enabled: z.boolean(), ready: z.boolean(), linkedAccounts,
    ...observation, usage: grokUsage.nullable() }),
  z.strictObject({ id: z.uuid(), scope: z.literal("worker"), provider: z.literal("devin"), enabled: z.boolean(), ready: z.boolean(), linkedAccounts,
    ...observation, usage: devinUsage.nullable() }),
  z.strictObject({ id: z.uuid(), scope: z.literal("worker"), provider: z.literal("claude"), enabled: z.boolean(), ready: z.boolean(), linkedAccounts,
    ...observation, usage: claudeUsage.nullable() }),
]);
export const snapshotSchema = z.strictObject({ atMs: z.number().int(), inventoryAtMs: z.number().int().nullable(),
  inventoryError: z.enum(["not_observed", "auth_unavailable"]).nullable(), accounts: z.array(account).describe("Bot Codex and independent Worker accounts, including disabled accounts. Scope and ID together identify a record."),
  grokBot: z.strictObject({ ...observation, usage: grokBotUsage.nullable() }).describe("Machine-level Grok Bot CLI login; not an AgentStack Worker account.") });
export type Snapshot = z.infer<typeof snapshotSchema>;
export type Account = z.infer<typeof account>;
export type GrokBot = Snapshot["grokBot"];
export type StoredMeasurement = { observedAtMs: number | null; lastAttemptAtMs: number | null;
  error: ObservationError | null; usage: Measurement | z.infer<typeof grokBotUsage> | null };
