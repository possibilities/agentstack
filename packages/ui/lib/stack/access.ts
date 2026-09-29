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
