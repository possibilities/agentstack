"use client";

import { useId } from "react";
import { FunnelIcon } from "lucide-react";
import {
  capabilityHarnessNames,
  harnessDraftFor,
  harnessLaunches,
  harnessMapping,
  harnessSummary,
  readHarnessDraft,
  type HarnessMode,
} from "@/lib/stack/roles";
import type { RoleCapabilityHarness, RoleCapabilityHarnesses } from "@/lib/stack/types";
import { cn } from "@/lib/utils";
import { hintClass } from "./role-editor-parts";

const chip = "rounded px-1.5 py-px text-[0.64rem] font-medium";

/**
 * A capability's harness allowlist as three modes: unrestricted, an exact set, or none. The control speaks
 * draft text (`harnessDraftFor`), never a saved value, so an "Only:" with nothing ticked stays unsaveable
 * rather than silently becoming "none". Filters bind later launches; running sessions keep what they got.
 */
export function HarnessFilter({ id, value, onChange, disabled, compact }: {
  id: string;
  /** Draft text, as `harnessText`/`harnessDraftFor` produce it. */
  value: string;
  onChange(text: string): void;
  disabled?: boolean;
  compact?: boolean;
}) {
  const radios = useId();
  const { mode, selected, issue } = readHarnessDraft(value);
  const choose = (next: HarnessMode) => onChange(harnessDraftFor(next, selected));
  // Ticking a harness while the record is unrestricted or off moves it to "Only:" with that harness.
  const toggle = (name: RoleCapabilityHarness, on: boolean) =>
    onChange(harnessDraftFor("only", on ? [...selected, name] : selected.filter((item) => item !== name)));
  const radio = `accent-pkg-roles`;
  return (
    <div className={cn("flex flex-col", compact ? "gap-1" : "gap-1.5")}>
      <div role="radiogroup" aria-label="Harness filter" className="flex flex-col gap-1 text-[0.78rem]">
        <div className="flex flex-col gap-0.5">
          <label className="flex items-center gap-1.5">
            <input type="radio" name={`${radios}-harness`} className={radio} checked={mode === "any"} disabled={disabled}
              aria-describedby={`${id}-harness-any`} onChange={() => choose("any")} />
            Any harness
          </label>
          <p id={`${id}-harness-any`} className="pl-5 text-[0.68rem] text-pretty text-muted-foreground">Every launch harness. The default for new records.</p>
        </div>
        <div className="flex flex-col gap-0.5">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
            <label className="flex items-center gap-1.5">
              <input type="radio" name={`${radios}-harness`} className={radio} checked={mode === "only"} disabled={disabled}
                aria-describedby={issue ? `${id}-harness-issue` : undefined} onChange={() => choose("only")} />
              Only:
            </label>
            {capabilityHarnessNames.map((name) => (
              <label key={name} title={harnessLaunches[name]} className="flex items-center gap-1 font-mono text-[0.72rem]">
                <input type="checkbox" className={radio} checked={selected.includes(name)} disabled={disabled} aria-label={`Allow ${name}`}
                  onChange={(event) => toggle(name, event.target.checked)} />
                {name}
              </label>
            ))}
          </div>
        </div>
        <div className="flex flex-col gap-0.5">
          <label className="flex items-center gap-1.5">
            <input type="radio" name={`${radios}-harness`} className={radio} checked={mode === "none"} disabled={disabled}
              aria-describedby={`${id}-harness-none`} onChange={() => choose("none")} />
            No harness
          </label>
          <p id={`${id}-harness-none`} className="pl-5 text-[0.68rem] text-pretty text-muted-foreground">Turns it off for every launch, even while Enabled.</p>
        </div>
      </div>
      {issue ? <p id={`${id}-harness-issue`} className="px-0.5 text-[0.68rem] text-pretty text-destructive">{issue}</p> : null}
      <p className={hintClass}>{harnessMapping} Applies to later launches, not running sessions.</p>
    </div>
  );
}

/** A stored filter as a list chip; unrestricted records show nothing. */
export function HarnessChip({ value }: { value: RoleCapabilityHarnesses | undefined }) {
  if (value == null) return null;
  const none = !value.length;
  return (
    <span className={cn(chip, none ? "bg-warning/15 text-warning" : "bg-pkg-roles/10 text-pkg-roles")}
      title={`Harness filter: ${harnessSummary(value)}`}>
      {harnessSummary(value)}
    </span>
  );
}

/** The trigger content for an internal connection's filter button: an icon when unrestricted, compact text otherwise. */
export function HarnessTriggerFace({ value }: { value: RoleCapabilityHarnesses | undefined }) {
  if (value == null) return <FunnelIcon aria-hidden className="text-muted-foreground" />;
  if (!value.length) return <span className="px-0.5 text-[0.64rem] font-medium text-warning">None</span>;
  if (value.length === 1) return <span className="px-0.5 font-mono text-[0.64rem] font-medium text-pkg-roles">{value[0]}</span>;
  return <span className="px-0.5 text-[0.64rem] font-medium text-pkg-roles">{value.length} harnesses</span>;
}
