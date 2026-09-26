import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { AttentionStore } from "../src/store.js";
import { AttentionService } from "../src/service.js";
import { Sources, type Call } from "../src/sources.js";
import { annotation, instructions, messagePageSchema, eventPageSchema, type Annotation, type SourceMessage } from "../src/schema.js";

const account="123e4567-e89b-42d3-a456-426614174000";
const source=(text:string,key:string=randomUUID()):SourceMessage=>({source:"bots",conversation:"bot:one:root",key,role:"assistant",authorKind:"agent",botId:"one",text,complete:true,occurredAt:"2000-01-01T00:00:00Z",evidence:{line:2}});
const request=(text="Please approve shipping."):Annotation=>annotation.parse({summary:"Approval requested",items:[{
  acts:["request"],forms:[],summary:"Approve shipping",evidence:{quote:text,occurrence:0},subject:"Shipping",scope:null,
  audience:{kind:"human",id:null},engagement:["authorize"],attention:{reason:"response",rationale:"Explicit approval requested",basis:"explicit"},
  timing:{urgency:"unspecified",deadline:null,blockingScope:"shipping"},conditions:[],uncertainty:[],state:"open",relations:[],
}],stateChanges:[],uncertainties:[]});
async function fixture(){const dir=await mkdtemp(join(tmpdir(),"attention-test-"));return {dir,clean:()=>rm(dir,{recursive:true,force:true})};}
const completion=(text:string,requestId:string)=>({requestId,model:"gpt-5.6-luna",reportedModel:"gpt-5.6-luna",text,usage:{inputTokens:100,outputTokens:50}});

test("defaults are Luna/low with nullable account assignment and revision fencing",async()=>{
  const f=await fixture();const store=new AttentionStore(f.dir);
  try{assert.deepEqual(store.defaults(),{model:"gpt-5.6-luna",reasoningEffort:"low",accountId:null,revision:1});
    store.configure({accountId:account},1);assert.throws(()=>store.configure({model:"other"},1),/conflict/);
    assert.equal(store.configure({accountId:null},2).accountId,null);
    assert.ok(instructions.length<32_000);
  }finally{store.close();await f.clean();}
});

test("message revisions deduplicate, preserve full text and supersede queued draft interpretations",async()=>{
  const f=await fixture();const store=new AttentionStore(f.dir);
  try{
    const first=store.admit({...source("Working","item"),complete:false});
    assert.equal(store.admit({...source("Working","item"),complete:false}).id,first.id);
    const final=store.admit(source("Working done","item"));
    messagePageSchema.parse(store.page("messages",0,25));eventPageSchema.parse(store.page("events",0,25));
    assert.notEqual(final.id,first.id);assert.equal(store.message(first.id).current,false);
    assert.equal(store.next()!.messageId,final.id);
    const long=store.admit(source("a".repeat(11999)+"😀"+"z".repeat(13000)));
    const jobs=store.db.prepare("SELECT start,end FROM jobs WHERE message_id=? ORDER BY start").all(long.id);
    assert.equal(jobs.map(row=>long.text.slice(Number(row.start),Number(row.end))).join(""),long.text);
    for(const row of jobs)assert.ok(!/[\uD800-\uDBFF]$/.test(long.text.slice(Number(row.start),Number(row.end))));
  }finally{store.close();await f.clean();}
});

