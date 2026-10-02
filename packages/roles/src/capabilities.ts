import { z } from "zod";
import { canonicalMcpName } from "@stack/api";
import type { RoleSnapshot } from "./store.js";

export const capabilityHarness = z.enum(["codex", "opencode", "claude", "devin"])
  .describe("Actual native launcher, not a model family or instruction-rendering context. Bots use codex; Codex Workers use opencode.");
export type CapabilityHarness = z.infer<typeof capabilityHarness>;
export const capabilityHarnesses = z.array(capabilityHarness).max(4)
  .refine((values) => new Set(values).size === values.length, "harnesses must be unique").nullable()
  .describe("Allowed launch harnesses. Null or omission on creation means all; [] means none. Updates preserve omission and null clears the restriction.");
export type CapabilityHarnesses = z.infer<typeof capabilityHarnesses>;
export const internalMcpHarnesses = z.record(z.string().min(1), capabilityHarnesses.unwrap());
export const capabilitySelectionReason = z.enum(["included", "disabled", "harness_required", "harness_mismatch"]);
export type CapabilitySelectionReason = z.infer<typeof capabilitySelectionReason>;

export function capabilitySelection(resource: { enabled: boolean; harnesses?: CapabilityHarnesses }, harness?: CapabilityHarness): CapabilitySelectionReason {
  const allowed = capabilityHarnesses.parse(resource.harnesses ?? null);
  if (!resource.enabled) return "disabled";
  if (allowed === null) return "included";
  if (!allowed.length) return "harness_mismatch";
  if (harness === undefined) return "harness_required";
  return allowed.includes(harness) ? "included" : "harness_mismatch";
}

/** Older saved Worker snapshots retain the old key; conflicting aliases never widen selection. */
export function normalizedInternalMcpHarnesses(value: RoleSnapshot["internalMcpHarnesses"]): Record<string, CapabilityHarness[]> {
  const normalized: Record<string, CapabilityHarness[]> = {};
  for (const [name, allowed] of Object.entries(internalMcpHarnesses.parse(value ?? {}))) {
    const key = canonicalMcpName(name), previous = normalized[key];
    normalized[key] = previous ? previous.filter((harness) => allowed.includes(harness)) : allowed;
  }
  return normalized;
}

export function internalMcpSelection(snapshot: Pick<RoleSnapshot, "disabledInternalMcpServers" | "internalMcpHarnesses">, name: string, harness?: CapabilityHarness): CapabilitySelectionReason {
  const key = canonicalMcpName(name);
  return capabilitySelection({ enabled: !snapshot.disabledInternalMcpServers.some((disabled) => canonicalMcpName(disabled) === key),
    harnesses: normalizedInternalMcpHarnesses(snapshot.internalMcpHarnesses)[key] }, harness);
}

/** Select only launch capabilities; instructions and the immutable captured Role stay untouched. */
export function selectRoleCapabilities(snapshot: RoleSnapshot, harness?: CapabilityHarness): RoleSnapshot {
  if (harness !== undefined) capabilityHarness.parse(harness);
  const restrictions = normalizedInternalMcpHarnesses(snapshot.internalMcpHarnesses);
  return { ...snapshot,
    skills: snapshot.skills.filter((skill) => capabilitySelection(skill, harness) === "included"),
    mcpServers: snapshot.mcpServers.filter((server) => capabilitySelection(server, harness) === "included"),
    internalMcpHarnesses: restrictions,
    disabledInternalMcpServers: [...new Set([...snapshot.disabledInternalMcpServers.map(canonicalMcpName),
      ...Object.keys(restrictions).filter((name) => internalMcpSelection(snapshot, name, harness) !== "included")])],
  };
}
