import type { Resource, Snapshot } from "./types";

/**
 * Canvas destination isolation (ADR 0167). Everything the Canvas keeps in the browser belongs to the platform it was
 * written for: one namespace per `{serverId, authority, origin}`. The server names its own identity (the Access
 * instance UUID, read from `serve_status`); nothing here derives, guesses or persists one. Until a complete identity
 * is known there is no storage, so nothing is read, written or recovered.
 */
export type Authority = "local" | "remote";

/** The one status line every control that saves a record before sending shows while the server has not named itself. */
export const waitingForIdentity = "Waiting for the server to name itself…";
/** Shown when this destination's storage refuses the record such a control must save first. */
export const notRecorded = "This browser could not record the request, so it was not sent.";

/** What a page knows about the platform it talks to. `serverId` stays null until the server has named itself. */
export type Destination = { authority: Authority; origin: string | null; serverId: string | null };

/** A complete destination: the only thing a namespace is built from. */
export type DestinationIdentity = Readonly<{ serverId: string; origin: string; authority: Authority }>;

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The complete identity for a destination, or null while the server has not named itself or the origin is unknown. */
export function destinationIdentity(destination: Destination | null | undefined): DestinationIdentity | null {
  if (!destination || typeof destination.serverId !== "string" || !uuid.test(destination.serverId) || !destination.origin) return null;
  let origin: string;
  try { origin = new URL(destination.origin).origin; } catch { return null; }
  if (origin === "null") return null;
  return Object.freeze({ serverId: destination.serverId.toLowerCase(), origin, authority: destination.authority });
}

/** Dots and every separator are escaped so one destination's prefix can never match another's keys. */
const component = (value: string) => encodeURIComponent(value).replace(/\./g, "%2E");

/** `stack.destination.<serverId>.<authority>.<origin>.` : the prefix of every key a destination owns. */
export const destinationPrefix = (identity: DestinationIdentity): string =>
  `stack.destination.${identity.serverId}.${identity.authority}.${component(identity.origin)}.`;

/** The part of `Storage` an area must offer. */
export type StorageArea = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;

/**
 * One destination's view of a browser storage area. Names are the short keys the Canvas uses (`uix.chats.v1`); the
 * destination prefix is added here, so no caller can address another destination's record. It offers the `Storage`
 * methods the stores already use, so a store attached to it needs no other change.
 */
export class ScopedStorage {
  readonly identity: DestinationIdentity;
  readonly prefix: string;
  private readonly area: () => StorageArea | null;
  constructor(identity: DestinationIdentity, area: () => StorageArea | null) {
    this.identity = identity;
    this.prefix = destinationPrefix(identity);
    this.area = area;
  }

  /** Null when the area is unavailable or holds nothing under this destination. */
  getItem(name: string): string | null {
    return this.area()?.getItem(this.prefix + name) ?? null;
  }

  /** Throws when the area is unavailable or refuses the write: a caller that must persist first cannot proceed. */
  setItem(name: string, value: string): void {
    const area = this.area();
    if (!area) throw new Error("Browser storage is unavailable");
    area.setItem(this.prefix + name, value);
  }

  removeItem(name: string): void {
    this.area()?.removeItem(this.prefix + name);
  }

  /** The names this destination holds that start with `prefix`. Never another destination's, never an unqualified key. */
  keys(prefix = ""): string[] {
    const area = this.area();
    if (!area) return [];
    const found: string[] = [];
    for (let index = 0; index < area.length; index++) {
      const key = area.key(index);
      if (key?.startsWith(this.prefix + prefix)) found.push(key.slice(this.prefix.length));
    }
    return found;
  }
}

/** The browser's `localStorage` or `sessionStorage`, looked up when used: blocked or absent storage reads as unavailable. */
export function browserArea(kind: "localStorage" | "sessionStorage"): StorageArea | null {
  try { return typeof window === "undefined" ? null : window[kind]; } catch { return null; }
}

/** The page's storage for one complete identity; both areas share its namespace. */
export function destinationStorages(identity: DestinationIdentity | null, areas: { local?: () => StorageArea | null; session?: () => StorageArea | null } = {}): { local: ScopedStorage | null; session: ScopedStorage | null } {
  if (!identity) return { local: null, session: null };
  return { local: new ScopedStorage(identity, areas.local ?? (() => browserArea("localStorage"))), session: new ScopedStorage(identity, areas.session ?? (() => browserArea("sessionStorage"))) };
}

const empty = <T>(): Resource<T> => ({ data: null, error: null, at: null });

/**
 * A snapshot for a replacement platform: nothing the previous one reported survives, only how to reach the new one.
 * The new tree reads its own data over its own connections.
 */
export function blankSnapshot(snapshot: Snapshot, destination: Destination): Snapshot {
  return {
    server: empty(), resources: empty(), accounts: empty(), workerAccounts: empty(), workerRuntimes: empty(), workerSessions: empty(),
    usage: empty(), login: empty(), workerLogins: empty(), bots: empty(), botDefaults: empty(), voice: empty(), roleCatalog: empty(), catalog: empty(),
    endpoints: snapshot.endpoints, contentOrigins: snapshot.contentOrigins, ...(snapshot.remote ? { remote: snapshot.remote } : {}), destination,
  };
}
