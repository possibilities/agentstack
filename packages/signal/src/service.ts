import { socketCall, socketPath } from "@agentstack/api";
import { randomUUID } from "node:crypto";
import { annotation, instructions, PROMPT_VERSION, type Settings } from "./schema.js";
import { AttentionStore } from "./store.js";
import { Sources, type Call } from "./sources.js";

type Completion={requestId:string;model:string;reportedModel:string|null;text:string;usage:unknown};
const knownNoDispatch = /^(infer_busy|catalog_unavailable|model_unavailable|account_unavailable|credentials_unavailable|codex_sign_in_required|codex_access_denied|codex_rate_limited)$/;

export class AttentionService {
  readonly store:AttentionStore;
  readonly sources:Sources;
  private timer?:ReturnType<typeof setTimeout>;
  private collecting?:Promise<void>;
  private processing?:Promise<void>;
  private closing=false;
  private readonly call:Call;
  onChange?:()=>void;
  constructor(stateDir:string,env:NodeJS.ProcessEnv,call?:Call){
    this.store=new AttentionStore(stateDir);
    this.call=call??(<T>(pkg:string,name:string,args:unknown,timeout=75_000)=>socketCall(socketPath(pkg,env),"tools/call",{name,arguments:args},{timeoutMs:timeout}) as Promise<T>);
    this.sources=new Sources(this.store,this.call);
  }
  start(){this.schedule(0);}
  private schedule(delay=1000){if(!this.closing)this.timer=setTimeout(()=>{void this.tick().finally(()=>this.schedule());},delay);}
  async tick(){
    if(this.closing||!this.store.meta<boolean>("enabled"))return;
    if(!this.collecting){this.collecting=this.sources.scan().catch(error=>{this.store.event("collection_error",{error:String(error)});}).finally(()=>{this.collecting=undefined;this.onChange?.();});}
    if(!this.processing&&this.store.meta<boolean>("baselined"))this.processing=this.processOne().catch(error=>{this.store.event("processing_error",{error:String(error)});}).finally(()=>{this.processing=undefined;this.onChange?.();});
  }
  control(enabled:boolean){this.store.atomic(()=>{this.store.setMeta("enabled",enabled);if(enabled&&!this.store.meta("activatedAt"))this.store.setMeta("activatedAt",Date.now());this.store.event("processing_control",{enabled});});this.onChange?.();return this.store.status();}
  configure(update:Partial<Settings>,revision?:number){const result=this.store.configure(update,revision);this.onChange?.();return result;}
  async accounts(assigned:string|null=this.store.defaults().accountId){const {accounts}=await this.call<{accounts:{id:string;enabled:boolean;removing:boolean}[]}>("auth","account_list",{});
    return accounts.filter(row=>row.enabled&&!row.removing&&(!assigned||row.id===assigned));}
  async models(){
    let lastError="no_available_codex_account";
    const assigned=this.store.defaults().accountId;
    for(const account of await this.accounts(assigned))try{return {accountId:account.id,...await this.call<{models:unknown[];observedAt:string}>("infer","infer_models",{accountId:account.id})};}
      catch(error){lastError=error instanceof Error?error.message:String(error);if(assigned)throw error;}
    throw new Error(lastError);
  }
  async processOne(){
    const job=this.store.next();if(!job)return;
    const message=this.store.message(job.messageId),settings=this.store.defaults();
    let accounts:Awaited<ReturnType<AttentionService["accounts"]>>;
    try{accounts=await this.accounts(settings.accountId);}catch(error){this.store.setMeta("lastInference",{at:Date.now(),error:String(error)});return;}
    if(!accounts.length){this.store.setMeta("lastInference",{at:Date.now(),error:"no_available_codex_account"});this.store.jobState(job.id,"pending",10_000);return;}
    const frozen=this.store.meta<{runId:string;inputBlob:string}>(`frozen:${job.id}`);
    const context=frozen?JSON.parse(this.store.text(frozen.inputBlob)).context as ReturnType<AttentionStore["context"]>:this.store.context(message);
    const input=frozen?this.store.text(frozen.inputBlob):JSON.stringify({schemaVersion:1,target:{id:message.id,conversation:message.conversation,role:message.role,authorKind:message.authorKind,defaultAudience:message.audienceHint??"unknown",complete:message.complete,
      segment:{start:job.start,end:job.end,totalChars:message.text.length},text:message.text.slice(job.start,job.end)},context});
    if(input.length>128_000)throw new Error("attention_context_exceeds_budget");
    const runId=this.store.startRun(job,{schemaVersion:1,promptVersion:PROMPT_VERSION,requestId:job.requestId,settings,
      inputBlob:this.store.blob(input),instructionsBlob:this.store.blob(instructions),contextPolicy:"recent-8-open-24-v1",messageId:message.id,replay:job.replay,replayOf:frozen?.runId??null,
      queueMs:Date.now()-message.observedAt,accountCandidates:accounts.map(account=>account.id),cost:{usd:null,status:"unavailable",basis:"Codex subscription"}});
    let result:Completion|undefined;
    try{
      // Account fallthrough is allowed only for an unassigned account and a definite refusal. Never repeat an uncertain dispatch.
      for(const [index,account] of accounts.entries()){
        const requestId=index===0?job.requestId:randomUUID();
        this.store.event("inference_selected",{runId,requestId,accountId:account.id,settings});
        try{
          result=await this.call<Completion>("infer","infer_complete",{accountId:account.id,model:settings.model,effort:settings.reasoningEffort,instructions,input,maxOutputTokens:8192,requestId});
          break;
        }catch(error){
          const code=error instanceof Error?error.message:String(error);
          this.store.event("inference_attempt_failed",{runId,requestId,accountId:account.id,error:code});
          if(settings.accountId||!knownNoDispatch.test(code)||index===accounts.length-1)throw error;
        }
      }
      if(!result)throw new Error("inference_missing_result");
      const responseBlob=this.store.blob(JSON.stringify(result));
      // Save the response before parsing: malformed model output remains exportable evidence.
      const run=this.store.run(runId);
      this.store.db.prepare("UPDATE runs SET body=? WHERE id=?").run(JSON.stringify({...run.body,responseBlob,requestId:result.requestId,usage:result.usage,reportedModel:result.reportedModel}),runId);
      const parsed=annotation.parse(JSON.parse(result.text));
      this.store.apply(runId,job,message,parsed,context);
      this.store.setMeta("lastInference",{at:Date.now(),runId,requestId:result.requestId,state:"completed",model:result.model,reportedModel:result.reportedModel});
    }catch(error){
      const code=error instanceof Error?error.message:String(error);
      const unknown=!result&&!knownNoDispatch.test(code)&&!/^infer_output_budget_exceeded:/.test(code)&&!/^(infer_http_error:4\d\d)$/.test(code);
      const state=unknown?"unknown":"failed";
      this.store.finishRun(runId,state,{error:code});
      this.store.jobState(job.id,state);
      if(knownNoDispatch.test(code)){
        // A fresh job/dispatch identity records the retry separately; current refusal cannot have executed inference.
        this.store.retry(job.id,30_000);
      }
      this.store.setMeta("lastInference",{at:Date.now(),runId,state,error:code});
    }
  }
  async close(){this.closing=true;if(this.timer)clearTimeout(this.timer);await Promise.allSettled([this.collecting,this.processing]);this.store.close();}
}
