import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { researchFirewall } from "../src/research-egress.js";

test("a failed IPv6 firewall installation aborts before any browser can start", () => {
  const root = mkdtempSync(join(tmpdir(), "as-firewall-"));
  try {
    writeFileSync(join(root, "iptables"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    writeFileSync(join(root, "ip6tables"), "#!/bin/sh\nexit 42\n", { mode: 0o700 });
    const marker = join(root, "browser-started");
    const result = spawnSync("/bin/sh", ["-ec", `${researchFirewall({ privateDestinations: [] })}; printf started > '${marker}'`], { env: { PATH: root }, encoding: "utf8" });
    assert.equal(result.status, 42);
    assert.equal(existsSync(marker), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("real guest netfilter fences TCP subresources, mapped IPv6 and UDP while exact grants work", (t) => {
  if (process.platform !== "linux") return t.skip("requires Linux network namespaces and netfilter");
  const probe = spawnSync("unshare", ["-Urn", "/bin/sh", "-ec", "command -v ip; command -v iptables; command -v ip6tables; iptables -L OUTPUT"], { encoding: "utf8" });
  if (probe.status !== 0) return t.skip("unprivileged network namespaces/netfilter are unavailable");
  const script = `
    const {execFileSync} = require('node:child_process');
    const net = require('node:net'); const udp = require('node:dgram'); const assert = require('node:assert/strict');
    (async () => {
      execFileSync('ip', ['link','set','lo','up']);
      execFileSync('ip', ['addr','add','93.184.216.34/32','dev','lo']);
      execFileSync('ip', ['addr','add','10.55.0.1/32','dev','lo']);
      const server = net.createServer(s => s.end('ok'));
      await new Promise(r => server.listen(18080, '0.0.0.0', r));
      const datagram = udp.createSocket('udp4'); let packets = 0;
      datagram.on('message', () => packets++);
      await new Promise(r => datagram.bind(18081, '0.0.0.0', r));
      execFileSync('/bin/sh', ['-ec', process.env.FIREWALL]);
      const reach = (host, port=18080) => new Promise(r => { const s=net.connect({host,port});
        const timer=setTimeout(() => {s.destroy();r(false)},300);
        s.once('connect',()=>{clearTimeout(timer);s.destroy();r(true)});
        s.once('error',()=>{clearTimeout(timer);r(false)}); });
      assert.equal(await reach('93.184.216.34'),true);
      assert.equal(await reach('10.55.0.1'),false);
      assert.equal(await reach('127.0.0.1'),false);
      assert.equal(await reach('::ffff:10.55.0.1'),false);
      datagram.send(Buffer.from('blocked'),18081,'93.184.216.34');
      await new Promise(r=>setTimeout(r,100)); assert.equal(packets,0);
      execFileSync('/bin/sh', ['-ec', process.env.GRANTED]);
      assert.equal(await reach('10.55.0.1'),true);
      assert.equal(await reach('127.0.0.1'),false);
      datagram.close(); server.close();
    })().catch(e=>{console.error(e);process.exit(1)});`;
  execFileSync("unshare", ["-Urn", process.execPath, "-e", script], { timeout: 15_000,
    env: { ...process.env, FIREWALL: researchFirewall({ privateDestinations: [] }), GRANTED: researchFirewall({ privateDestinations: [{ address: "10.55.0.1", port: 18080 }] }) } });
});
