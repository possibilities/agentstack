import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { serveApi,socketCall } from "@stack/api";

test("headless API starts paused, exposes revisioned defaults and validated empty attention views",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"attention-socket-"));
  const api=await serveApi({name:"signal",transport:"socket",env:{...process.env,STACK_STATE_DIR:dir}});
  const call=(name:string,args={})=>socketCall(api.socketPath!,"tools/call",{name,arguments:args}) as Promise<Record<string,unknown>>;
  try{
    const defaults=await call("attention_defaults_get");assert.equal(defaults.model,"gpt-5.6-luna");assert.equal(defaults.accountId,null);
    assert.equal((await call("attention_status")).enabled,false);
    assert.deepEqual(await call("attention_list"),{entries:[],nextCursor:0,hasMore:false});
    assert.deepEqual(await call("attention_list",{states:["open","partial"],botId:"one",order:"desc"}),{entries:[],nextCursor:0,hasMore:false});
    assert.deepEqual(await call("attention_feedback_list",{messageId:"m"}),{entries:[],nextCursor:0,hasMore:false});
    assert.deepEqual(await call("attention_changes",{excludeKinds:["source_read"],order:"desc"}),{entries:[],nextCursor:0,hasMore:false});
    assert.equal((await call("attention_status")).changeSeq,0);
    assert.equal((await call("attention_defaults_set",{reasoningEffort:"medium",expectedRevision:1})).revision,2);
    await assert.rejects(call("attention_defaults_set",{reasoningEffort:"high",expectedRevision:1}),/conflict/);
    const published=await socketCall(api.socketPath!,"tools/list") as {tools:{name:string}[]};
    assert.ok(published.tools.some(op=>op.name==="attention_trace_read"));
  }finally{await api.close();await rm(dir,{recursive:true,force:true});}
});
