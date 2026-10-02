import type { AccessSnapshot } from "./types";

export type AccessHistoryKind = "ui_sessions" | "expired_pairings" | "expired_invitations";
/** Revoked but unexpired authority is not expired history; only opaque nonempty IDs can be selected. */
export function expiredAccessHistory(data: AccessSnapshot, kind: AccessHistoryKind, now: number): { id: string; label: string; expires: number }[] {
  const rows = kind === "ui_sessions" ? data.uiSessions : kind === "expired_pairings" ? data.pairings : data.invitations;
  return rows.filter((row) => row.expires <= now && typeof row.id === "string" && row.id.length > 0)
    .map((row) => ({ id: row.id!, label: "label" in row ? row.label : "credential_id" in row ? `UI session · ${row.credential_id}` : `Invitation · ${row.kind}`, expires: row.expires }));
}

/** The scope that lets a client's credentials sponsor QR enrollment of other devices. */
export const enrollScope = "access:enroll";

/**
 * Client kinds the Access server accepts as enrollment sponsors. It refuses the plain remote-UI
 * `browser` even when the scope is stored; `chrome` is the extension and is eligible. Any kind this
 * UI does not know is treated as ineligible. The server remains authoritative.
 */
const sponsorKinds = new Set(["chrome", "android", "desktop"]);
export const canSponsor = (kind: string | undefined): boolean => kind !== undefined && sponsorKinds.has(kind);

/** Whether a scope can be turned on for a client of this kind. */
export const scopeAvailable = (kind: string | undefined, scope: string): boolean => scope !== enrollScope || canSponsor(kind);

/**
 * The switches a tailnet grant editor shows. `access:enroll` appears for an ineligible kind only
 * while stored, so an existing record stays visible and removable but the scope is never offered.
 */
export const grantScopeOptions = (kind: string | undefined, all: readonly string[], stored: readonly string[]): string[] =>
  all.filter((scope) => scopeAvailable(kind, scope) || stored.includes(scope));
