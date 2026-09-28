import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { fetchMarkdown } from "../src/api.js";
import { currentEgress, EgressRefused, egressPolicy, publicEgress, withEgressPolicy } from "../src/egress.js";
import { resolveNetworkAddress, NetworkPolicyFault } from "../src/network-policy.js";
import { requestPinnedHttp } from "../src/pinned-http.js";

test("public research refuses numeric and DNS private destinations even when a caller opts in", async () => {
  await withEgressPolicy(publicEgress, () => {}, async () => {
    for (const host of ["127.0.0.1", "2130706433", "0x7f000001", "10.1.2.3", "169.254.169.254", "192.0.0.8", "198.18.0.1", "224.0.0.1",
      "[::1]", "[::ffff:127.0.0.1]", "[fd00::1]", "[fe80::1]", "[2001:db8::1]", "[2002:7f00:1::1]"]) {
      await assert.rejects(resolveNetworkAddress(new URL(`http://${host}/`), { allowPrivateNetwork: true }), NetworkPolicyFault);
    }
    await assert.rejects(resolveNetworkAddress(new URL("https://mixed.example/"), { allowPrivateNetwork: true,
      resolver: async () => [{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.1", family: 4 }] }), NetworkPolicyFault);
    assert.deepEqual(await resolveNetworkAddress(new URL("https://public.example/"), { resolver: async () => [{ address: "2606:4700:4700::1111", family: 6 }] }),
      { address: "2606:4700:4700::1111", family: 6 });
    await assert.rejects(requestPinnedHttp({ url: new URL("http://example.com/"), address: { address: "127.0.0.1", family: 4 }, method: "GET", maxResponseBytes: 100 }), NetworkPolicyFault);
  });
});

test("exact TCP grants, static HTML extraction and redirect revalidation use the pinned transport", async (t) => {
  let hits = 0, forbiddenHits = 0;
  const forbidden = createServer((_req, res) => { forbiddenHits++; res.end("secret"); });
  await new Promise<void>((resolve) => forbidden.listen(0, "127.0.0.1", resolve));
  const forbiddenPort = (forbidden.address() as { port: number }).port;
  const server = createServer((req, res) => {
    hits++;
    if (req.url === "/redirect.md") res.writeHead(302, { location: `http://127.0.0.1:${forbiddenPort}/private.md` }).end();
    else if (req.url === "/article") res.writeHead(200, { "content-type": "text/html" }).end("<h1>Research</h1><p>Static content</p><script>fetch('/private')</script>");
    else res.writeHead(200, { "content-type": "text/markdown" }).end("# Public research");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => Promise.all([new Promise<void>((r) => server.close(() => r())), new Promise<void>((r) => forbidden.close(() => r()))]));
  const port = (server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}`;
  const denied = await withEgressPolicy(publicEgress, () => {}, () => fetchMarkdown(`${url}/note.md`, { envelope: true, allowPrivateNetwork: true }));
  assert.equal("status" in denied && denied.status, "failure");
  assert.equal(hits, 0);
  const policy = { privateDestinations: [{ address: "127.0.0.1", port }] };
  await withEgressPolicy(policy, () => {}, async () => {
    const markdown = await fetchMarkdown(`${url}/note.md`, { envelope: true });
    assert.equal("status" in markdown && markdown.status, "success");
    const html = await fetchMarkdown(`${url}/article`, { envelope: true });
    assert.equal("status" in html && html.status, "success");
    assert.match(JSON.stringify(html), /Static content/);
    const redirect = await fetchMarkdown(`${url}/redirect.md`, { envelope: true });
    assert.equal("status" in redirect && redirect.status, "failure");
    assert.match(JSON.stringify(redirect), /private_destination/);
  });
  assert.equal(hits, 3);
  assert.equal(forbiddenHits, 0);
});

test("DNS answers are checked anew and grants cannot widen to another address or port", async () => {
  const policy = egressPolicy.parse({ privateDestinations: [{ address: "fd00:0:0::1", port: 443 }, { address: "10.0.0.1", port: 8443 }] });
  assert.equal(policy.privateDestinations[0]!.address, "fd00::1");
  await withEgressPolicy(policy, () => {}, async () => {
    let address = "93.184.216.34";
    const resolver = async () => [{ address, family: 4 as const }];
    const url = new URL("https://rebind.example:8443/");
    assert.equal((await resolveNetworkAddress(url, { resolver })).address, address);
    address = "10.0.0.2";
    await assert.rejects(resolveNetworkAddress(url, { resolver }), NetworkPolicyFault);
    address = "10.0.0.1";
    assert.equal((await resolveNetworkAddress(url, { resolver })).address, address);
    await assert.rejects(resolveNetworkAddress(new URL("https://rebind.example/"), { resolver }), NetworkPolicyFault);
  });
});

test("revocation aborts active transport work and cannot be hidden by an engine failure", async () => {
  let revoked = false;
  await assert.rejects(withEgressPolicy(publicEgress, () => { if (revoked) throw new EgressRefused("egress_grant_revoked"); }, async () => {
    const signal = currentEgress()!.signal;
    revoked = true;
    await new Promise<void>((resolve) => { const timer = setTimeout(resolve, 1000); signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true }); });
    assert.equal(signal.aborted, true);
    throw new Error("masked provider failure");
  }), /egress_grant_revoked/);
});
