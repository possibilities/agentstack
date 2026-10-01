import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

function run(body: string) {
  const root = mkdtempSync(join(tmpdir(), "scrape-state-"));
  const script = `
    import assert from "node:assert/strict";
    import { randomUUID, createHash } from "node:crypto";
    import { mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync } from "node:fs";
    import { join } from "node:path";
    import { createServer } from "node:http";
    import { DatabaseSync } from "node:sqlite";
    import { StateJournal } from "@stack/api";
    import { api } from ${JSON.stringify(fileURLToPath(new URL("../api.js", import.meta.url)))};
    const root = process.env.STACK_STATE_DIR;
    let ctx = await api.createContext();
    const call = async (name, args = {}, invocation) => {
      const op = api.operations.find(op => op.name === name);
      return op.output.parse(await op.call(ctx, op.input.parse(args), invocation));
    };
    const apply = plan => ({planId:plan.id,expectedRevision:plan.revision,requestId:randomUUID()});
    const sha = value => createHash("sha256").update(value).digest("hex");
    try { ${body} } finally { await api.prepareCloseContext(ctx); await api.closeContext(ctx); }
  `;
  try {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      env: { ...process.env, STACK_STATE_DIR: root, AGENTSCRAPE_PROCESS_QUEUE_RETRY_MAX_ATTEMPTS: "1" }, encoding: "utf8", timeout: 30_000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test("Scrape cancels exact pending bodies, fences stale plans and retains sibling/destination copies", () => run(`
  const destination = join(root,"destination.md"); writeFileSync(destination,"external copy");
  await call("scrape_queue_submit",{url:"https://example.test/one",destination});
  await call("scrape_queue_submit",{url:"https://example.test/two",destination});
  const jobs = (await call("scrape_queue_list")).jobs;
  const selected = jobs.find(job=>job.url.endsWith("/one"));
  const stale = await call("scrape_queue_plan",{ids:[selected.id],action:"cancel"});
  writeFileSync(join(root,"scrape","queue",selected.file),"url: https://example.test/changed\\ndestination: "+destination+"\\n");
  await assert.rejects(call("scrape_queue_apply",apply(stale)),/changed|not found/);
  const current = (await call("scrape_queue_list")).jobs.find(job=>job.url.endsWith("/changed"));
  const plan = await call("scrape_queue_plan",{ids:[current.id],action:"cancel"});
  const request = apply(plan), receipt = await call("scrape_queue_apply",request);
  assert.equal(receipt.status,"completed");
  assert.deepEqual(await call("scrape_queue_apply",request),receipt);
  assert.deepEqual((await call("scrape_state_receipt_get",{requestId:request.requestId})).receipt,receipt);
  assert.deepEqual((await call("scrape_queue_list")).jobs.map(job=>job.id),[jobs.find(job=>job.url.endsWith("/two")).id]);
  assert.equal(readFileSync(destination,"utf8"),"external copy");
  await assert.rejects(call("scrape_queue_plan",{ids:[current.id],action:"discard"},{transport:"mcp",botId:null,instance:null,threadId:null,sessionId:null}),/operator authority/);
`));

test("native generation claims block maintenance; failed retry has a new identity and discard never deletes destinations", () => run(`
  let entered; const began = new Promise(resolve=>entered=resolve);
  let release; const wait = new Promise(resolve=>release=resolve);
  let requests = 0;
  const server = createServer(async (_req,res)=>{ requests++; entered(); await wait; res.writeHead(404); res.end("gone"); });
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  const destination = join(root,"external.md"); writeFileSync(destination,"retained destination");
  try {
    await call("scrape_queue_submit",{url:"http://127.0.0.1:"+server.address().port+"/gone.md",destination,allowPrivateNetwork:true});
    const job = (await call("scrape_queue_list")).jobs[0];
    const processing = call("scrape_queue_process"); await began;
    const blocked = await call("scrape_queue_plan",{ids:[job.id],action:"cancel"});
    assert.ok(blocked.blockedBy.some(reason=>reason.includes("pid:")&&reason.includes("token:")));
    await assert.rejects(call("scrape_queue_apply",apply(blocked)),/claim evidence/);
    release(); await processing;
    assert.equal((await call("scrape_queue_list")).jobs[0].state,"failed");
    const plan = await call("scrape_queue_plan",{ids:[job.id],action:"retry"});
    const request = apply(plan), receipt = await call("scrape_queue_apply",request);
    assert.equal(receipt.status,"completed");
    assert.deepEqual(await call("scrape_queue_apply",request),receipt);
    const retry = (await call("scrape_queue_list")).jobs[0];
    assert.equal(retry.state,"pending"); assert.notEqual(retry.id,job.id); assert.notEqual(retry.file,job.file);
    assert.equal(requests,1);
    await call("scrape_queue_process");
    const failed = (await call("scrape_queue_list")).jobs[0]; assert.equal(failed.state,"failed");
    await call("scrape_queue_apply",apply(await call("scrape_queue_plan",{ids:[failed.id],action:"discard"})));
    assert.equal((await call("scrape_queue_list")).jobs.length,0);
    assert.equal(readFileSync(destination,"utf8"),"retained destination");
  } finally { release(); server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); }
`));

test("interrupted queue admission restarts unknown, never re-extracts, and permits separately planned leftover discard", () => run(`
  const destination = join(root,"never-written.md");
  await call("scrape_queue_submit",{url:"https://example.test/one",destination});
  const job = (await call("scrape_queue_list")).jobs[0];
  const plan = await call("scrape_queue_plan",{ids:[job.id],action:"cancel"}), request = apply(plan);
  // Durable admission is the interruption boundary, not a fabricated completed receipt.
  const db = new DatabaseSync(join(root,"scrape","maintenance.sqlite"));
  const journal = new StateJournal(db,"scrape");
  db.exec("BEGIN IMMEDIATE");
  journal.begin(request,plan);
  db.prepare("INSERT INTO queue_fences VALUES(?,?,?,?)").run(job.id,sha(readFileSync(join(root,"scrape","queue",job.file))),request.requestId,"cancel");
  db.exec("COMMIT"); db.close();
  await api.prepareCloseContext(ctx); await api.closeContext(ctx); ctx = await api.createContext();
  const receipt = await call("scrape_queue_apply",request); assert.equal(receipt.status,"unknown");
  assert.deepEqual(await call("scrape_queue_apply",request),receipt);
  const listed = (await call("scrape_queue_list")).jobs[0]; assert.equal(listed.maintenanceFence.status,"unknown");
  const result = await call("scrape_queue_process"); assert.equal(result.processed,0); assert.equal(result.failed,0);
  assert.equal(existsSync(destination),false);
  assert.equal(existsSync(join(root,"scrape","queue",job.file)),true);
  const discard = await call("scrape_queue_plan",{ids:[job.id],action:"discard"});
  assert.equal((await call("scrape_queue_apply",apply(discard))).status,"completed");
  assert.equal((await call("scrape_queue_list")).jobs.length,0);
`));

test("local corpus clear binds exact final IDs, refuses stale files and symlink traversal, retaining definitions and siblings", () => run(`
  const corpus = join(root,"scrape","corpus","fixture");
  for (const id of ["sample-001","sample-002"]) { mkdirSync(join(corpus,id),{recursive:true,mode:0o700}); writeFileSync(join(corpus,id,"meta.json"),'{"version":1}'); }
  const definitions = join(root,"scrape","presets"); mkdirSync(definitions,{mode:0o700}); writeFileSync(join(definitions,"fixture.yaml"),"retained definition");
  const captures = [{preset:"fixture",id:"sample-001"}];
  const stale = await call("scrape_corpus_plan",{captures});
  writeFileSync(join(corpus,"sample-001","meta.json"),'{"version":1,"changed":true}');
  await assert.rejects(call("scrape_corpus_clear",apply(stale)),/changed/);
  const plan = await call("scrape_corpus_plan",{captures}), request = apply(plan);
  const receipt = await call("scrape_corpus_clear",request); assert.equal(receipt.status,"completed");
  assert.deepEqual(await call("scrape_corpus_clear",request),receipt);
  assert.deepEqual((await call("scrape_corpus_list",{preset:"fixture"})).captures,[{preset:"fixture",id:"sample-002"}]);
  assert.equal(readFileSync(join(definitions,"fixture.yaml"),"utf8"),"retained definition");
  const external = join(root,"external"); mkdirSync(external); writeFileSync(join(external,"body"),"external body");
  symlinkSync(external,join(root,"scrape","corpus","escape"));
  await assert.rejects(call("scrape_corpus_plan",{captures:[{preset:"escape",id:"sample-001"}]}));
  assert.equal(readFileSync(join(external,"body"),"utf8"),"external body");
`));
