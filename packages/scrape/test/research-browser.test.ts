import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { operation, serveSocket, socketPath } from "@agentstack/api";
import { z } from "zod";
import { publicEgress, withEgressPolicy } from "../src/egress.js";
import { runAgentBrowser, withBrowserSession, withBrowserNetworkPolicy } from "../src/browser.js";

test("research requires an enforcing owner provider and cannot reuse pinned profiles or caller network consent", async () => {
  const root = mkdtempSync(join(tmpdir(), "as-research-browser-"));
  const tool = join(root, "agent-browser"), log = join(root, "argv.jsonl");
  writeFileSync(tool, `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(log)},JSON.stringify(process.argv.slice(2))+'\\n'); console.log('ok');\n`, { mode: 0o700 });
  const env = { ...process.env, HOME: root, AGENTSTACK_STATE_DIR: root, AGENTSCRAPE_AGENT_BROWSER_BIN: tool, AGENTSCRAPE_BROWSER_SESSION: "existing-signed-in-profile" };
  let acquired = 0, closed = 0;
  const execute = () => withEgressPolicy(publicEgress, () => {}, () => withBrowserNetworkPolicy(true, () => withBrowserSession("caller-session", () => runAgentBrowser(["eval", "1"], "caller-session", "signed-in-profile"))), env);
  try {
    await assert.rejects(execute(), /browser|egress/i);
    if (existsSync(log)) assert.ok(readFileSync(log, "utf8").trim().split("\n").every((line) => (JSON.parse(line) as string[]).at(-1) === "close"), "no page command reaches an unverified browser");
    const served = await serveSocket({ info: { name: "browse", description: "Fixture", transportDescription: "Socket", path: socketPath("browse", env) }, context: {}, operations: [
      operation({ name: "browser_research_acquire", description: "Acquire", input: z.object({ session: z.uuid(), policy: z.any() }), output: z.any(), async call(_ctx, input) {
        acquired++; assert.deepEqual(input.policy, publicEgress);
        return { cdpUrl: "http://127.0.0.1:19999", enforcement: "guest-output-v1", cleanup: { session: "fixture", lease: "lease", backend: "local", browserTarget: "target", browserProfile: "disposable" } };
      } }),
      operation({ name: "browser_session_close", description: "Close", input: z.object({ cleanup: z.any() }), output: z.any(), async call(_ctx, input) { closed++; assert.equal(input.cleanup.lease, "lease"); return { closed: true }; } }),
    ] });
    try {
      await execute();
      assert.equal(acquired, 1); assert.equal(closed, 1);
      const commands = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]);
      const command = commands.find((args) => args.includes("eval"))!;
      assert.equal(command[command.indexOf("--cdp") + 1], "http://127.0.0.1:19999");
      assert.match(command[command.indexOf("--session") + 1]!, /^research-/);
      assert.ok(!command.includes("--browserctl-profile") && !command.includes("caller-session") && !command.includes("existing-signed-in-profile"));
    } finally { await served.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
