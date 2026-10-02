import type { ScrapeCanaryStatus, ScrapeCapture, ScrapeFailureClass, ScrapePreset, ScrapeQueueJob, ScrapeStatus } from "./types";

export type ScrapeQueueAction = "cancel" | "retry" | "discard";

/** UI eligibility only; the owner's plan still checks native claim evidence and exact generations. */
export function queueMaintenanceActions(job: ScrapeQueueJob): ScrapeQueueAction[] {
  if (job.maintenanceFence) return ["discard"];
  return job.state === "pending" ? ["cancel"] : job.state === "failed" ? ["retry", "discard"] : [];
}

/** Changed inventories cannot silently broaden a selection to directories or shipped fixtures. */
export function corpusSelection(rows: ScrapeCapture[], preset: string, selected: string[]): ScrapeCapture[] | null {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(preset) || !selected.length || selected.length > 100 || new Set(selected).size !== selected.length) return null;
  return selected.every((id) => /^sample-[0-9]{3,10}$/.test(id) && rows.some((row) => row.preset === preset && row.id === id))
    ? selected.map((id) => ({ preset, id })) : null;
}

/**
 * Remote Access sessions receive only Scrape's read-only operations: fetching, canaries and the
 * queue reach the network or write files on the Stack machine, so they stay on the local UI.
 */
export function scrapeLocalReason(remote: unknown): string | null {
  return remote ? "Available only on the local UI" : null;
}

function host(url: URL): string {
  const lower = url.hostname.toLowerCase();
  return lower.startsWith("www.") ? lower.slice(4) : lower;
}

export type PresetPreview =
  | { kind: "invalid" }
  | { kind: "match"; presets: string[] }
  | { kind: "claimed"; domain: string }
  | { kind: "generic" };

/**
 * Which preset `scrape_fetch` would choose for a URL, mirroring its automatic selection for a
 * preview. Scrape's own answer is authoritative; a claimed host without a matching pattern fails
 * there instead of falling back to generic extraction.
 */
export function presetPreview(value: string, presets: ScrapePreset[]): PresetPreview {
  let url: URL;
  try { url = new URL(value.trim()); } catch { return { kind: "invalid" }; }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return { kind: "invalid" };
  url.hash = "";
  if ((url.protocol === "http:" && url.port === "80") || (url.protocol === "https:" && url.port === "443")) url.port = "";
  const hostname = host(url);
  const href = url.href;
  const owns = (preset: ScrapePreset) => preset.domain === "*" || [preset.domain, ...preset.aliases].some((item) => item.toLowerCase().replace(/^www\./, "") === hostname);
  const matches = presets.filter((preset) => owns(preset) && preset.url_patterns.some((pattern) => {
    try {
      const match = new RegExp(pattern).exec(href);
      return match?.index === 0 && match[0].length === href.length;
    } catch { return false; }
  }));
  if (matches.length) return { kind: "match", presets: matches.map((preset) => preset.name).sort() };
  const claimed = presets.find((preset) => preset.domain !== "*" && owns(preset));
  return claimed ? { kind: "claimed", domain: claimed.domain } : { kind: "generic" };
}

export const failureLabels: Record<ScrapeFailureClass, string> = {
  invalid_request: "Invalid request",
  authentication_required: "Sign-in required",
  upstream_unavailable: "Source unavailable",
  timeout: "Timed out",
  browser_error: "Browser error",
  provider_error: "Provider error",
  malformed_provider_output: "Preset needs update",
  empty_content: "No content",
  output_limit_exceeded: "Output too large",
  cancelled: "Cancelled",
  internal_error: "Internal error",
};

/** The preset a `malformed_provider_output` failure names, from its evidence or implementation. */
export function driftedPreset(failure: { failure_class: ScrapeFailureClass; evidence: string; message: string } | null, implementation: string | null, presets: ScrapePreset[]): string | null {
  if (failure?.failure_class !== "malformed_provider_output") return null;
  const named = /Preset needs update: ([\w.-]+)/.exec(failure.evidence)?.[1] ?? /^([\w.-]+):/.exec(failure.message)?.[1] ?? implementation;
  return named && presets.some((preset) => preset.name === named) ? named : null;
}

export type CallError = { text: string; uncertain: boolean };

/**
 * A rejected WebSocket call. A timeout or dropped connection may leave the operation running on
 * the socket, so its outcome is unknown; never resend it automatically.
 */
export function scrapeCallError(error: unknown): CallError {
  const message = error instanceof Error ? error.message : String(error);
  const [code, ...rest] = message.split("\n");
  // "not connected" is refused before sending; a closed connection or timeout was already sent.
  if (/timed out|connection closed/i.test(message)) return { text: `Outcome unknown: ${message}`, uncertain: true };
  if (code === "malformed_provider_output") return { text: `Preset needs update. ${rest.join(" ")}`.trim(), uncertain: false };
  if (code === "scrape_stopping") return { text: "Scrape is stopping", uncertain: false };
  return { text: rest.length ? `${code}: ${rest.join(" ")}` : message, uncertain: false };
}

export const canaryView: Record<ScrapeCanaryStatus, { label: string; tone: "success" | "destructive" | "warning" | "muted" }> = {
  pass: { label: "Pass", tone: "success" },
  drift: { label: "Drift", tone: "destructive" },
  operational_failure: { label: "Could not check", tone: "warning" },
  not_configured: { label: "Not configured", tone: "muted" },
};

/** Optional executables and the routes that need them. */
export const scrapeCapabilities: Array<{ key: keyof Omit<ScrapeStatus, "stateRoot">; tool: string; routes: string }> = [
  { key: "browser", tool: "agent-browser", routes: "Browser pages and X, ChatGPT and DeepWiki presets" },
  { key: "github", tool: "gh", routes: "GitHub content" },
  { key: "pdf", tool: "pdftotext", routes: "PDF documents" },
  { key: "pandoc", tool: "pandoc", routes: "Document conversion" },
  { key: "summary", tool: "summaryctl", routes: "Queue job summaries" },
];

/** A queue job's short label: its URL host and path, or its record file when unreadable. */
export function jobLabel(job: Pick<ScrapeQueueJob, "url" | "file">): string {
  if (!job.url) return job.file;
  try {
    const url = new URL(job.url);
    return `${url.host}${url.pathname === "/" ? "" : url.pathname}`;
  } catch { return job.url; }
}

/** Frontmatter entered as `key: value` lines; values stay strings. Null when a line has no key. */
export function parseFrontmatter(text: string): Record<string, string> | null {
  const result: Record<string, string> = {};
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const colon = line.indexOf(":");
    const key = colon > 0 ? line.slice(0, colon).trim() : "";
    if (!key) return null;
    result[key] = line.slice(colon + 1).trim();
  }
  return result;
}
