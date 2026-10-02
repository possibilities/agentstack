"use client";

import { useId, useState } from "react";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { receiptRetentionDays, settingsKey, settingsPackage, settingsReceiptTarget, type SettingsTarget } from "@/lib/stack/settings";
import { localOperations, stateOperations } from "@/lib/stack/state";
import { useStack, useStore } from "./provider";
import { MaintenanceDisclosure, StateFlowView, useStateFlow } from "./state-flow";

export function SettingsReceipts({ target }: { target: SettingsTarget }) {
  const state = useStack();
  const store = useStore();
  const id = useId();
  const [text, setText] = useState("7");
  const retainDays = receiptRetentionDays(text);
  const pkg = settingsPackage(target);
  const prefix = pkg === "bots" ? "bot" : "worker";
  const operations = { plan: `${prefix}_settings_receipts_plan`, apply: `${prefix}_settings_receipts_clear`, receipt: `${prefix}_state_receipt_get` };
  const key = settingsKey(target);
  const observe = state.settingsViews[key]?.at;
  const controls = useStateFlow({ operations: stateOperations(store.call, pkg, operations, { targets: [settingsReceiptTarget(target)], retainDays }),
    recoveryKey: `${pkg}:settings_receipts:${key}`, observe });
  if (state.remote || !localOperations(state, pkg, Object.values(operations)).available) return null;
  const locked = controls.flow.phase !== "idle";
  const unavailable = state.status[pkg] !== "open" ? `The ${pkg} connection is not open.`
    : ("id" in target && !target.id) ? "Choose an exact settings target."
    : retainDays === null ? "Enter a whole retention window from 7 to 3,650 days." : null;
  return <MaintenanceDisclosure title="Old receipts" active={locked} aside="settings maintenance">
    <p className="text-[0.72rem] text-pretty text-muted-foreground">Clears only receipts below this target&rsquo;s current saved revision and older than the retention window. Current, young and unknown-age receipts stay, with permanent minimal request/digest/revision tombstones.</p>
    <p className="text-[0.72rem] text-pretty text-muted-foreground">No settings change or native application. This is not disk reclamation or secret erasure; saved, loaded and native settings stay unchanged.</p>
    <FieldGroup><Field data-disabled={locked} data-invalid={retainDays === null}>
      <FieldLabel htmlFor={id}>Retain days</FieldLabel>
      <Input id={id} type="number" min={7} max={3650} step={1} value={text} disabled={locked} aria-invalid={retainDays === null} onChange={(event) => setText(event.target.value)} />
    </Field></FieldGroup>
    <StateFlowView controls={controls} label="Prepare old receipt clearing" applyLabel="Clear these old receipts" unavailable={unavailable} />
  </MaintenanceDisclosure>;
}
