import { CONFIG_KEY, DEFAULT_SERVER_URL, healthEndpoint, normalizeServerUrl, originPatternFor, readConfig } from "./shared.js";

const serverInput = document.getElementById("serverUrl");
const tokenInput = document.getElementById("token");
const statusEl = document.getElementById("status");
const outboxEl = document.getElementById("outbox");

function show(message, ok) {
  statusEl.textContent = message;
  statusEl.className = ok ? "ok" : "err";
}

function normalizedServerUrl() {
  const raw = serverInput.value.trim().replace(/\/+$/, "");
  if (raw === "") throw new Error("Enter the AgentStack server URL.");
  return normalizeServerUrl(raw);
}

function pendingText(pending) {
  if (pending === 0) return "Nothing is waiting.";
  return pending === 1
    ? "1 share is waiting to be sent."
    : `${pending} shares are waiting to be sent.`;
}

async function refreshOutbox() {
  const { pending } = await chrome.runtime.sendMessage({
    type: "agentstack.outbox-status",
  });
  outboxEl.textContent = pendingText(pending);
}

async function restore() {
  const stored = await readConfig();
  serverInput.value = stored.serverUrl ?? DEFAULT_SERVER_URL;
  tokenInput.value = stored.token ?? "";
}

document.getElementById("save").addEventListener("click", async () => {
  let serverUrl;
  try {
    serverUrl = normalizedServerUrl();
  } catch (error) {
    show(error.message, false);
    return;
  }
  const token = tokenInput.value.trim();
  if (token === "") {
    show("Enter the share token.", false);
    return;
  }

  // Host permission must be requested from a user gesture, which this click is.
  const granted = await chrome.permissions.request({
    origins: [originPatternFor(serverUrl)],
  });
  if (!granted) {
    show(
      "Permission was declined, so the extension cannot reach that server.",
      false,
    );
    return;
  }
  await chrome.storage.local.set({ [CONFIG_KEY]: { serverUrl, token } });
  show("Saved. Try 'Test connection' to confirm the server answers.", true);
  // A server that was only just named may be the one the outbox is waiting on.
  await chrome.runtime.sendMessage({ type: "agentstack.outbox-flush" });
  await refreshOutbox();
});

document.getElementById("test").addEventListener("click", async () => {
  let serverUrl;
  try {
    serverUrl = normalizedServerUrl();
  } catch (error) {
    show(error.message, false);
    return;
  }
  const token = tokenInput.value.trim();
  try {
    const response = await fetch(healthEndpoint(serverUrl), {
      signal: AbortSignal.timeout(15_000),
      headers: { authorization: `Bearer ${token}` },
    });
    if (response.status === 401) {
      show("Reached the server, but the token was rejected.", false);
      return;
    }
    if (!response.ok) {
      show(`Server answered HTTP ${response.status}.`, false);
      return;
    }
    show("Connected. AgentStack is ready to receive shares.", true);
    await chrome.runtime.sendMessage({ type: "agentstack.outbox-flush" });
    await refreshOutbox();
  } catch {
    show(
      "Could not reach the server. Check the connection and AgentStack Brain share listener.",
      false,
    );
  }
});

document.getElementById("flush").addEventListener("click", async () => {
  outboxEl.textContent = "Sending…";
  const summary = await chrome.runtime.sendMessage({ type: "agentstack.outbox-flush" });
  if (summary.unconfigured) {
    show("Save the server URL and token first; held shares are kept.", false);
  } else if (summary.otherDestination > 0) {
    show(`${summary.otherDestination} share(s) belong to another server. Restore its address to send them; ${summary.pending} still waiting.`, false);
  } else if (summary.attempted === 0 && summary.dropped.length === 0) {
    show("Nothing was waiting to be sent.", true);
  } else {
    const accepted = summary.delivered + summary.duplicate;
    show(
      `Brain admitted ${accepted} of ${summary.attempted}; ${summary.pending} still waiting; ${summary.dropped.length} not delivered.`,
      summary.pending === 0 && summary.dropped.length === 0,
    );
  }
  await refreshOutbox();
});

document.getElementById("discard").addEventListener("click", async () => {
  const { discarded } = await chrome.runtime.sendMessage({
    type: "agentstack.outbox-clear",
  });
  show(
    discarded === 0
      ? "Nothing was waiting."
      : `Discarded ${discarded} held share(s). Any unconfirmed server admission is unaffected.`,
    discarded === 0,
  );
  await refreshOutbox();
});

void restore();
void refreshOutbox();
