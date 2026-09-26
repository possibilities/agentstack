/**
 * The toolbar popover: the last shares and what became of each.
 *
 * Two update paths, and neither runs when nobody is looking. `storage.onChanged`
 * carries anything the service worker decides — a share held, delivered, or
 * dropped — the moment it happens. The ingress is asked for job states on a
 * short poll, but only while this popover is open and only about jobs that have
 * not reached a terminal state.
 */

import { HISTORY_KEY, HISTORY_MAX_ENTRIES } from "./history.js";
import { OUTBOX_KEY } from "./outbox.js";
import { hostFor, labelFor, statusFor } from "./status.js";

const POLL_MS = 3_000;

const list = document.getElementById("list");
const empty = document.getElementById("empty");
const statusLine = document.getElementById("status");

async function ask(message) {
  const result = await chrome.runtime.sendMessage(message);
  if (result === undefined) {
    throw new Error(`No response to ${message.type}`);
  }
  return result;
}

function reportFailure(action, error) {
  console.error(`AgentStack popover could not ${action}`, error);
  statusLine.textContent =
    "Extension error · click Reload at chrome://extensions";
}

function render(entries, { pending, reachable }) {
  list.replaceChildren();
  const shown = entries.slice(0, HISTORY_MAX_ENTRIES);
  empty.hidden = shown.length > 0;
  for (const entry of shown) {
    const status = statusFor(entry);
    const item = document.createElement("li");

    const title = document.createElement("span");
    title.className = "title";
    title.textContent = labelFor(entry);
    title.title = entry.url ?? labelFor(entry);

    const chip = document.createElement("span");
    chip.className = `chip ${status.tone}`;
    chip.textContent = status.label;

    const where = document.createElement("span");
    where.className = "where";
    where.textContent = hostFor(entry);

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "remove";
    remove.textContent = "Remove";
    remove.title = "Remove from recent shares";
    remove.setAttribute(
      "aria-label",
      `Remove ${labelFor(entry)} from recent shares`,
    );
    remove.addEventListener("click", (event) =>
      runAction(
        event.currentTarget,
        { type: "agentstack.history-remove", id: entry.id },
        "remove the item",
      ),
    );

    const actions = document.createElement("span");
    actions.className = "actions";
    actions.append(chip, remove);

    item.append(title, actions, where);
    if (status.detail) {
      const detail = document.createElement("span");
      detail.className = "detail";
      detail.textContent = status.detail;
      item.append(detail);
    }
    list.append(item);
  }

  const held = pending === 1 ? "1 share held" : `${pending} shares held`;
  // Unreachable is worth saying plainly: the list is still true, just older
  // than the ledger it describes.
  statusLine.textContent =
    pending > 0
      ? `${held}${reachable === false ? " · ingress unreachable" : ""}`
      : reachable === false
        ? "Ingress unreachable"
        : reachable === true ? "Up to date" : "Local history";
}

async function runAction(button, message, action) {
  button.disabled = true;
  try {
    await ask(message);
    await refresh();
  } catch (error) {
    reportFailure(action, error);
  } finally {
    button.disabled = false;
  }
}

let refreshing = false;

async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    const result = await ask({ type: "agentstack.history-refresh" });
    render(result.entries, result);
  } catch (error) {
    reportFailure("refresh", error);
  } finally {
    refreshing = false;
  }
}

document.getElementById("share").addEventListener("click", async (event) => {
  await runAction(
    event.currentTarget,
    { type: "agentstack.share-current-page" },
    "share this page",
  );
});

document.getElementById("flush").addEventListener("click", async (event) => {
  await runAction(
    event.currentTarget,
    { type: "agentstack.outbox-flush" },
    "send held shares",
  );
});

document.getElementById("clear").addEventListener("click", async (event) => {
  await runAction(
    event.currentTarget,
    { type: "agentstack.history-clear" },
    "clear the list",
  );
});

document.getElementById("options").addEventListener("click", () => {
  void chrome.runtime.openOptionsPage();
});

// Anything the service worker writes lands here without waiting for the poll.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (HISTORY_KEY in changes || OUTBOX_KEY in changes)) {
    void refresh();
  }
});

const timer = setInterval(() => void refresh(), POLL_MS);
window.addEventListener("unload", () => clearInterval(timer));
void refresh();
