import { normalizeServerUrl, originPatternFor } from "./shared.js";
const serverInput = document.getElementById("serverUrl");
const statusEl = document.getElementById("status");
const outboxEl = document.getElementById("outbox");
const codeEl = document.getElementById("pairing-code");
function show(message, ok = false) { statusEl.textContent = message; statusEl.className = ok ? "ok" : "err"; }
async function connection(action, args = {}) {
  const value = await chrome.runtime.sendMessage({ type: "stack.connection", action, ...args });
  if (value.error) throw new Error(value.error); return value;
}
async function restore() {
  const state = await connection("state"); serverInput.value = state.serverUrl ?? "";
  codeEl.textContent = state.code ? `Approval code: ${state.code}` : "";
  show(state.paired ? `Paired. ${state.observation ? `${state.observation.state} (checked ${new Date(state.observation.at).toLocaleString()})` : "Connection not yet checked."}` : state.state === "pending" ? "Waiting for local approval. If expired, choose Pair again." : state.state === "expired" ? "Pairing expired. Choose Pair again." : "Disconnected. Pair to connect; old shared tokens are no longer accepted.", false);
}
async function refreshOutbox() { const { pending } = await chrome.runtime.sendMessage({ type: "stack.outbox-status" }); outboxEl.textContent = `${pending} share(s) held.`; }
function action(id, run) {
  const button = document.getElementById(id);
  button.addEventListener("click", async () => { const controls = document.querySelectorAll("button, input"); controls.forEach(control => { control.disabled = true; }); try { await run(); } catch (error) { show(error.message); } finally { controls.forEach(control => { control.disabled = false; }); } });
}
action("save", async () => {
  const serverUrl = normalizeServerUrl(serverInput.value);
  if (!await chrome.permissions.request({ origins: [originPatternFor(serverUrl)] })) throw new Error("Host permission declined.");
  const paired = await connection("pair", { serverUrl }); codeEl.textContent = `Approval code: ${paired.code}`;
  show("Approve the matching code in Stack System → Access, then check approval.", true);
});
action("test", async () => { await connection("complete"); await restore(); await chrome.runtime.sendMessage({ type: "stack.outbox-flush" }); await refreshOutbox(); });
action("disconnect", async () => { await connection("disconnect"); await restore(); });
action("check", async () => { try { await connection("check"); } finally { await restore(); } });
action("forget", async () => {
  if (!confirm("Forget this local credential without confirming server revocation? Revoke the old credential in System → Access. Held shares stay bound to their original server.")) return;
  await connection("forget", { confirm: "forget-without-revocation" }); await restore();
});
action("flush", async () => {
  const result = await chrome.runtime.sendMessage({ type: "stack.outbox-flush" });
  show(result.unconfigured ? "Pair or recover your connection first. Held shares are kept." : `Brain admitted ${result.delivered + result.duplicate}; ${result.pending} held; ${result.otherDestination} belong to another server.`, !result.unconfigured);
  await refreshOutbox();
});
action("discard", async () => { const { discarded } = await chrome.runtime.sendMessage({ type: "stack.outbox-clear" }); show(`Discarded ${discarded} held share(s).`, true); await refreshOutbox(); });
void restore().catch(error => show(error.message));
void refreshOutbox();
