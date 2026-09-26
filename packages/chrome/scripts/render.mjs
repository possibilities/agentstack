/** Optional, isolated headless layout check. Uses synthetic state, never a Chrome profile. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const evidence = new URL("evidence/", root);
await mkdir(evidence, { recursive: true });
const profile = await mkdtemp(fileURLToPath(new URL("profile-", evidence)));
const chrome = spawn(process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", [
  "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`,
  "--no-first-run", "--no-default-browser-check", "--disable-background-networking",
  "--disable-component-update", "--disable-extensions", "--allow-file-access-from-files", "about:blank",
], { stdio: ["ignore", "ignore", "pipe"] });
let socket;
try {
  const endpoint = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Headless Chrome did not start")), 15_000);
    chrome.once("error", reject);
    chrome.stderr.on("data", (chunk) => {
      const match = chunk.toString().match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) { clearTimeout(timeout); resolve(match[1]); }
    });
  });
  socket = new WebSocket(endpoint);
  await once(socket, "open");
  let nextId = 0;
  const pending = new Map();
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    if (message.id) {
      const receipt = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) receipt.reject(new Error(message.error.message));
      else receipt.resolve(message.result);
    }
  });
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params, sessionId }));
  });
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  const call = (method, params = {}) => send(method, params, sessionId);
  const evaluate = async (expression) => {
    const result = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  };
  await call("Page.enable");
  await call("Page.addScriptToEvaluateOnNewDocument", { source: `
    window.fixture = [
      { id: 'a', title: 'A note for later', text: 'A synthetic note', url: null, job: null, outcome: 'held', message: 'The server has not answered. Kept on this device.', ledger: null },
      { id: 'b', title: 'A long article title that should wrap without hiding the useful words', url: 'https://example.com/article', job: 7, outcome: 'sent', ledger: { state: 'completed', documentId: 9, failureClass: null } },
      { id: 'c', title: 'An extraction that needs attention', url: 'https://example.org/report', job: 8, outcome: 'sent', ledger: { state: 'blocked', documentId: null, failureClass: 'authentication_required' } },
    ];
    window.chrome = {
      storage: { local: { get: async (defaults) => defaults, set: async () => {} }, onChanged: { addListener() {} } },
      runtime: {
        openOptionsPage: async () => {},
        sendMessage: async (message) => {
          if (message.type === 'agentstack.history-clear') window.fixture = [];
          if (message.type === 'agentstack.history-remove') window.fixture = fixture.filter(e => e.id !== message.id);
          return { entries: fixture, pending: fixture.filter(e => e.outcome === 'held').length, reachable: true, discarded: 3 };
        }
      }
    };
  ` });
  const results = [];
  for (const theme of ["light", "dark"]) {
    await call("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }] });
    for (const page of ["popup", "options"]) {
      const width = page === "popup" ? 380 : 600;
      await call("Emulation.setDeviceMetricsOverride", { width, height: page === "popup" ? 560 : 760, deviceScaleFactor: 1, mobile: false });
      const loaded = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Page load timed out")), 15_000);
        const listener = ({ data }) => {
          const event = JSON.parse(data);
          if (event.sessionId === sessionId && event.method === "Page.loadEventFired") {
            clearTimeout(timeout);
            socket.removeEventListener("message", listener);
            resolve();
          }
        };
        socket.addEventListener("message", listener);
      });
      await call("Page.navigate", { url: new URL(`${page}.html`, root).href });
      await loaded;
      await evaluate(`new Promise((resolve, reject) => { const deadline = Date.now() + 5000; const check = () => { if (document.getElementById('status') && document.getElementById('status').textContent !== 'Loading…' && (document.querySelector('li') || document.getElementById('serverUrl')?.value)) resolve(true); else if (Date.now() > deadline) reject(new Error('Fixture did not render')); else setTimeout(check, 20); }; check(); })`);
      const metrics = await evaluate(`({width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth, background: getComputedStyle(document.body).backgroundColor, buttons: [...document.querySelectorAll('button')].map(b => b.getAttribute('aria-label') || b.textContent)})`);
      assert.ok(metrics.scroll <= metrics.width, `${theme}/${page} has horizontal overflow`);
      assert.ok(metrics.buttons.every((name) => name.trim().length), "Every control needs a name");
      const screenshot = await call("Page.captureScreenshot", { format: "png" });
      await writeFile(new URL(`${page}-${theme}.png`, evidence), Buffer.from(screenshot.data, "base64"));
      if (page === "popup") {
        await evaluate("document.querySelector('button').focus()");
        await call("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
        await call("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
        const focus = await evaluate("({name: document.activeElement.textContent, style: getComputedStyle(document.activeElement).outlineStyle})");
        assert.equal(focus.style, "solid");
        const focused = await call("Page.captureScreenshot", { format: "png" });
        await writeFile(new URL(`popup-focus-${theme}.png`, evidence), Buffer.from(focused.data, "base64"));
        await evaluate("document.getElementById('clear').click(); new Promise(resolve => setTimeout(resolve, 50))");
        assert.equal(await evaluate("document.querySelectorAll('li').length"), 0);
        const empty = await call("Page.captureScreenshot", { format: "png" });
        await writeFile(new URL(`popup-empty-${theme}.png`, evidence), Buffer.from(empty.data, "base64"));
      }
      results.push({ page, theme, ...metrics });
    }
  }
  await writeFile(new URL("render-results.json", evidence), JSON.stringify(results, null, 2));
  console.log(`Headless light/dark screenshots and focus/overflow checks: ${fileURLToPath(evidence)}`);
} finally {
  socket?.close();
  if (chrome.exitCode === null) {
    chrome.kill("SIGTERM");
    await once(chrome, "exit");
  }
  await rm(profile, { recursive: true, force: true });
}
