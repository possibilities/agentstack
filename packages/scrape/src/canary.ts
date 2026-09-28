import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  closeSessionBestEffort,
  currentBrowserNetworkPolicy,
  withBrowserNetworkPolicy,
} from "./browser.js";
import { canariesValuesSchema } from "./config-schemas.js";
import { classifyFailure } from "./envelope.js";
import { AgentscrapeNetworkPolicyError, cancellationError, throwIfAborted } from "./errors.js";
import { loadRegistry, scrapeWithPreset, validateContentResult } from "./presets.js";
import { redactDiagnostic } from "./redaction.js";
import type { ScrapeSchema } from "./schemas.js";

interface Canary {
  url?: string;
  invariants?: {
    min_markdown_chars?: number;
    require_title?: boolean;
    min_rounds?: number;
    min_citations?: number;
  };
}
export interface CanaryResult {
  preset: string;
  status: "pass" | "drift" | "operational_failure" | "not_configured";
  detail: string;
}
export interface CanaryEnvelope {
  checked_at: string;
  results: CanaryResult[];
}
/** Inventory without navigation: absence of a canary is evidence of no live coverage. */
export function canaryInventory(canaryPath?: string): Array<{ preset: string; configured: boolean }> {
  const path = canaryPath ?? join(dirname(fileURLToPath(import.meta.url)), "../config/preset-canaries.json");
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  if (!canariesValuesSchema.safeParse(parsed).success)
    throw new Error("preset-canaries.json must be a JSON object mapping preset name to config");
  return loadRegistry().presets.map((item) => ({
    preset: item.name,
    configured: typeof (parsed as Record<string, Canary>)[item.name]?.url === "string",
  }));
}
export function checkInvariants(
  invariants: Canary["invariants"],
  structured: ScrapeSchema,
  markdown: string,
): string[] {
  const values = invariants ?? {};
  const record = structured as unknown as Record<string, unknown>;
  const violations: string[] = [];
  if (values.min_markdown_chars !== undefined && markdown.length < values.min_markdown_chars)
    violations.push(
      `markdown length ${markdown.length} is below minimum ${values.min_markdown_chars}`,
    );
  if (values.require_title && !(typeof record.title === "string" && record.title.trim()))
    violations.push("structured.title is empty");
  for (const [key, minimum] of [
    ["rounds", values.min_rounds],
    ["citations", values.min_citations],
  ] as const) {
    if (minimum !== undefined) {
      const count = Array.isArray(record[key]) ? record[key].length : 0;
      if (count < minimum) violations.push(`${key} count ${count} is below minimum ${minimum}`);
    }
  }
  return violations;
}
export async function checkPresets(
  options: {
    presets?: string[];
    canaryPath?: string;
    /** Reuse an operator-established signed-in session without taking ownership of it. */
    session?: string;
    signal?: AbortSignal;
    allowPrivateNetwork?: boolean | undefined;
  } = {},
): Promise<CanaryEnvelope> {
  return withBrowserNetworkPolicy(options.allowPrivateNetwork, async () => {
    const path = options.canaryPath ?? join(dirname(fileURLToPath(import.meta.url)), "../config/preset-canaries.json");
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    // The zod gate holds the file to what it always had to be: a JSON object. Entry
    // shapes stay unjudged at load — a malformed entry degrades to its per-preset
    // result below instead of refusing the whole run.
    if (!canariesValuesSchema.safeParse(parsed).success)
      throw new Error("preset-canaries.json must be a JSON object mapping preset name to config");
    // Every remaining key is a preset name, so the editor "$schema" pointer cannot stay.
    const { $schema: _schema, ...canaries } = parsed as Record<string, Canary>;
    const registry = loadRegistry();
    const names = options.presets?.length ? options.presets : registry.presets.map((item) => item.name).sort();
    const results: CanaryResult[] = [];
    for (const name of names) {
      throwIfAborted(options.signal);
      const canary = canaries[name];
      const preset = registry.byName(name);
      if (!preset) {
        results.push({
          preset: name,
          status: "not_configured",
          detail: "preset not found in registry",
        });
        continue;
      }
      if (!canary) {
        results.push({ preset: name, status: "not_configured", detail: "no canary configured" });
        continue;
      }
      if (!canary.url) {
        results.push({
          preset: name,
          status: "not_configured",
          detail: "no canary url configured",
        });
        continue;
      }
      const session = options.session ?? `agentscrape-canary-${process.pid}-${name}`;
      try {
        const result = await scrapeWithPreset(canary.url, preset, {
          session,
          signal: options.signal,
        });
        if (preset.mode === "content") validateContentResult(result, preset);
        const violations = checkInvariants(canary.invariants, result.structured, result.markdown);
        results.push(
          violations.length
            ? { preset: name, status: "drift", detail: redactDiagnostic(violations.join("; ")) }
            : { preset: name, status: "pass", detail: "" },
        );
      } catch (error) {
        if (options.signal?.aborted) throw cancellationError(options.signal);
        if (error instanceof AgentscrapeNetworkPolicyError) throw error;
        const [failureClass, _retryable, evidence] = classifyFailure(error);
        const status = [
          "malformed_provider_output",
          "empty_content",
          "output_limit_exceeded",
        ].includes(failureClass)
          ? "drift"
          : "operational_failure";
        results.push({
          preset: name,
          status,
          detail: `${failureClass}: ${redactDiagnostic(evidence)}`,
        });
      } finally {
        if (!options.session && currentBrowserNetworkPolicy()) await closeSessionBestEffort(session);
      }
    }
    return { checked_at: new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00"), results };
  });
}
