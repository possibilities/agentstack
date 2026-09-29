"use client";

import { cn } from "@/lib/utils";

/**
 * One small honest line/area chart. Null values are gaps: the line breaks and
 * never bridges or flattens them. Value, minimum and maximum sit beside it.
 */
export function Trend({ points, label, format, className }: {
  points: { at: number; value: number | null }[];
  label: string;
  format(value: number): string;
  className?: string;
}) {
  const known = points.filter((point) => point.value !== null) as { at: number; value: number }[];
  const values = known.map((point) => point.value);
  const min = values.length ? Math.min(...values) : null;
  const max = values.length ? Math.max(...values) : null;
  const last = known.at(-1)?.value ?? null;
  const width = 100;
  const height = 36;
  const pad = 2;
  const span = min !== null && max !== null && max > min ? max - min : 1;
  const low = min ?? 0;
  const x = (index: number) => points.length <= 1 ? width / 2 : pad + (index / (points.length - 1)) * (width - pad * 2);
  const y = (value: number) => pad + (1 - (value - low) / span) * (height - pad * 2);
  const segments: string[] = [];
  let current: string[] = [];
  points.forEach((point, index) => {
    if (point.value === null) {
      if (current.length) segments.push(current.join(" "));
      current = [];
    } else current.push(`${x(index).toFixed(2)},${y(point.value).toFixed(2)}`);
  });
  if (current.length) segments.push(current.join(" "));
  const gaps = points.length - known.length;
  const summary = `${label}: ${last === null ? "no samples" : `now ${format(last)}`}${min !== null && max !== null ? `, ${format(min)}–${format(max)}` : ""}${gaps ? `, ${gaps} gap${gaps === 1 ? "" : "s"}` : ""}`;
  return (
    <figure className={cn("flex flex-col gap-1", className)} aria-label={summary}>
      <figcaption className="flex items-baseline gap-2 text-[0.68rem] text-muted-foreground">
        <span className="font-medium tracking-[0.08em] uppercase">{label}</span>
        <span className="ml-auto font-mono tabular-nums text-foreground/80">{last === null ? "—" : format(last)}</span>
      </figcaption>
      <svg aria-hidden viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className="h-14 w-full">
        {segments.map((segment, index) => {
          const [start, ...rest] = segment.split(" ");
          const end = rest.at(-1) ?? start;
          return (
            <g key={index}>
              {rest.length ? (
                <path d={`M${start} L${rest.join(" L")} L${end.split(",")[0]},${height - pad} L${start.split(",")[0]},${height - pad} Z`}
                  className="fill-current opacity-10" />
              ) : null}
              <polyline points={segment} className="fill-none stroke-current" strokeWidth="1.4" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
            </g>
          );
        })}
      </svg>
      <div aria-hidden className="flex justify-between font-mono text-[0.62rem] text-muted-foreground/80 tabular-nums">
        <span>{min === null ? "—" : `min ${format(min)}`}</span>
        <span>{max === null ? "—" : `max ${format(max)}`}</span>
      </div>
    </figure>
  );
}
