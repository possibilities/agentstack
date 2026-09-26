/** Structural geometry only: never use live records or measured content to pack the bench. */
export type Point = { x: number; y: number };
export type Bounds = Point & { width: number; height: number };
export type Camera = Point & { k: number };
export type WindowGeometry = { id: string; width: number; column: number; height?: number };
export type SpaceGeometry = { id: string; windows: WindowGeometry[] };
export type BenchLayout = { positions: Record<string, Point>; manual: Record<string, boolean>; collapsed: Record<string, boolean>; order: string[] };
export type BenchGeometry = {
  regions: { id: string; bounds: Bounds }[];
  windows: (WindowGeometry & { space: string })[];
  origins: Record<string, Point>;
};
export type PackedBench = { layout: BenchLayout; geometry: BenchGeometry };
export type WindowAnchor = { id: string; point: Point };
export type SavedBench = { layout?: Partial<BenchLayout>; space?: string; camera?: Camera; anchor?: WindowAnchor };
export type ViewportSize = { width: number; height: number };
export const windowHeight = 760;
export const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const validPoint = (p: unknown): p is Point => Boolean(p && typeof p === "object" && "x" in p && "y" in p && Number.isFinite(p.x) && Number.isFinite(p.y));

export function boundsOf(rects: Bounds[]): Bounds {
  if (!rects.length) return { x: 0, y: 0, width: 0, height: 0 };
  const x = Math.min(...rects.map((r) => r.x));
  const y = Math.min(...rects.map((r) => r.y));
  return { x, y, width: Math.max(...rects.map((r) => r.x + r.width)) - x, height: Math.max(...rects.map((r) => r.y + r.height)) - y };
}

export function localLayout(defs: WindowGeometry[]): { positions: Record<string, Point>; bounds: Bounds } {
  const positions: Record<string, Point> = {};
  let x = 0;
  for (const column of [...new Set(defs.map((d) => d.column))].sort((a, b) => a - b)) {
    const members = defs.filter((d) => d.column === column);
    let y = 0;
    for (const def of members) {
      positions[def.id] = { x, y };
      y += (def.height ?? windowHeight) + 24;
    }
    x += Math.max(...members.map((d) => d.width)) + 72;
  }
  return { positions, bounds: boundsOf(defs.map((d) => ({ ...positions[d.id], width: d.width, height: d.height ?? windowHeight }))) };
}

/** Stable input order, balanced rows, shorter rows first; every row and the whole bench are centered. */
export function packSpaces(spaces: { id: string; bounds: Bounds }[], gap = 240): Record<string, Point> {
  if (!spaces.length) return {};
  const columns = Math.ceil(Math.sqrt(spaces.length));
  const rows = Math.ceil(spaces.length / columns);
  const small = Math.floor(spaces.length / rows);
  const largeRows = spaces.length % rows;
  const groups: typeof spaces[] = [];
  let cursor = 0;
  for (let row = 0; row < rows; row++) {
    const count = small + (row >= rows - largeRows ? 1 : 0);
    groups.push(spaces.slice(cursor, cursor += count));
  }
  const heights = groups.map((group) => Math.max(...group.map((s) => s.bounds.height)));
  let y = -(heights.reduce((sum, height) => sum + height, 0) + gap * (rows - 1)) / 2;
  const origins: Record<string, Point> = {};
  groups.forEach((group, row) => {
    let x = -(group.reduce((sum, s) => sum + s.bounds.width, 0) + gap * (group.length - 1)) / 2;
    for (const space of group) {
      origins[space.id] = { x: x - space.bounds.x, y: y + (heights[row] - space.bounds.height) / 2 - space.bounds.y };
      x += space.bounds.width + gap;
    }
    y += heights[row] + gap;
  });
  return origins;
}

/** The only packing boundary: reconcile local positions before measuring each region's footprint.
 * Call on restore, registration changes or explicit tidy; pointer movement keeps these origins frozen.
 */
export function reconcileBench(spaces: SpaceGeometry[], previous: Partial<BenchLayout> = {}): PackedBench {
  const positions: Record<string, Point> = {};
  const manual: Record<string, boolean> = {};
  const collapsed: Record<string, boolean> = {};
  const regions = spaces.map((space) => {
    const defaults = localLayout(space.windows).positions;
    for (const def of space.windows) {
      const point = previous?.positions?.[def.id];
      if (previous?.manual?.[def.id] === true && validPoint(point)) {
        positions[def.id] = { ...point };
        manual[def.id] = true;
      } else positions[def.id] = defaults[def.id];
      if (typeof previous?.collapsed?.[def.id] === "boolean") collapsed[def.id] = previous.collapsed[def.id];
    }
    return { id: space.id, bounds: boundsOf(space.windows.map((def) => ({ ...positions[def.id], width: def.width, height: def.height ?? windowHeight }))) };
  });
  const windows = spaces.flatMap((space) => space.windows.map((def) => ({ ...def, space: space.id })));
  const ids = new Set(windows.map((def) => def.id));
  const previousOrder = Array.isArray(previous?.order) ? previous.order : [];
  const order = [...new Set([...previousOrder.filter((id) => ids.has(id)), ...ids])];
  return { layout: { positions, manual, collapsed, order }, geometry: { regions, windows, origins: packSpaces(regions) } };
}

export function windowPoint(bench: PackedBench, id: string): Point | null {
  const def = bench.geometry.windows.find((item) => item.id === id);
  const local = bench.layout.positions[id];
  if (!def || !local) return null;
  const origin = bench.geometry.origins[def.space];
  return { x: origin.x + local.x, y: origin.y + local.y };
}

