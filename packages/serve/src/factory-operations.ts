import { z } from "zod";
import { operation, statePlan, stateReceipt, installationFence, requireStateOperator } from "@stack/api";
import type { ServerContext } from "../api.js";
import { FactoryReset, factoryResetApply, factoryResetReceipt, factoryResetRelease, releaseFactoryReset, recoverFactoryReset } from "./factory-reset.js";

function resetService(ctx: ServerContext) { return ctx.factoryReset ??= new FactoryReset(ctx.env ?? process.env, () => ctx.source.factoryReset); }
export const factoryControlOperations = [
  operation({ name: "serve_factory_reset_recover", description: "After definite reset-writer PID absence, record interrupted running receipts as unknown in the sibling control ledger. Preserves startup fence and all uncertain effects; never repeats cleanup or starts anything. Available cold through stack serve factory-reset-control. Local operator only.", input: z.strictObject({ requestId: z.uuid() }), output: z.strictObject({ receipt: stateReceipt.nullable(), fence: installationFence.nullable() }),
    async call(ctx: Pick<ServerContext, "env">, { requestId }, invocation) { requireStateOperator(invocation); return recoverFactoryReset(ctx.env ?? process.env, requestId); } }),
  operation({ name: "serve_factory_reset_receipt_get", description: "Read one sibling control-store factory-reset receipt and exact old/new generation startup fence. Admission is not completion; missing/partial/unknown effects remain unresolved and never replay. Available cold through stack serve factory-reset-control without erased owner contexts. Private socket local operator only.", input: z.strictObject({ requestId: z.uuid() }), output: z.strictObject({ receipt: stateReceipt.nullable(), fence: installationFence.nullable() }), annotations: { readOnlyHint: true },
    async call(ctx: Pick<ServerContext, "env">, { requestId }, invocation) { requireStateOperator(invocation); return factoryResetReceipt(ctx.env ?? process.env, requestId); } }),
  operation({ name: "serve_factory_reset_fence_release", description: "Acknowledge an exact completed reset/new generation and permit a later explicit start. Requires definitely absent reset-writer PID and still-empty installation; never starts anything, releases partial/unknown state or changes its receipt. Available cold through stack serve factory-reset-control. Private socket local operator only.", input: factoryResetRelease, output: z.strictObject({ released: z.literal(true), generation: z.uuid() }),
    async call(ctx: Pick<ServerContext, "env">, input, invocation) { requireStateOperator(invocation); return releaseFactoryReset(ctx.env ?? process.env, input); } }),
];
export const factoryResetOperations = [
  operation({ name: "serve_factory_reset_plan", description: "Preview one whole-installation factory reset: exact root/generation and owner account/worktree/Browser scope, blockers and retained Git/device/external copies. Apply ends owned work, clears active data/credentials/config and leaves startup fenced. New Access identity requires explicit later start; no implicit pairing/import. Private socket local operator only.", input: z.strictObject({ scope: z.literal("installation") }), output: statePlan,
    async call(ctx: ServerContext, _input, invocation) { requireStateOperator(invocation); return resetService(ctx).plan(); } }),
  operation({ name: "serve_factory_reset_clear", description: "Admit exact whole-installation reset once; return before shutdown/effects. Requires factory-reset confirmation and quiesced external writers. Parent drains runtimes, removes proven managed resources, retains Git, clears active state and rotates generation. Partial/unknown never redispatch; installation stays stopped/fenced. Cold receipts remain available. Private socket local operator only.", input: factoryResetApply, output: stateReceipt, annotations: { destructiveHint: true, idempotentHint: true },
    async call(ctx: ServerContext, input, invocation) { requireStateOperator(invocation); const receipt = await resetService(ctx).request(input); ctx.source.onStateChange?.(); return receipt; } }),
  ...factoryControlOperations,
];
