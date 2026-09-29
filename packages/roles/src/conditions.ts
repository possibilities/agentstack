import { z } from "zod";

export const renderValue = z.string().min(1).max(200).refine((value) => value.trim().length > 0, "value must not be blank");
export const renderContext = z.strictObject({ model: renderValue.optional(), harness: renderValue.optional() })
  .describe("Explicit instruction rendering context. Values are exact and case-sensitive; omitted values match no condition. Does not configure a native runtime.");
export const fragmentConditions = renderContext.describe("All supplied conditions must match rendering context exactly (AND). Empty object is unconditional. Unknown conditions are rejected.");
export type RenderContext = z.infer<typeof renderContext>;
export type FragmentConditions = z.infer<typeof fragmentConditions>;

export function matchesConditions(conditions: FragmentConditions | undefined, context: RenderContext): boolean {
  return Object.entries(fragmentConditions.parse(conditions ?? {})).every(([key, value]) => context[key as keyof RenderContext] === value);
}