export function benchBounds(bench: PackedBench, space?: string): Bounds {
  return boundsOf(bench.geometry.windows.filter((def) => !space || def.space === space).map((def) => ({
    ...windowPoint(bench, def.id)!, width: def.width, height: bench.layout.collapsed[def.id] ? 64 : def.height ?? windowHeight,
  })));
}

/** Nearest actual window, including unsaved manual movement; optionally require it to survive repacking. */
export function viewedWindow(bench: PackedBench, camera: Camera, viewport: ViewportSize, retained?: Set<string>): WindowAnchor | undefined {
  const center = { x: (viewport.width / 2 - camera.x) / camera.k, y: (viewport.height / 2 - camera.y) / camera.k };
  let anchor: WindowAnchor | undefined;
  let nearest = Infinity;
  for (const def of bench.geometry.windows) {
    if (retained && !retained.has(def.id)) continue;
    const point = windowPoint(bench, def.id)!;
    const distance = Math.hypot(point.x + def.width / 2 - center.x, point.y + (def.height ?? windowHeight) / 2 - center.y);
    if (distance < nearest) { nearest = distance; anchor = { id: def.id, point }; }
  }
  return anchor;
}

export function preserveViewedWindow(camera: Camera, before: PackedBench, after: PackedBench, viewport: ViewportSize): Camera {
  const anchor = viewedWindow(before, camera, viewport, new Set(after.geometry.windows.map((def) => def.id)));
  return anchor ? preserveAnchor(camera, anchor.point, windowPoint(after, anchor.id)!) : camera;
}

/** An address to another logical space wins over a saved global camera. Legacy saves keep their layout only. */
export function restoreBenchCamera(saved: SavedBench, space: string, bench: PackedBench, viewport: ViewportSize, left: number): Camera {
  if (saved.space !== space || !validPoint(saved.camera) || !Number.isFinite(saved.camera.k) || saved.camera.k <= 0) {
    return fitBounds(benchBounds(bench, space), viewport.width, viewport.height, 0.65);
  }
  const camera = { ...saved.camera, x: saved.camera.x - left, k: clamp(saved.camera.k, 0.3, 1.6) };
  const point = saved.anchor && windowPoint(bench, saved.anchor.id);
  return point && validPoint(saved.anchor?.point) ? preserveAnchor(camera, saved.anchor.point, point) : camera;
}

/** Shared by pointer focus, keyboard focus and deliberate card navigation. */
export function raiseWindow(order: string[], id: string): string[] {
  return order.at(-1) === id || !order.includes(id) ? order : [...order.filter((entry) => entry !== id), id];
}

/** Hold the viewed space's local anchor at exactly the same screen pixel after structural repacking. */
export function preserveAnchor(camera: Camera, before: Point, after: Point): Camera {
  return { ...camera, x: camera.x + (before.x - after.x) * camera.k, y: camera.y + (before.y - after.y) * camera.k };
}

export function fitBounds(bounds: Bounds, width: number, height: number, min = 0.3, max = 1): Camera {
  const k = clamp(Math.min((width - 64) / Math.max(1, bounds.width), (height - 148) / Math.max(1, bounds.height)), min, max);
  return { k, x: width / 2 - (bounds.x + bounds.width / 2) * k, y: 76 + (height - 148) / 2 - (bounds.y + bounds.height / 2) * k };
}

export function compensateLeft(camera: Camera, before: number, after: number): Camera {
  return { ...camera, x: camera.x + before - after };
}

export type BenchSurface = "bench" | "left" | "right";
type OpenDocks = { systemOpen: boolean; rightOpen: boolean };

/** Retained dock content does not force a mobile overlay over a deliberately revealed spatial destination. */
export function activeSurface(value: unknown, docks: OpenDocks): BenchSurface {
  if (value === "bench") return value;
  if (value === "left" && docks.systemOpen) return value;
  if (value === "right" && docks.rightOpen) return value;
  return docks.rightOpen ? "right" : docks.systemOpen ? "left" : "bench";
}

export const dockMinimum = { left: 280, right: 320, bench: 240 };

/** Joint allocation: no desktop combination may consume the bench's usable minimum. */
export function dockGeometry({ screenWidth, systemOpen, rightOpen, surface, systemWidth, rightWidth, expanded = false }: OpenDocks & {
  screenWidth: number; surface: BenchSurface; systemWidth: number; rightWidth: number; expanded?: boolean;
}) {
  const minimum = dockMinimum.bench + (systemOpen ? dockMinimum.left : 0) + (rightOpen ? dockMinimum.right : 0);
  const overlay = screenWidth < 900 || screenWidth < minimum;
  const systemVisible = systemOpen && (!overlay || surface === "left");
  const rightVisible = rightOpen && (!overlay || surface === "right");
  const leftMax = overlay ? 520 : Math.min(520, screenWidth - dockMinimum.bench - (rightOpen ? dockMinimum.right : 0));
  const leftWidth = clamp(systemWidth, dockMinimum.left, leftMax);
  const left = !overlay && systemVisible ? leftWidth : 0;
  const rightMax = Math.max(dockMinimum.right, screenWidth - left - dockMinimum.bench);
  const width = clamp(expanded ? rightMax : rightWidth, dockMinimum.right, rightMax);
  return { overlay, systemVisible, rightVisible, leftWidth, leftMax, rightWidth: width, rightMax, left, right: !overlay && rightVisible ? width : 0 };
}
