import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { InferTraces } from "../src/traces.js";
import { InferService } from "../src/service.js";

test("durable inference replay returns the recorded completion without dispatch; trace retains partial output without credentials",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"infer-traces-"));let calls=0;
  const traces=new InferTraces(dir);
  const model={id:"gpt-6-luna",defaultEffort:"low" as const,supportedEfforts:["low" as const]};
  const input={accountId:randomUUID(),model:model.id,effort:"low" as const,instructions:"classify",input:"text",maxOutputTokens:8192,requestId:randomUUID()};
  const fetcher=(async()=>{calls++;return new Response('data: {"type":"response.output_text.delta","delta":"hello"}\n\ndata: {"type":"response.completed","response":{"status":"completed","model":"actual-model","usage":{"input_tokens":3}}}\n\n');}) as typeof fetch;
  const service=new InferService(dir,async()=>[model],fetcher,async()=>({access:"private-secret",nativeId:"native-account",auth:"private-auth"}),traces);
  try{
    const first=await service.complete(input);assert.equal(first.reportedModel,"actual-model");
    assert.deepEqual(await service.complete(input),first);assert.equal(calls,1);
    await assert.rejects(service.complete({...input,input:"different"}),/conflict/);
    const trace=traces.read(input.requestId,0,100_000);assert.ok(trace.text.includes("hello"));assert.ok(trace.text.includes("post_response"));assert.ok(!trace.text.includes("private-secret"));
    const interrupted={...input,requestId:randomUUID()};traces.reserve(interrupted.requestId,interrupted);traces.close();
    const reopened=new InferTraces(dir);try{assert.throws(()=>reopened.reserve(interrupted.requestId,interrupted),/outcome_unknown/);}finally{reopened.close();}
  }finally{try{traces.close();}catch{}await rm(dir,{recursive:true,force:true});}
});

test("HTTP rejection diagnostics and over-threshold completions remain traceable",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"infer-failures-"));const traces=new InferTraces(dir);
  const model={id:"gpt-5.6-luna",defaultEffort:"low" as const,supportedEfforts:["low" as const]};
  const input={accountId:randomUUID(),model:model.id,effort:"low" as const,instructions:"classify",input:"text",maxOutputTokens:1,requestId:randomUUID()};
  const credentials=async()=>({access:"credential-secret",nativeId:"native",auth:"private-auth"});
  try{
    const rejected=new InferService(dir,async()=>[model],(async()=>new Response('{"detail":"unsupported field credential-secret"}',{status:400})) as typeof fetch,credentials,traces);
    await assert.rejects(rejected.complete(input),/infer_http_error:400/);
    const failure=traces.read(input.requestId,0,100_000).text;assert.ok(failure.includes("unsupported field"));assert.ok(!failure.includes("credential-secret"));
    const next={...input,requestId:randomUUID()};
    const over=new InferService(dir,async()=>[model],(async()=>new Response('data: {"type":"response.output_text.delta","delta":"long answer"}\n\ndata: {"type":"response.completed","response":{"status":"completed","usage":{"output_tokens":10}}}\n\n')) as typeof fetch,credentials,traces);
    await assert.rejects(over.complete(next),/infer_output_budget_exceeded/);
    const trace=traces.read(next.requestId,0,100_000).text;assert.ok(trace.includes("long answer"));assert.ok(trace.includes('"exceeded":true'));
  }finally{traces.close();await rm(dir,{recursive:true,force:true});}
});
