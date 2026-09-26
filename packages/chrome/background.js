import {
  applyLedgerStates,
  clearHistory,
  OUTCOME,
  pendingJobIds,
  readHistory,
  record,
  removeHistory,
} from "./history.js";
import {
  discardOutbox,
  enqueue,
  flushOutbox,
  OUTBOX_ALARM,
  outboxCount,
  readOutbox,
  scheduleFlush,
} from "./outbox.js";
import {
  fetchShareStates,
  hasHostPermission,
  loadConfig,
  postShare,
} from "./shared.js";

const MENU_PAGE = "agentstack-share-page";
const MENU_LINK = "agentstack-share-link";
const MENU_SELECTION = "agentstack-share-selection";

function notify(title, message) {
  chrome.notifications.create({
    type: "basic",
    iconUrl: "icons/icon128.png",
    title,
    message,
  });
}

const FLASH_MS = 4000;

/**
 * While a flash is on screen the badge belongs to it, and its own timer
 * restores the standing state afterwards. Without this a background drain
 * lands between the flash and its timer and clears the outcome the user was
 * meant to read.
 */
let flashUntil = 0;

/** A pending outbox is standing state, so it owns the badge until it drains. */
async function refreshBadge() {
  if (Date.now() < flashUntil) return;
  const pending = await outboxCount();
  if (pending === 0) {
    await chrome.action.setBadgeText({ text: "" });
    return;
  }
  await chrome.action.setBadgeBackgroundColor({ color: "#b45309" });
  await chrome.action.setBadgeText({ text: String(pending) });
}

/**
 * Badges the toolbar button briefly so the common case needs no notification
 * click-through, while still surfacing the detail for failures. The pending
 * count is restored afterwards rather than cleared.
 */
async function flashBadge(text, color) {
  flashUntil = Date.now() + FLASH_MS;
  await chrome.action.setBadgeBackgroundColor({ color });
  await chrome.action.setBadgeText({ text });
  setTimeout(() => {
    flashUntil = 0;
    void refreshBadge();
  }, FLASH_MS);
}

function describe(payload) {
  return payload.url ?? payload.title ?? "the shared selection";
}

const DROP_TITLE = {
  expired: "Share abandoned",
  overflow: "Share discarded",
  rejected: "Share rejected",
};

const DROP_DETAIL = {
  expired: (entry) =>
    `AgentStack never became reachable for ${describe(entry.payload)}.`,
  overflow: (entry) =>
    `The outbox is full, so ${describe(entry.payload)} was dropped as the oldest waiting share.`,
  rejected: (entry, result) =>
    `${describe(entry.payload)}: ${result?.message ?? "the ingress refused it."}`,
};

const DROP_OUTCOME = {
  expired: OUTCOME.ABANDONED,
  overflow: OUTCOME.DISCARDED,
  rejected: OUTCOME.REJECTED,
};

async function reportDropped(dropped) {
  for (const { entry, reason, result } of dropped) {
    notify(DROP_TITLE[reason], DROP_DETAIL[reason](entry, result));
    await record({
      id: entry.id,
      payload: entry.payload,
      outcome: DROP_OUTCOME[reason],
      destination: entry.destination,
      message: result?.message ?? DROP_DETAIL[reason](entry, result),
    });
  }
}

/** The history's word for what the ingress answered. */
function outcomeFor(status) {
  if (status === "duplicate") return OUTCOME.DUPLICATE;
  if (status === "already_indexed") return OUTCOME.INDEXED;
  return OUTCOME.SENT;
}

/**
 * Delivers what the outbox holds. Serialized within this worker instance: two
 * concurrent rounds would attempt the same entries, and while the ingress
 * deduplicates that, the second round's commit could resurrect an entry the
 * first had just delivered.
 */
let flushing = null;

async function drainOutbox({ force = false } = {}) {
  const run = async () => {
    const config = await loadConfig();
    if (config === null || !(await hasHostPermission(config.serverUrl))) {
      return { pending: await outboxCount(), unconfigured: true };
    }
    const summary = await flushOutbox((payload) => postShare(config, payload), {
      force,
      destination: config.serverUrl,
    });
    for (const { entry, result } of summary.settled) {
      await record({
        id: entry.id,
        payload: entry.payload,
        outcome: outcomeFor(result.data?.status),
        job: result.data?.job_id ?? null,
        destination: entry.destination,
      });
    }
    await reportDropped(summary.dropped);
    await scheduleFlush(Date.now(), config.serverUrl);
    await refreshBadge();
    return summary;
  };

  flushing = flushing ? flushing.then(run, run) : run();
  return flushing;
}

/**
 * Holds a share the ingress has not accepted and tells the user it is kept, not
 * saved: nothing is durable in AgentStack until Admission answers.
 */
