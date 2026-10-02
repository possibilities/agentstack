import type { TreeFilter } from "./hud";

/**
 * The HUD space's page-local view: the Work item its windows follow, collapsed
 * branches, a focused subtree and the tree filter. It is browser-local and optional:
 * losing it only resets the view. It is not Chat focus and never reaches the API.
 */
export type HudView = { selectedId: string | null; collapsed: ReadonlySet<string>; rootId: string | null; filter: TreeFilter };

const storageKey = "ui.hud.v1";
const maxCollapsed = 500;
type Listener = () => void;

const initialView: HudView = { selectedId: null, collapsed: new Set(), rootId: null, filter: { view: "open", query: "" } };

export class HudViewStore {
  private view: HudView = initialView;
  private listeners = new Set<Listener>();
  private storage: Pick<Storage, "getItem" | "setItem"> | null = null;

  /** Restore after hydration, so the first client render matches the server's. */
  attach(storage: Pick<Storage, "getItem" | "setItem"> | null): void {
    this.storage = storage;
    try {
      const saved = JSON.parse(storage?.getItem(storageKey) ?? "null") as Record<string, unknown> | null;
      if (!saved || typeof saved !== "object") return;
      const id = (value: unknown) => typeof value === "string" && /^[0-9a-f-]{36}$/i.test(value) ? value : null;
      const view = saved.view === "all" || saved.view === "attention" || saved.view === "open" ? saved.view : "open";
      this.view = {
        selectedId: id(saved.selectedId),
        rootId: id(saved.rootId),
        collapsed: new Set(Array.isArray(saved.collapsed) ? saved.collapsed.map(id).filter((value): value is string => value !== null).slice(0, maxCollapsed) : []),
        filter: { view, query: "" },
      };
      this.emit();
    } catch { /* optional persistence */ }
  }

  getView = (): HudView => this.view;
  /** What the server rendered. Benches can hydrate after `attach` restores the view, so hydration must not read it. */
  getServerView = (): HudView => initialView;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  select(id: string | null): void {
    if (this.view.selectedId === id) return;
    this.update({ selectedId: id });
  }

  toggle(id: string): void {
    const collapsed = new Set(this.view.collapsed);
    if (!collapsed.delete(id)) collapsed.add(id);
    this.update({ collapsed });
  }

  /** Make every one of these rows visible: expand them and leave a subtree focus that excludes the target. */
  reveal(id: string, ancestors: readonly string[]): void {
    const collapsed = new Set(this.view.collapsed);
    let changed = false;
    for (const ancestor of ancestors) changed = collapsed.delete(ancestor) || changed;
    const rootId = this.view.rootId && this.view.rootId !== id && !ancestors.includes(this.view.rootId) ? null : this.view.rootId;
    if (changed || rootId !== this.view.rootId || this.view.selectedId !== id) this.update({ collapsed, rootId, selectedId: id });
  }

  focusSubtree(rootId: string | null): void {
    if (this.view.rootId !== rootId) this.update({ rootId });
  }

  setFilter(filter: Partial<TreeFilter>): void {
    this.update({ filter: { ...this.view.filter, ...filter } });
  }

  private update(patch: Partial<HudView>): void {
    this.view = { ...this.view, ...patch };
    try {
      this.storage?.setItem(storageKey, JSON.stringify({ selectedId: this.view.selectedId, rootId: this.view.rootId,
        collapsed: [...this.view.collapsed].slice(-maxCollapsed), view: this.view.filter.view }));
    } catch { /* optional persistence */ }
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