test("quoted evidence, known references and resolution are validated atomically",async()=>{
  const f=await fixture();const store=new AttentionStore(f.dir);
  try{
    const message=store.admit(source("Please approve shipping."));const job=store.next()!,context=store.context(message);
    const run=store.startRun(job,{});store.apply(run,job,message,request(),context);
    const item=JSON.parse(String(store.db.prepare("SELECT body FROM items").get()!.body));
    assert.equal(item.start,0);assert.equal(item.end,message.text.length);
    const answer=store.admit({...source("Approved"),role:"user",authorKind:"human"});const next=store.next()!,ctx=store.context(answer);
    const reply:Annotation={summary:"Approved",items:[],stateChanges:[{targetId:item.id,state:"satisfied",quote:"Approved",rationale:"Explicit answer"}],uncertainties:[]};
    const nextRun=store.startRun(next,{});
    assert.throws(()=>store.apply(nextRun,next,answer,{...reply,stateChanges:[{...reply.stateChanges[0]!,quote:"never said"}]},ctx),/evidence/);
    assert.equal(store.db.prepare("SELECT state FROM items WHERE id=?").get(item.id)!.state,"open");
    store.apply(nextRun,next,answer,reply,ctx);
    assert.equal(store.db.prepare("SELECT state FROM items WHERE id=?").get(item.id)!.state,"satisfied");
    store.reconcile(message.conversation,[message.id]);
    assert.equal(store.db.prepare("SELECT state FROM items WHERE id=?").get(item.id)!.state,"open","a reverted answer retracts its resolution evidence");
  }finally{store.close();await f.clean();}
});

test("frozen replay excludes later conversation and never overwrites live attention",async()=>{
  const f=await fixture();const seen:string[]=[];
  const call:Call=async<T>(_pkg:string,name:string,args:unknown)=>{
    if(name==="account_list")return {accounts:[{id:account,enabled:true,removing:false}]} as T;
    const input=args as {input:string;requestId:string};seen.push(input.input);
    return completion(JSON.stringify(request()),input.requestId) as T;
  };
  const service=new AttentionService(f.dir,{},call);
  try{
    service.store.admit(source("Please approve shipping."));await service.processOne();
    const run=service.store.db.prepare("SELECT id FROM runs").get()!.id as string;
    service.store.admit(source("LATER SECRET CONTEXT"));
    service.store.db.prepare("UPDATE jobs SET state='held' WHERE state='pending'").run();
    const key=randomUUID();assert.deepEqual(service.store.replay(run,key),service.store.replay(run,key));
    await service.processOne();assert.equal(seen[0],seen[1]);assert.ok(!seen[1]!.includes("LATER SECRET"));
    assert.equal(service.store.db.prepare("SELECT COUNT(*) AS n FROM items WHERE current=1").get()!.n,1);
    const exported=service.store.exportRun(run);assert.equal(Object.keys(exported.blobs).length,3);
  }finally{await service.close();await f.clean();}
});

test("unknown inference is retained without automatic retry and malformed JSON keeps its raw output",async()=>{
  const f=await fixture();let mode="unknown",calls=0;
  const call:Call=async<T>(_pkg:string,name:string,args:unknown)=>{
    if(name==="account_list")return {accounts:[{id:account,enabled:true,removing:false}]} as T;
    calls++;if(mode==="unknown")throw new Error("infer_outcome_unknown:lost");
    return completion("not json",(args as {requestId:string}).requestId) as T;
  };
  const service=new AttentionService(f.dir,{},call);
  try{
    service.store.admit(source("Please approve shipping."));await service.processOne();await service.processOne();assert.equal(calls,1);
    assert.equal(service.store.db.prepare("SELECT state FROM jobs").get()!.state,"unknown");
    mode="malformed";service.store.admit(source("Another request"));await service.processOne();
    const run=service.store.db.prepare("SELECT id FROM runs ORDER BY rowid DESC LIMIT 1").get()!.id as string;
    const exported=service.store.exportRun(run);assert.ok(Object.values(exported.blobs).some(text=>text.includes("not json")));
    assert.equal(exported.run.state,"failed");
  }finally{await service.close();await f.clean();}
});

