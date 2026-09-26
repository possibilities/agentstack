import { AttentionStore, digest } from "./store.js";
import type { SourceMessage } from "./schema.js";

export type Call = <T>(pkg:string,name:string,args:unknown,timeout?:number)=>Promise<T>;
type Cursor={sourceId:string;line:number;prefixHash:string};
type ChatEntry={key:string;revision:string;line:number;role:"user"|"assistant";text:string|null;textChars:number;timestamp:string|null;phase:string|null};
type ChatPage={cursor:Cursor;reset:boolean;hasMore:boolean;entries:ChatEntry[]};
type Worker={id:string;botId:string;threadId:string;phase:string;currentTurnId:string|null};
type TextEntry={seq:number;turnId:string;kind:string;text:string;at:number};
type Buffer={turnId:string;kind:"user"|"agent";firstSeq:number;lastSeq:number;text:string;at:number;sourceReadSeqs?:number[]};
type WorkerCursor={seq:number;buffer:Buffer|null};

/** Observe durable appearance, never compare a message's authored timestamp to activation. */
export class Sources {
  private readonly call:Call;
  private lastReadSeq=0;
  constructor(private store:AttentionStore,call:Call){
    this.call=async<T>(pkg:string,name:string,args:unknown,timeout?:number)=>{
      const startedAt=Date.now(),inputBlob=store.blob(JSON.stringify({package:pkg,operation:name,arguments:args}));
      try{
        const result=await call<T>(pkg,name,args,timeout);
        this.lastReadSeq=store.event("source_read",{package:pkg,operation:name,startedAt,finishedAt:Date.now(),inputBlob,outputBlob:store.blob(JSON.stringify(result))});
        return result;
      }catch(error){store.event("source_read_failed",{package:pkg,operation:name,startedAt,finishedAt:Date.now(),inputBlob,error:String(error)});throw error;}
    };
  }
  async scan(){
    const errors:{source:string;error:string}[]=[];
    const guard=async(source:string,fn:()=>Promise<void>)=>{try{await fn();}catch(error){errors.push({source,error:error instanceof Error?error.message:String(error)});}};
    await guard("bots",async()=>{
      const {bots}=await this.call<{bots:{id:string;mainThreadId:string|null}[]}>("bots","bot_list",{});
      for(const bot of bots)await guard(`bot:${bot.id}`,async()=>{
        const chats:{threadId:string;parentThreadId:string|null}[]=[];
        for(let offset=0;;){const page=await this.call<{chats:typeof chats}>("bots","chat_list",{botId:bot.id,offset,limit:100},30_000);chats.push(...page.chats);if(page.chats.length<100)break;offset+=page.chats.length;}
        const baselineKey=`baseline:bot:${bot.id}`;
        if(!this.store.meta<boolean>("baselined")&&!this.store.meta(baselineKey))this.store.setMeta(baselineKey,chats.map(row=>row.threadId));
        const baseline=this.store.meta<string[]>(baselineKey)??[];
        for(const chat of chats)await guard(`chat:${bot.id}:${chat.threadId}`,()=>this.chat(bot.id,chat.threadId,chat.parentThreadId,baseline.includes(chat.threadId)));
      });
    });
    await guard("workers",async()=>{
      const {workers}=await this.call<{workers:Worker[]}>("workers","worker_list",{});
      if(!this.store.meta<boolean>("baselined")&&!this.store.meta("baseline:workers"))this.store.setMeta("baseline:workers",workers.map(row=>row.id));
      const baseline=this.store.meta<string[]>("baseline:workers")??[];
      for(const worker of workers)await guard(`worker:${worker.id}`,()=>this.worker(worker,baseline.includes(worker.id)));
    });
    this.store.setMeta("sourceErrors",errors);this.store.setMeta("lastScan",Date.now());
    if(!errors.length&&!this.store.meta<boolean>("baselined")){this.store.setMeta("baselined",true);this.store.event("baseline_established",{at:Date.now()});}
  }
  private async chat(botId:string,threadId:string,parentThreadId:string|null,baseline:boolean){
    const conversation=`bot:${botId}:${threadId}`,key=`cursor:${conversation}`;
    let cursor=this.store.meta<Cursor>(key)??undefined;
    for(let pageNumber=0;pageNumber<100;pageNumber++){
      const page=await this.call<ChatPage>("bots","chat_message_changes",{botId,threadId,cursor,headOnly:baseline&&!cursor,limit:25},30_000);
      const sourceReadSeq=this.lastReadSeq;
      const messages:SourceMessage[]=[];
      for(const entry of page.entries){
        let text=entry.text;
        let raw:string|null=null;
        if(text===null){
          raw="";let offset=0;
          do{const chunk=await this.call<{text:string;nextOffset:number|null}>("bots","chat_record_chunk",{botId,threadId,line:entry.line,offset,length:16_000});raw+=chunk.text;if(chunk.nextOffset===null)break;offset=chunk.nextOffset;}while(true);
          const record=JSON.parse(raw);
          text=Array.isArray(record.payload?.content)?record.payload.content.filter((p:{type:string;text:unknown})=>["input_text","output_text","text"].includes(p.type)&&typeof p.text==="string").map((p:{text:string})=>p.text).join("\n"):"";
          if(digest(text)!==entry.revision)throw new Error("chat changed while reading large message");
        }
        messages.push({source:"bots",conversation,key:entry.key,role:entry.role,authorKind:entry.role==="assistant"?"agent":parentThreadId?"unknown":"human",
          audienceHint:entry.role==="assistant"&&!parentThreadId?"human":"agent",botId,text:text!,complete:true,occurredAt:entry.timestamp,
          evidence:{botId,threadId,parentThreadId,line:entry.line,sourceId:page.cursor.sourceId,phase:entry.phase,sourceReadSeq,rawBlob:raw===null?null:this.store.blob(raw),coverage:"durable_rollout_text"}});
      }
      this.store.atomic(()=>{
        const reconcileKey=`reconcile:${conversation}`;
        let seen=page.reset?[]:this.store.meta<string[]>(reconcileKey);
        for(const message of messages){const admitted=this.store.admit(message);seen?.push(admitted.id);}
        if(seen){if(!page.hasMore){this.store.reconcile(conversation,seen);this.store.setMeta(reconcileKey,null);}else this.store.setMeta(reconcileKey,seen);}
        this.store.setMeta(key,page.cursor);if(page.reset)this.store.event("source_reset",{conversation,previous:cursor,next:page.cursor});
      });
      cursor=page.cursor;if(!page.hasMore)break;
    }
  }
  private async worker(worker:Worker,baseline:boolean){
    const key=`cursor:worker:${worker.id}`;
    let cursor=this.store.meta<WorkerCursor>(key)??{seq:0,buffer:null};
    const skip=baseline&&!this.store.meta(key);
    const emit=(buffer:Buffer,complete:boolean)=>this.store.admit({source:"workers",conversation:`worker:${worker.id}`,key:`${buffer.turnId}:${buffer.kind}:${buffer.firstSeq}`,
      role:buffer.kind==="user"?"user":"assistant",authorKind:buffer.kind==="agent"||worker.botId!=="_local_operator"?"agent":"human",
      audienceHint:buffer.kind==="agent"&&worker.botId==="_local_operator"?"human":"agent",
      botId:worker.botId==="_local_operator"?null:worker.botId,text:buffer.text,complete,occurredAt:new Date(buffer.at).toISOString(),
      evidence:{workerId:worker.id,originThreadId:worker.threadId,turnId:buffer.turnId,firstSeq:buffer.firstSeq,lastSeq:buffer.lastSeq,sourceReadSeqs:buffer.sourceReadSeqs??[],completionReadSeq:this.lastReadSeq,boundary:"contiguous_transcript_text",coverage:"owned_worker_transcript; native child conversations not enumerated"}});
    for(let pageNumber=0;pageNumber<1000;pageNumber++){
      const page=await this.call<{entries:TextEntry[];nextSeq:number;hasMore:boolean}>("workers","worker_read",{id:worker.id,afterSeq:cursor.seq,limit:50});
      this.store.atomic(()=>{
        for(const entry of page.entries){
          if(skip)continue;
          const textual=entry.kind==="user"||entry.kind==="agent";
          if(cursor.buffer&&(!textual||cursor.buffer.kind!==entry.kind||cursor.buffer.turnId!==entry.turnId)){
            emit(cursor.buffer,true);cursor.buffer=null;
          }
          if(textual){
            if(!cursor.buffer)cursor.buffer={turnId:entry.turnId,kind:entry.kind as "user"|"agent",firstSeq:entry.seq,lastSeq:entry.seq,text:"",at:entry.at};
            cursor.buffer.text+=entry.text;cursor.buffer.lastSeq=entry.seq;
            cursor.buffer.sourceReadSeqs??=[];
            if(cursor.buffer.sourceReadSeqs.at(-1)!==this.lastReadSeq)cursor.buffer.sourceReadSeqs.push(this.lastReadSeq);
          }
          if(entry.kind==="notice")this.store.event("source_coverage",{workerId:worker.id,seq:entry.seq,text:entry.text});
        }
        cursor.seq=page.nextSeq;
        if(!page.hasMore&&cursor.buffer){
          const complete=cursor.buffer.kind==="user"||cursor.buffer.turnId!==worker.currentTurnId||!["running","cancelling"].includes(worker.phase);
          emit(cursor.buffer,complete);
          // Preserve user buffers until a boundary, since very long prompts span multiple entries.
          if(complete&&cursor.buffer.kind==="agent")cursor.buffer=null;
        }
        this.store.setMeta(key,cursor);
      });
      if(!page.hasMore)break;
    }
  }
}