async function send(payload) {
  const config = await loadConfig();
  // Persist before any fetch, including the first attempt. A worker teardown
  // after admission but before its receipt is safely recovered by deduplication.
  const { entry, dropped } = await enqueue(payload, Date.now(), config?.serverUrl ?? null);
  await record({
    id: entry.id,
    payload,
    outcome: OUTCOME.HELD,
    destination: entry.destination,
  });
  await reportDropped(dropped.map((entry) => ({ entry, reason: "overflow" })));
  await scheduleFlush(Date.now(), config?.serverUrl ?? null);
  const summary = await drainOutbox({ force: true });
  if (summary.unconfigured) {
    notify("Held for later", "Set the AgentStack server URL, share token, and access permission in Settings.");
    await chrome.runtime.openOptionsPage();
  } else {
    const settled = summary.settled.find((item) => item.entry.id === entry.id);
    const held = (await readOutbox()).find((item) => item.id === entry.id);
    if (settled) {
      const receipt = settled.result.data;
      await flashBadge(receipt.status === "queued" ? "OK" : "DUP", "#525252");
      if (receipt.status === "duplicate") notify("Already admitted", `Brain already has this as job ${receipt.job_id}.`);
      if (receipt.status === "already_indexed") notify("Already indexed", `Brain already has this as document ${receipt.document_id}.`);
    } else if (held) {
      const reason = held.destination !== (await loadConfig())?.serverUrl
        ? "This share belongs to another server. Restore its address in Settings to send it."
        : held.lastMessage ?? "The server has not confirmed admission yet.";
      await record({ id: held.id, payload, outcome: OUTCOME.HELD, destination: held.destination, message: reason });
      notify("Held for later", `${reason} ${summary.pending} waiting.`);
    }
  }
  await refreshBadge();
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true,
  });
  return tab ?? null;
}

/**
 * Shares whatever tab is in front. Chrome pages (chrome://, the Web Store)
 * cannot be ingested and are rejected here rather than queued as a job that
 * would fail later in the worker.
 */
async function shareCurrentPage() {
  const tab = await activeTab();
  if (!tab || !tab.url) {
    notify("Nothing to share", "No active tab URL was available.");
    return;
  }
  if (!/^https?:/i.test(tab.url)) {
    notify("Cannot share this page", "Only http(s) pages can be sent.");
    return;
  }
  await send({ url: tab.url, ...(tab.title ? { title: tab.title } : {}) });
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_PAGE,
      title: "Send this page to AgentStack",
      contexts: ["page"],
    });
    chrome.contextMenus.create({
      id: MENU_LINK,
      title: "Send this link to AgentStack",
      contexts: ["link"],
    });
    chrome.contextMenus.create({
      id: MENU_SELECTION,
      title: "Send selection to AgentStack",
      contexts: ["selection"],
    });
  });
  void drainOutbox();
});

// A browser restart is the likeliest moment for a machine that was asleep to
// find the ingress up again, and the alarm may not survive it.
chrome.runtime.onStartup.addListener(() => {
  void drainOutbox();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === OUTBOX_ALARM) void drainOutbox();
});

// The toolbar button opens the popover (manifest `action.default_popup`), so
// there is no onClicked here. Sharing the current page stays one keystroke
// away on the command, and one click away inside the popover.
chrome.commands.onCommand.addListener((command) => {
  if (command === "agentstack.share-current-page") void shareCurrentPage();
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === MENU_LINK && info.linkUrl) {
    void send({ url: info.linkUrl });
    return;
  }
  if (info.menuItemId === MENU_SELECTION && info.selectionText) {
    // Selections go over as text. The server extracts a URL when the selection
    // contains one, and otherwise keeps it as a text note.
    void send({
      text: info.selectionText,
      ...(tab?.title ? { title: tab.title } : {}),
    });
    return;
  }
  if (info.menuItemId === MENU_PAGE) void shareCurrentPage();
});

/**
 * Refreshes what the ingress says became of the jobs still in flight, and
 * returns the history either way. The popover calls this on a short cadence
 * while it is open; nothing here is scheduled in the background, because a
 * status nobody is looking at is not worth a request.
 */
async function refreshHistory() {
  const entries = await readHistory();
  const config = await loadConfig();
  const ids = pendingJobIds(entries, config?.serverUrl ?? null);
  if (config === null || ids.length === 0) return { entries, reachable: null };
  if (!(await hasHostPermission(config.serverUrl))) {
    return { entries, reachable: null };
  }
  const { ok, states } = await fetchShareStates(config, ids);
  if (!ok) return { entries, reachable: false };
  return { entries: await applyLedgerStates(states, Date.now(), config.serverUrl), reachable: true };
}

/** The Options page and the popover drive the client through these messages. */
chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  if (message?.type === "agentstack.outbox-status") {
    void outboxCount().then((pending) => respond({ pending }));
    return true;
  }
  if (message?.type === "agentstack.outbox-flush") {
    void drainOutbox({ force: true }).then((summary) => respond(summary));
    return true;
  }
  if (message?.type === "agentstack.history-refresh") {
    void refreshHistory().then(async (result) =>
      respond({ ...result, pending: await outboxCount() }),
    );
    return true;
  }
  if (message?.type === "agentstack.history-clear") {
    void clearHistory().then((discarded) => respond({ discarded }));
    return true;
  }
  if (message?.type === "agentstack.history-remove") {
    void removeHistory(message.id).then((removed) => respond({ removed }));
    return true;
  }
  if (message?.type === "agentstack.share-current-page") {
    void shareCurrentPage().then(() => respond({ done: true }));
    return true;
  }
  if (message?.type === "agentstack.outbox-clear") {
    void (async () => {
      const entries = await discardOutbox();
      const discarded = entries.length;
      for (const entry of entries) {
        await record({ id: entry.id, payload: entry.payload, destination: entry.destination, outcome: OUTCOME.DISCARDED, message: "Removed from this device’s outbox. Any unconfirmed server admission is unaffected." });
      }
      await scheduleFlush(Date.now(), (await loadConfig())?.serverUrl ?? null);
      await refreshBadge();
      respond({ discarded });
    })();
    return true;
  }
  return false;
});

void refreshBadge();
