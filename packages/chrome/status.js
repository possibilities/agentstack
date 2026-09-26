/**
 * How one share reads in the popover.
 *
 * Two authorities, in order. What the client did with the share is its own to
 * report — held, sent, rejected, abandoned. What became of the job afterwards
 * belongs to the ledger and is only ever echoed from the ingress, which is why
 * a ledger state, once known, wins over the client's memory of delivery.
 *
 * The words are the ledger's, not invented here: a `blocked` or `failed` job
 * carrying a failure class is stranded, a `duplicate` is a success
 * naming the job that already existed, and nothing held is ever called saved
 *.
 */

import { OUTCOME } from "./history.js";

const LEDGER_LABEL = {
  queued: {
    label: "Queued",
    tone: "working",
    detail: "Waiting for the worker.",
  },
  running: {
    label: "Indexing",
    tone: "working",
    detail: "Being extracted now.",
  },
  retry_wait: {
    label: "Retrying",
    tone: "working",
    detail: "Extraction failed; it will try again.",
  },
  completed: { label: "Indexed", tone: "indexed", detail: null },
  excluded: {
    label: "Excluded",
    tone: "muted",
    detail: "Dispositioned by an operator.",
  },
  cancelled: {
    label: "Cancelled",
    tone: "muted",
    detail: "Dispositioned by an operator.",
  },
};

function ledgerStatus(ledger) {
  if (ledger.state === "blocked" || ledger.state === "failed") {
    // Stranded: an attempt ran and no retry will revive it.
    return {
      label: "Stranded",
      tone: "problem",
      detail: ledger.failureClass
        ? `Extraction failed (${ledger.failureClass}).`
        : "Extraction failed and will not retry.",
    };
  }
  const known = LEDGER_LABEL[ledger.state];
  if (known === undefined) return null;
  if (ledger.state === "completed") {
    return {
      ...known,
      detail:
        ledger.documentId === null
          ? "Searchable in AgentStack."
          : `Document ${ledger.documentId}.`,
    };
  }
  return known;
}

const CLIENT_STATUS = {
  [OUTCOME.HELD]: { label: "Held", tone: "held" },
  [OUTCOME.SENT]: { label: "Sent", tone: "sent" },
  [OUTCOME.DUPLICATE]: { label: "Duplicate", tone: "sent" },
  [OUTCOME.INDEXED]: { label: "Already saved", tone: "indexed" },
  [OUTCOME.REJECTED]: { label: "Rejected", tone: "problem" },
  [OUTCOME.ABANDONED]: { label: "Abandoned", tone: "problem" },
  [OUTCOME.DISCARDED]: { label: "Discarded", tone: "problem" },
};

export function statusFor(entry) {
  if (entry.ledger) {
    const fromLedger = ledgerStatus(entry.ledger);
    if (fromLedger !== null) {
      return {
        ...fromLedger,
        detail: fromLedger.detail ?? messageFor(entry),
      };
    }
  }
  const client = CLIENT_STATUS[entry.outcome] ?? {
    label: "Unknown",
    tone: "muted",
  };
  return { ...client, detail: messageFor(entry) };
}

function messageFor(entry) {
  if (entry.outcome === OUTCOME.HELD) {
    // Held is not saved. Say what it is waiting for, not that it landed.
    return entry.message ?? "Waiting for the ingress to answer.";
  }
  if (entry.message) return entry.message;
  if (entry.job !== null) return `Job ${entry.job}.`;
  return null;
}

/** What to show as the entry's name, falling back through what a share had. */
export function labelFor(entry) {
  if (entry.title) return entry.title;
  if (entry.url) return entry.url;
  if (entry.text) return entry.text.slice(0, 80);
  return "Shared item";
}

export function hostFor(entry) {
  if (!entry.url) return "text note";
  try {
    return new URL(entry.url).host;
  } catch {
    return entry.url;
  }
}
