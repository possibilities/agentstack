import assert from "node:assert/strict";
import test from "node:test";
import { pageMessages } from "../src/chat-messages.js";
const line=(value:unknown)=>JSON.stringify(value)+"\n";
const meta=(start=0)=>line({type:"session_meta",payload:{subagent_history_start_ordinal:start}});
const message=(text:string,ordinal:number,role="assistant")=>line({type:"response_item",timestamp:"1999-01-01",ordinal,payload:{type:"message",role,content:[{type:"output_text",text}]}});

test("baseline skips existing text; new old-dated messages and imported sources are admitted",()=>{
  const old=meta()+message("Old",1);const head=pageMessages(old,"source",undefined,true,25);
  assert.equal(head.entries.length,0);
  const next=pageMessages(old+message("New appearance",2),"source",head.cursor,false,25);
  assert.equal(next.entries[0]!.text,"New appearance");
  const imported=pageMessages(meta()+message("Imported",1),"new-source",head.cursor,false,25);
  assert.equal(imported.reset,true);assert.equal(imported.entries[0]!.text,"Imported");
});
test("rewritten prefix resets; incomplete writes, inherited history, tools and reasoning are excluded",()=>{
  const first=meta()+message("Original",1);const head=pageMessages(first,"source",undefined,true,25);
  const rewritten=pageMessages(meta()+message("Revised!",1),"source",head.cursor,false,25);
  assert.equal(rewritten.reset,true);
  const body=meta(4)+message("Inherited",1)+line({type:"response_item",ordinal:4,payload:{type:"function_call",arguments:"tool"}})
    +line({type:"response_item",ordinal:5,payload:{type:"message",role:"assistant",channel:"analysis",content:[{type:"output_text",text:"reasoning"}]}})
     +message("[Stack orientation 11111111-1111-4111-8111-111111111111]\n\nThis is a one-time initialization request from Stack, not a message or authorization from the human.\nIntroduce yourself.",6,"user")
     +message("Own message",7)+message("Partial",8).slice(0,-1);
  const page=pageMessages(body,"source",undefined,false,25);
  assert.deepEqual(page.entries.map(row=>row.text),["Own message"]);
  assert.equal(pageMessages(body+"\n","source",page.cursor,false,25).entries[0]!.text,"Partial");
});