test("account fallback occurs only after definite refusal and explicit assignments never fall through",async()=>{
  const f=await fixture();const second=randomUUID(),attempts:string[]=[];
  const call:Call=async<T>(_pkg:string,name:string,args:unknown)=>{
    if(name==="account_list")return {accounts:[account,second].map(id=>({id,enabled:true,removing:false}))} as T;
    const input=args as {accountId:string;requestId:string};attempts.push(input.accountId);
    if(input.accountId===account)throw new Error("credentials_unavailable");
    return completion(JSON.stringify(request()),input.requestId) as T;
  };
  const service=new AttentionService(f.dir,{},call);
  try{
    service.store.admit(source("Please approve shipping."));await service.processOne();assert.deepEqual(attempts,[account,second]);
    attempts.length=0;service.configure({accountId:account});service.store.admit(source("Please approve shipping."));await service.processOne();assert.deepEqual(attempts,[account]);
  }finally{await service.close();await f.clean();}
});

test("forward observation baselines existing data then accepts late historical appearance and survives restart",async()=>{
  const f=await fixture();let chats=["old"],lines:{[id:string]:string[]}={old:["preexisting"]};
  const call:Call=async<T>(_pkg:string,name:string,args:unknown)=>{
    if(name==="bot_list")return {bots:[{id:"one",mainThreadId:"old"}]} as T;
    if(name==="chat_list")return {chats:chats.map(threadId=>({threadId,parentThreadId:null}))} as T;
    if(name==="worker_list")return {workers:[]} as T;
    const input=args as {threadId:string;cursor?:{line:number};headOnly:boolean};const texts=lines[input.threadId]!;
    const after=input.headOnly?texts.length:input.cursor?.line??0;
    return {cursor:{sourceId:input.threadId,line:texts.length,prefixHash:"fixture"},reset:false,hasMore:false,
      entries:texts.slice(after).map((text,index)=>({key:`line:${after+index}`,revision:"fixture",line:after+index,role:"assistant",text,textChars:text.length,timestamp:"1990-01-01T00:00:00Z",phase:"final"}))} as T;
  };
  let store=new AttentionStore(f.dir);
  try{
    await new Sources(store,call).scan();assert.equal(store.status().messages,0);
    chats.push("late-import");lines["late-import"]=["Historical but newly visible"];
    lines.old!.push("A new message");await new Sources(store,call).scan();assert.equal(store.status().messages,2);
    const observed=store.message(String(store.db.prepare("SELECT id FROM messages LIMIT 1").get()!.id));assert.equal(observed.audienceHint,"human");
    store.close();store=new AttentionStore(f.dir);await new Sources(store,call).scan();assert.equal(store.status().messages,2);
    lines.old!.push("While stopped");await new Sources(store,call).scan();assert.equal(store.status().messages,3);
  }finally{store.close();await f.clean();}
});

test("Worker chunks form revisioned text units, tool text stays out, origin is agent rather than human",async()=>{
  const f=await fixture();let entries:{seq:number;turnId:string;kind:string;text:string;at:number}[]=[];
  const call:Call=async<T>(_pkg:string,name:string,args:unknown)=>{
    if(name==="bot_list")return {bots:[]} as T;
    if(name==="worker_list")return {workers:[{id:"w",botId:"one",threadId:"root",phase:"running",currentTurnId:"t"}]} as T;
    const after=(args as {afterSeq:number}).afterSeq;
    return {entries:entries.filter(row=>row.seq>after),nextSeq:entries.at(-1)?.seq??after,hasMore:false} as T;
  };
  const store=new AttentionStore(f.dir);
  try{
    await new Sources(store,call).scan();
    entries=[{seq:1,turnId:"t",kind:"user",text:"Do work",at:1},{seq:2,turnId:"t",kind:"agent",text:"Hello ",at:2},{seq:3,turnId:"t",kind:"agent",text:"world",at:3},{seq:4,turnId:"t",kind:"tool",text:"SECRET TOOL OUTPUT",at:4}];
    await new Sources(store,call).scan();
    const messages=store.db.prepare("SELECT id FROM messages WHERE current=1 ORDER BY seq").all().map(row=>store.message(String(row.id)));
    assert.deepEqual(messages.map(row=>row.text),["Do work","Hello world"]);assert.ok(messages.every(row=>row.authorKind==="agent"));
    await new Sources(store,call).scan();assert.equal(store.status().messages,2);
  }finally{store.close();await f.clean();}
});
