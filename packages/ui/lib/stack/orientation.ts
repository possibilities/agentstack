import type { Bot } from "./types";

/**
 * How the UI reads a Bot's one-time orientation. The Bots owner's `orientation` state is the evidence; this only
 * groups it into the phases a person needs to tell apart, so Chat, Fleet, voice and the workbench say the same thing.
 * `legacy` is a Bot that was never enrolled (null or absent), not one that is waiting.
 */
export type Orientation = NonNullable<Bot["orientation"]>;
export type OrientationPhase = "legacy" | "admitting" | "introducing" | "unknown" | "completed" | "failed" | "interrupted" | "retired";
type EnrolledPhase = Exclude<OrientationPhase, "legacy">;

export function orientationPhase(orientation: Orientation | null | undefined): OrientationPhase {
  if (!orientation) return "legacy";
  switch (orientation.state) {
    case "pending": case "creating": case "ready": case "submitting": return "admitting";
    case "running": return "introducing";
    default: return orientation.state;
  }
}

const copy: Record<EnrolledPhase, { label: string; status: string; meaning: string }> = {
  admitting: { label: "Preparing introduction", status: "preparing introduction", meaning: "Stack is admitting this Bot’s one-time introduction. Competing input is refused until it is admitted." },
  introducing: { label: "Introducing", status: "introducing", meaning: "The one-time introduction turn is running. Chat input still works; voice waits for it to finish." },
  unknown: { label: "Needs inspection", status: "initialization needs inspection", meaning: "Stack could not confirm the introduction’s outcome. Voice stays closed, and nothing is resent or recreated." },
  completed: { label: "Introduced", status: "introduced", meaning: "The one-time introduction finished." },
  failed: { label: "Introduction failed", status: "introduction failed", meaning: "The introduction turn failed. It is not a successful introduction; voice is no longer held for it." },
  interrupted: { label: "Introduction interrupted", status: "introduction interrupted", meaning: "The introduction turn was interrupted. It is not a successful introduction; voice is no longer held for it." },
  retired: { label: "Orientation retired", status: "orientation retired", meaning: "The conversation was reset. This is not a native completion, and the introduction will not repeat." },
};

/** Short state label, or null for a legacy Bot, which has no orientation to name. */
export function orientationLabel(orientation: Orientation | null | undefined): string | null {
  const phase = orientationPhase(orientation);
  return phase === "legacy" ? null : copy[phase].label;
}

/** Lower-case words for a status line. */
export function orientationStatus(orientation: Orientation | null | undefined): string | null {
  const phase = orientationPhase(orientation);
  return phase === "legacy" ? null : copy[phase].status;
}

/** What the state means for the person looking at it. */
export function orientationMeaning(orientation: Orientation | null | undefined): string | null {
  const phase = orientationPhase(orientation);
  return phase === "legacy" ? null : copy[phase].meaning;
}

/**
 * The chip on a Bot card: only states that call for attention. Legacy, introduced and retired Bots show none, so a
 * settled Bot stays quiet. An unknown outcome names the introduction, since a Bot's process state can also need inspection.
 */
export function orientationChip(orientation: Orientation | null | undefined): string | null {
  const phase = orientationPhase(orientation);
  if (phase === "unknown") return "Introduction needs inspection";
  return phase === "admitting" || phase === "introducing" || phase === "failed" || phase === "interrupted" ? copy[phase].label : null;
}

/** The same rule as the Bots owner's `orientationSettled`: no orientation, or a known outcome, or an explicit retirement. */
export function orientationSettled(orientation: Orientation | null | undefined): boolean {
  return !orientation || ["completed", "failed", "interrupted", "retired"].includes(orientation.state);
}

/** Voice stays closed until the introduction's outcome is known, or its conversation was explicitly reset. */
export function voiceBlockedByOrientation(orientation: Orientation | null | undefined): boolean {
  return !orientationSettled(orientation);
}

/** Direct chat input is refused only while Stack is still admitting the introduction; after that it is native start-or-steer. */
export function orientationRefusesInput(orientation: Orientation | null | undefined): boolean {
  return orientationPhase(orientation) === "admitting";
}
