"use client";

/** Lossless structured inspection: nested values stay readable and copyable. */
export function RecordTree({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <span className="text-muted-foreground italic">Not reported</span>;
  if (typeof value !== "object") return <span className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{String(value)}</span>;
  const entries = Object.entries(value);
  if (!entries.length) return <span className="text-muted-foreground">{Array.isArray(value) ? "[]" : "{}"}</span>;
  return (
    <dl className="flex min-w-0 flex-col gap-2 border-l pl-3">
      {entries.map(([key, item]) => (
        <div key={key} className="min-w-0">
          <dt className="text-xs text-muted-foreground">{key}</dt>
          <dd className="text-sm"><RecordTree value={item} /></dd>
        </div>
      ))}
    </dl>
  );
}
