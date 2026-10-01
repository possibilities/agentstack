import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { StateJournal, type StateApplyInput } from "@stack/api";
import { DEFAULTS, settings, type SourceMessage, type Settings, type Annotation } from "./schema.js";
import type { SourceHead } from "./sources.js";

export const digest = (value: unknown) => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
export type Message = SourceMessage & { id:string; logicalId:string; revision:string; observedAt:number; seq:number; current:boolean };
export type Job = { id:string; messageId:string; start:number; end:number; state:string; replay:boolean; requestId:string; availableAt:number };
/** List filters; each applies only to the record kinds that carry it. */
export type PageFilters = { conversation?:string; botId?:string; messageId?:string; runId?:string; state?:string; states?:string[]; audience?:string; reason?:string; kinds?:string[]; excludeKinds?:string[] };
/** Source polling records every read; these kinds never change attention records. */
export const readKinds = ["source_read","source_read_failed"];
export type Item = Annotation["items"][number] & { id:string; messageId:string; runId:string; conversation:string; botId:string|null; start:number; end:number; current:boolean };

export class AttentionStore {
  readonly db:DatabaseSync;
  readonly maintenance: StateJournal;
  constructor(stateDir:string) {
    const dir=join(stateDir,"attention"); mkdirSync(dir,{recursive:true,mode:0o700});
    const path=join(dir,"attention.sqlite"); this.db=new DatabaseSync(path); chmodSync(path,0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS blobs(hash TEXT PRIMARY KEY,text TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS messages(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,logical_id TEXT NOT NULL,revision TEXT NOT NULL,conversation TEXT NOT NULL,bot_id TEXT,current INTEGER NOT NULL,at INTEGER NOT NULL,body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS message_logical ON messages(logical_id,current);
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,message_id TEXT NOT NULL,start INTEGER NOT NULL,end INTEGER NOT NULL,state TEXT NOT NULL,replay INTEGER NOT NULL,request_id TEXT NOT NULL,available_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,job_id TEXT NOT NULL,at INTEGER NOT NULL,finished INTEGER,state TEXT NOT NULL,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS items(id TEXT PRIMARY KEY,message_id TEXT NOT NULL,run_id TEXT NOT NULL,conversation TEXT NOT NULL,bot_id TEXT,current INTEGER NOT NULL,state TEXT NOT NULL,reason TEXT NOT NULL,audience TEXT NOT NULL,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT,at INTEGER NOT NULL,kind TEXT NOT NULL,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS feedback(id TEXT PRIMARY KEY,at INTEGER NOT NULL,body TEXT NOT NULL);
      UPDATE jobs SET state='unknown' WHERE state='running';
      UPDATE runs SET state='unknown',finished=${Date.now()} WHERE state='running';`);
    if (!this.meta("settings")) this.setMeta("settings",{...DEFAULTS,revision:1});
    // Stores that predate the counter derive it once from their event history.
    if (this.meta("changeSeq")===null) this.setMeta("changeSeq",Number(this.db.prepare(`SELECT COALESCE(MAX(seq),0) AS n FROM events WHERE kind NOT IN (${readKinds.map(()=>"?").join(",")})`).get(...readKinds)!.n));
    if(!(this.db.prepare("PRAGMA table_info(items)").all() as {name:string}[]).some(row=>row.name==="initial_state")){
      this.db.exec("ALTER TABLE items ADD COLUMN initial_state TEXT; UPDATE items SET initial_state=state;");
    }
    this.db.exec("CREATE TABLE IF NOT EXISTS cleared_messages(id TEXT PRIMARY KEY); CREATE TABLE IF NOT EXISTS cleared_feedback(id TEXT PRIMARY KEY,digest TEXT NOT NULL)");
    this.maintenance = new StateJournal(this.db, "signal");
  }
  close(){this.db.close();}
  atomic<T>(fn:()=>T):T { this.db.exec("SAVEPOINT attention_write"); try {const out=fn();this.db.exec("RELEASE attention_write");return out;}
    catch(error){this.db.exec("ROLLBACK TO attention_write; RELEASE attention_write");throw error;} }
  meta<T=unknown>(key:string):T|null {const row=this.db.prepare("SELECT value FROM meta WHERE key=?").get(key) as {value:string}|undefined;return row?JSON.parse(row.value):null;}
  setMeta(key:string,value:unknown){this.db.prepare("INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key,JSON.stringify(value));}
  defaults():Settings & {revision:number}{return this.meta("settings")!;}
  configure(update:Partial<Settings>,expectedRevision?:number){
    const prior=this.defaults();if(expectedRevision!==undefined && prior.revision!==expectedRevision)throw new Error("attention_settings_conflict");
    const next={...settings.parse({...DEFAULTS,...Object.fromEntries(Object.entries(prior).filter(([key])=>key!=="revision")),...update}),revision:prior.revision+1};
    this.atomic(()=>{this.setMeta("settings",next);this.event("settings_changed",next);});return next;
  }
  blob(text:string){const hash=digest(text);this.db.prepare("INSERT OR IGNORE INTO blobs VALUES(?,?)").run(hash,text);return hash;}
  text(hash:string){const row=this.db.prepare("SELECT text FROM blobs WHERE hash=?").get(hash) as {text:string}|undefined;if(!row)throw new Error("unknown attention blob");return row.text;}
  event(kind:string,body:unknown){const seq=Number(this.db.prepare("INSERT INTO events(at,kind,body) VALUES(?,?,?)").run(Date.now(),kind,JSON.stringify(body)).lastInsertRowid);
    if(!readKinds.includes(kind))this.setMeta("changeSeq",seq);return seq;}
  admit(source:SourceMessage):Message {
    const logicalId=digest([source.source,source.conversation,source.key]);
    const revision=digest([source.text,source.complete]),id=digest([logicalId,revision]);
    const prior=this.db.prepare("SELECT id FROM messages WHERE id=?").get(id);
    if(prior){
      if (this.db.prepare("SELECT 1 FROM cleared_messages WHERE id=?").get(id)) return this.message(id);
      if(!this.message(id).current)this.atomic(()=>{
        this.retire(this.db.prepare("SELECT id FROM messages WHERE logical_id=? AND current=1").all(logicalId).map(row=>String(row.id)));
        this.db.prepare("UPDATE messages SET current=1 WHERE id=?").run(id);
        this.db.prepare("UPDATE items SET current=1 WHERE message_id=? AND run_id IN (SELECT runs.id FROM runs JOIN jobs ON jobs.id=runs.job_id WHERE jobs.replay=0)").run(id);
        this.rebuildStates();this.event("message_restored",{id});
      });
      return this.message(id);
    }
    const replacing=Boolean(this.db.prepare("SELECT 1 FROM messages WHERE logical_id=? AND current=1").get(logicalId));
    return this.atomic(()=>{
      this.db.prepare("UPDATE items SET current=0 WHERE message_id IN (SELECT id FROM messages WHERE logical_id=?)").run(logicalId);
      this.db.prepare("UPDATE jobs SET state='superseded' WHERE state='pending' AND replay=0 AND message_id IN (SELECT id FROM messages WHERE logical_id=?)").run(logicalId);
      this.db.prepare("UPDATE messages SET current=0 WHERE logical_id=?").run(logicalId);
      const at=Date.now();this.db.prepare("INSERT INTO messages(id,logical_id,revision,conversation,bot_id,current,at,body) VALUES(?,?,?,?,?,1,?,?)")
        .run(id,logicalId,revision,source.conversation,source.botId,at,JSON.stringify(source));
      this.enqueue(id,false);
      this.event("message_observed",{id,logicalId,revision,source:source.source,conversation:source.conversation,evidence:source.evidence});
      if(replacing)this.rebuildStates();
      return this.message(id);
    });
  }
  private retire(ids:string[]){for(const id of ids){
    this.db.prepare("UPDATE messages SET current=0 WHERE id=?").run(id);
    this.db.prepare("UPDATE items SET current=0 WHERE message_id=?").run(id);
    this.db.prepare("UPDATE jobs SET state='superseded' WHERE message_id=? AND replay=0 AND state='pending'").run(id);
  }}
  reconcile(conversation:string,seen:string[]){const keep=new Set(seen);const ids=this.db.prepare("SELECT id FROM messages WHERE conversation=? AND current=1").all(conversation).map(row=>String(row.id)).filter(id=>!keep.has(id));
    if(ids.length)this.atomic(()=>{this.retire(ids);this.rebuildStates();this.event("source_messages_retired",{conversation,ids});});}
  private rebuildStates(){
    // Reverts must retract resolution evidence as well as the removed message's own cards.
    this.db.exec("UPDATE items SET state=initial_state,body=json_set(body,'$.state',initial_state) WHERE current=1");
    for(const row of this.db.prepare("SELECT body FROM events WHERE kind='item_state_changed' ORDER BY seq").all()){
      const change=JSON.parse(String(row.body));
      if(!this.db.prepare("SELECT 1 FROM messages WHERE id=? AND current=1").get(change.messageId))continue;
      this.db.prepare("UPDATE items SET state=?,body=json_set(body,'$.state',?) WHERE id=? AND current=1").run(change.state,change.state,change.targetId);
    }
  }
  message(id:string):Message {
    const row=this.db.prepare("SELECT * FROM messages WHERE id=?").get(id);if(!row)throw new Error("unknown attention message");
    return {...JSON.parse(String(row.body)),id,logicalId:String(row.logical_id),revision:String(row.revision),observedAt:Number(row.at),seq:Number(row.seq),current:Boolean(row.current)};
  }
  enqueue(messageId:string,replay:boolean,requestId?:string):string[]{
    const message=this.message(messageId), ids:string[]=[];
    // Segment at UTF-16 boundaries without splitting a surrogate pair. Every character is retained.
    for(let start=0;start<message.text.length;){
      let end=Math.min(start+12_000,message.text.length);
      if(end<message.text.length && /[\uD800-\uDBFF]/.test(message.text[end-1]!))end--;
      const id=requestId?digest([requestId,messageId,start]):randomUUID();
      this.db.prepare("INSERT OR IGNORE INTO jobs VALUES(?,?,?,?, 'pending',?,?,?)").run(id,messageId,start,end,Number(replay),randomUUID(),Date.now()+(message.complete?0:1500));
      ids.push(id);start=end;
    }return ids;
  }
  next():Job|null {
    const row=this.db.prepare("SELECT * FROM jobs WHERE state='pending' AND available_at<=? ORDER BY rowid LIMIT 1").get(Date.now());
    return row?{id:String(row.id),messageId:String(row.message_id),start:Number(row.start),end:Number(row.end),state:String(row.state),replay:Boolean(row.replay),requestId:String(row.request_id),availableAt:Number(row.available_at)}:null;
  }
  jobState(id:string,state:string,delay=0){this.db.prepare("UPDATE jobs SET state=?,available_at=? WHERE id=?").run(state,Date.now()+delay,id);}
  retry(id:string,delay:number){this.db.prepare("UPDATE jobs SET state='pending',available_at=?,request_id=? WHERE id=?").run(Date.now()+delay,randomUUID(),id);}
  replay(runId:string,requestId:string){
    const run=this.run(runId),original=this.db.prepare("SELECT * FROM jobs WHERE id=?").get(String(run.job_id))!;
    if (run.body.contentClearedAt) throw new Error("attention_content_cleared");
    if(run.state==="running")throw new Error("cannot replay an unfinished run");
    const id=digest([requestId,runId]);
    const previous=this.meta<string>(`replayRequest:${requestId}`);
    if(previous&&previous!==runId)throw new Error("replay_request_conflict");
    this.atomic(()=>{
      this.setMeta(`replayRequest:${requestId}`,runId);
      this.db.prepare("INSERT OR IGNORE INTO jobs VALUES(?,?,?,?, 'pending',1,?,?)").run(id,String(original.message_id),Number(original.start),Number(original.end),randomUUID(),Date.now());
      this.setMeta(`frozen:${id}`,{runId,inputBlob:run.body.inputBlob});
    });return {jobIds:[id]};
  }
  context(message:Message){
    const recent=this.db.prepare("SELECT id FROM messages WHERE conversation=? AND seq<? AND current=1 ORDER BY seq DESC LIMIT 8").all(message.conversation,message.seq)
      .reverse().map(row=>{const m=this.message(String(row.id));return {id:m.id,role:m.role,authorKind:m.authorKind,text:m.text.slice(-3000),truncated:m.text.length>3000};});
    const rows=this.db.prepare(`SELECT body FROM items WHERE current=1 AND (conversation=? OR (bot_id IS NOT NULL AND bot_id=?))
      AND message_id IN (SELECT id FROM messages WHERE seq<?) ORDER BY CASE WHEN state IN ('open','partial','unclear') THEN 0 ELSE 1 END,rowid DESC LIMIT 24`)
      .all(message.conversation,message.botId,message.seq);
    const items:Item[]=[];let chars=JSON.stringify(recent).length;
    for(const row of rows){const item=JSON.parse(String(row.body)) as Item;const size=JSON.stringify(item).length;if(chars+size>80_000)break;chars+=size;items.push(item);}
    return {messages:recent,items,coverage:"bounded_recent_and_open",omittedCandidateItems:rows.length-items.length};
  }
  startRun(job:Job,body:unknown){const id=randomUUID();this.atomic(()=>{this.jobState(job.id,"running");this.db.prepare("INSERT INTO runs VALUES(?,?,?,NULL,'running',?)").run(id,job.id,Date.now(),JSON.stringify(body));this.event("run_started",{id,jobId:job.id,requestId:job.requestId});});return id;}
  run(id:string){const row=this.db.prepare("SELECT * FROM runs WHERE id=?").get(id) as {id:string;job_id:string;at:number;finished:number|null;state:string;body:string}|undefined;if(!row)throw new Error("unknown attention run");return {...row,body:JSON.parse(row.body)};}
  finishRun(id:string,state:string,patch:Record<string,unknown>){const run=this.run(id);this.db.prepare("UPDATE runs SET state=?,finished=?,body=? WHERE id=?").run(state,Date.now(),JSON.stringify({...run.body,...patch}),id);this.event("run_finished",{id,state,...patch});}
  apply(runId:string,job:Job,message:Message,result:Annotation,context:ReturnType<AttentionStore["context"]>){
    const target=message.text.slice(job.start,job.end),known=new Set(context.items.map(item=>item.id));
    const span=(quote:string,occurrence=0)=>{let at=-1;for(let i=0;i<=occurrence;i++){at=target.indexOf(quote,at+1);if(at<0)throw new Error("evidence_quote_not_found");}return {start:job.start+at,end:job.start+at+quote.length};};
    const items=result.items.map((item,index)=>{
      for(const relation of item.relations)if(relation.targetId&&!known.has(relation.targetId))throw new Error("unknown_relation_target");
      return {...item,id:`${runId}:${index}`,messageId:message.id,runId,conversation:message.conversation,botId:message.botId,...span(item.evidence.quote,item.evidence.occurrence),current:!job.replay&&this.message(message.id).current};
    });
    for(const change of result.stateChanges){if(!known.has(change.targetId))throw new Error("unknown_state_target");span(change.quote);}
    this.atomic(()=>{
      for(const item of items)this.db.prepare("INSERT INTO items VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(item.id,message.id,runId,message.conversation,message.botId,Number(item.current),item.state,item.attention.reason,item.audience.kind,JSON.stringify(item),item.state);
      if(!job.replay&&this.message(message.id).current)for(const change of result.stateChanges){
        const row=this.db.prepare("SELECT body FROM items WHERE id=? AND current=1").get(change.targetId);
        if(!row)continue;
        const item=JSON.parse(String(row.body));
        this.db.prepare("UPDATE items SET state=?,body=? WHERE id=?").run(change.state,JSON.stringify({...item,state:change.state}),change.targetId);
        this.event("item_state_changed",{runId,messageId:message.id,previousState:item.state,...change});
      }
      this.jobState(job.id,"completed");this.finishRun(runId,"completed",{annotation:result,itemIds:items.map(item=>item.id),applied:!job.replay&&this.message(message.id).current});
    });
  }
  page(kind:"messages"|"runs"|"items"|"events"|"feedback",after:number,limit:number,filters:PageFilters={},order:"asc"|"desc"="asc",before?:number){
    const conditions=["rowid>?"];const args:(string|number)[]=[after];
    if(order==="desc"&&before)conditions.push("rowid<?"),args.push(before);
    if(kind==="items")conditions.push("current=1");
    const equal=(column:string,value?:string)=>{if(value){conditions.push(`${column}=?`);args.push(value);}};
    const within=(column:string,values:string[]|undefined,negate=false)=>{if(values?.length){conditions.push(`${column} ${negate?"NOT ":""}IN (${values.map(()=>"?").join(",")})`);args.push(...values);}};
    if(kind==="items"){equal("conversation",filters.conversation);equal("bot_id",filters.botId);equal("message_id",filters.messageId);equal("state",filters.state);within("state",filters.states);equal("audience",filters.audience);equal("reason",filters.reason);}
    if(kind==="messages"){equal("conversation",filters.conversation);equal("bot_id",filters.botId);}
    if(kind==="runs"&&filters.messageId){conditions.push("job_id IN (SELECT id FROM jobs WHERE message_id=?)");args.push(filters.messageId);}
    if(kind==="events"){within("kind",filters.kinds);within("kind",filters.excludeKinds,true);}
    if(kind==="feedback"){equal("json_extract(body,'$.messageId')",filters.messageId);equal("json_extract(body,'$.runId')",filters.runId);}
    const rows=this.db.prepare(`SELECT rowid AS cursor,* FROM ${kind} WHERE ${conditions.join(" AND ")} ORDER BY rowid ${order==="desc"?"DESC":"ASC"} LIMIT ?`).all(...args,limit+1);
    const candidates=rows.slice(0,limit).map(row=>{
      if(kind==="messages"){const m=this.message(String(row.id));const {evidence:_evidence,...preview}=m;return {...preview,text:m.text.slice(0,2000),textChars:m.text.length,cursor:row.cursor};}
      if(kind==="runs"){const body=JSON.parse(String(row.body));const job=this.db.prepare("SELECT message_id,replay FROM jobs WHERE id=?").get(String(row.job_id));
        return {contentClearedAt:body.contentClearedAt??null,id:row.id,jobId:row.job_id,messageId:job?String(job.message_id):null,replay:Boolean(job?.replay),replayOf:body.replayOf??null,promptVersion:body.promptVersion??null,
          at:row.at,finished:row.finished,state:row.state,requestId:body.requestId,settings:body.settings,error:body.error??null,cursor:row.cursor};}
      if(kind==="items")return {cursor:row.cursor,item:{...JSON.parse(String(row.body)),current:Boolean(row.current),state:row.state}};
      if(kind==="feedback"){const body=JSON.parse(String(row.body));return {cursor:row.cursor,id:row.id,at:row.at,messageId:body.messageId,runId:body.runId??null,kind:body.kind,author:body.author,body:body.body};}
      const body=String(row.body);
      return {...row,body:body.length<=12_000?JSON.parse(body):null,bodyChars:body.length,omitted:body.length>12_000};
    });
    const entries:typeof candidates=[];let bytes=0;
    for(const entry of candidates){const size=Buffer.byteLength(JSON.stringify(entry));if(entries.length&&bytes+size>200_000)break;entries.push(entry);bytes+=size;}
    const fallback=order==="desc"?before??0:after;
    return {entries,nextCursor:Number(rows[entries.length-1]?.cursor??fallback),hasMore:rows.length>entries.length};
  }
  exportRun(id:string){
    const run=this.run(id);const job=this.db.prepare("SELECT * FROM jobs WHERE id=?").get(String(run.job_id))!;
    const body=run.body;const blobs=Object.fromEntries([body.inputBlob,body.instructionsBlob,body.responseBlob].filter((v):v is string=>typeof v==="string").map(hash=>[hash,this.text(hash)]));
    const feedback=this.db.prepare("SELECT body FROM feedback ORDER BY at").all().map(row=>JSON.parse(String(row.body))).filter(row=>row.runId===id||row.messageId===job.message_id);
    const events=this.db.prepare("SELECT seq,at,kind,body FROM events WHERE json_extract(body,'$.runId')=? OR json_extract(body,'$.id')=? ORDER BY seq").all(id,id).map(row=>({...row,body:JSON.parse(String(row.body))}));
    return {schemaVersion:1,run,job,message:this.message(String(job.message_id)),blobs,events,feedback};
  }
  feedback(id:string,body:unknown){const cleared=this.db.prepare("SELECT digest FROM cleared_feedback WHERE id=?").get(id);if(cleared){if(cleared.digest!==digest(body))throw new Error("feedback_id_conflict");return {id};} const prior=this.db.prepare("SELECT body FROM feedback WHERE id=?").get(id);if(prior&&prior.body!==JSON.stringify(body))throw new Error("feedback_id_conflict");
    if(!prior)this.atomic(()=>{this.db.prepare("INSERT INTO feedback VALUES(?,?,?)").run(id,Date.now(),JSON.stringify(body));this.event("feedback_recorded",{id,body});});return {id};}
  status(){return {enabled:this.meta<boolean>("enabled")??false,activatedAt:this.meta<number>("activatedAt"),baselined:this.meta<boolean>("baselined")??false,
    checkpointGeneration: this.meta<number>("checkpointGeneration") ?? 0,
    checkpointResets: (this.db.prepare("SELECT key,value FROM meta WHERE key LIKE 'checkpointReset:%' ORDER BY key").all()).map(row => ({ source: String(row.key).slice(16), ...JSON.parse(String(row.value)) })),
    contentGeneration: this.meta<number>("contentGeneration") ?? 0,
    settings:this.defaults(),lastScan:this.meta("lastScan"),lastInference:this.meta("lastInference"),sourceErrors:this.meta("sourceErrors")??[],
    jobs:this.db.prepare("SELECT state,COUNT(*) AS count FROM jobs GROUP BY state").all(),messages:Number(this.db.prepare("SELECT COUNT(*) AS n FROM messages").get()!.n),
    runs:Number(this.db.prepare("SELECT COUNT(*) AS n FROM runs").get()!.n),
    changeSeq:this.meta<number>("changeSeq")??0};}

  private historyRevision() {
    const hash = createHash("sha256");
    for (const table of ["messages", "jobs", "runs", "items", "events", "feedback", "meta"])
      for (const row of this.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).iterate()) hash.update(JSON.stringify(row));
    return hash.digest("hex");
  }
  historyPlan() {
    const counts = ["messages", "runs", "items", "events", "feedback", "blobs"].map(table => `${table}:${this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n}`);
    return this.maintenance.plan({ subject: null, action: "all_captured_content", revision: this.historyRevision(), resources: counts,
      blockedBy: this.meta("enabled") || this.db.prepare("SELECT 1 FROM jobs WHERE state='running' LIMIT 1").get() ? ["Pause Signal and wait for source reads and inference to drain"] : [],
      retained: ["Message IDs/revisions suppress recreation of the same captured revision", "Job/request IDs, terminal outcomes and inference correlation remain; unknown stays unknown", "Inference payloads are a separate owner: page attention_infer_requests before purging through Infer", "Upstream Bot/Worker transcripts and shared HUD Work remain"],
      regeneration: ["Clears all Signal evidence, including cross-conversation context copies, feedback, source-read blobs and partial buffers", "Source cursors remain; new or changed upstream revisions can be captured after explicit resume"] }, {});
  }
  historyClear(input: StateApplyInput) {
    return this.maintenance.atomic(input, plan => {
      if (this.meta("enabled") || this.db.prepare("SELECT 1 FROM jobs WHERE state='running' LIMIT 1").get() || plan.action !== "all_captured_content" || plan.revision !== this.historyRevision()) throw new Error("Signal state changed or enabled; pause, drain and prepare again");
    }, () => {
      const at = new Date().toISOString();
      for (const row of this.db.prepare("SELECT id,body FROM messages").all()) {
        const body = JSON.parse(String(row.body));
        this.db.prepare("UPDATE messages SET body=?,current=0 WHERE id=?").run(JSON.stringify({ ...body, text: "", evidence: {}, contentClearedAt: at }), row.id!);
      }
      this.db.exec("INSERT OR IGNORE INTO cleared_messages SELECT id FROM messages; DELETE FROM items; UPDATE jobs SET state='cancelled' WHERE state='pending'");
      for (const row of this.db.prepare("SELECT id,body FROM runs").all()) {
        const body = JSON.parse(String(row.body));
        const retained = { requestId: body.requestId, messageId: body.messageId, settings: body.settings, promptVersion: body.promptVersion, replayOf: body.replayOf, contentClearedAt: at };
        this.db.prepare("UPDATE runs SET body=? WHERE id=?").run(JSON.stringify(retained), row.id!);
      }
      for (const row of this.db.prepare("SELECT id,body FROM feedback").all()) this.db.prepare("INSERT OR IGNORE INTO cleared_feedback VALUES(?,?)").run(row.id!, digest(JSON.parse(String(row.body))));
      // Keep correlation only; source-read blobs can contain many conversations.
      for (const row of this.db.prepare("SELECT seq,body FROM events").all()) {
        const body = JSON.parse(String(row.body));
        this.db.prepare("UPDATE events SET body=? WHERE seq=?").run(JSON.stringify({ requestId: body.requestId, runId: body.runId, contentClearedAt: at }), row.seq!);
      }
      this.db.exec("DELETE FROM feedback; DELETE FROM blobs; DELETE FROM meta WHERE key LIKE 'frozen:%'");
      for (const row of this.db.prepare("SELECT key,value FROM meta WHERE key LIKE 'cursor:worker:%'").all()) {
        const cursor = JSON.parse(String(row.value)); this.setMeta(String(row.key), { ...cursor, buffer: null });
      }
      this.setMeta("sourceErrors", []); this.setMeta("lastInference", null);
      this.setMeta("contentGeneration", (this.meta<number>("contentGeneration") ?? 0) + 1);
      this.event("content_cleared", { generation: this.meta("contentGeneration") });
      return [{ resource: "signal:captured-content", outcome: "removed", detail: "Captured text, annotations, feedback, source-read/provider blobs and Worker partial buffers removed; minimal identity/outcome receipts retained" }];
    });
  }
  inferRequests(offset: number, limit: number) {
    const rows = this.db.prepare(`SELECT request_id AS requestId FROM jobs UNION SELECT json_extract(body,'$.requestId') FROM events
      WHERE json_extract(body,'$.requestId') IS NOT NULL ORDER BY requestId LIMIT ? OFFSET ?`).all(limit + 1, offset);
    return { requestIds: rows.slice(0, limit).map(row => String(row.requestId)), nextOffset: rows.length > limit ? offset + limit : null };
  }
  checkpointPreview(heads: SourceHead[]) {
    const local = heads.map(head => ({ ...head, previous: this.meta(`cursor:${head.source}`), reconcile: this.meta(`reconcile:${head.source}`) }));
    const running = this.db.prepare("SELECT id,state FROM jobs WHERE state IN ('pending','running') ORDER BY id").all();
    return { subject: null, action: "checkpoint_rebaseline", revision: digest([local, running, this.meta("enabled"), this.meta("baselined"), this.meta("checkpointGeneration"), this.meta("activatedAt")]),
      resources: heads.map(head => head.source),
      blockedBy: [ ...(this.meta("enabled") ? ["Pause Signal before checkpoint reset"] : []),
        ...(!this.meta("baselined") ? ["Establish Signal's first-enable baseline before resetting exact sources"] : []),
        ...(running.length ? ["Resolve pending/running interpretations or clear captured history separately before rebaseline"] : []) ],
      retained: ["Captured messages, annotations, feedback, suppressed message revisions and Infer correlation/outcomes remain", "Sibling source checkpoints, activation time and inference defaults remain", "Upstream transcripts, HUD Work and independent Infer payloads are untouched"],
      regeneration: ["Resuming reads from the new position; current upstream messages are skipped, not interpreted", "Reset admits no inference. New messages/revisions observed later can admit inference under the existing defaults"] };
  }
  checkpointPlan(selection: string[] | "all", heads: SourceHead[]) {
    return this.maintenance.plan(this.checkpointPreview(heads), { selection });
  }
  checkpointReset(input: StateApplyInput, heads: SourceHead[]) {
    return this.maintenance.atomic(input, plan => {
      const current = this.checkpointPreview(heads);
      if (plan.action !== "checkpoint_rebaseline" || plan.revision !== current.revision || current.blockedBy.length) throw new Error("Signal source positions or state changed; pause, drain and prepare again");
    }, () => {
      const at = Date.now(), generation = (this.meta<number>("checkpointGeneration") ?? 0) + 1;
      for (const head of heads) {
        this.setMeta(`cursor:${head.source}`, head.cursor);
        this.setMeta(`reconcile:${head.source}`, null);
        this.setMeta(`checkpointReset:${head.source}`, { at, generation });
      }
      this.setMeta("checkpointGeneration", generation);
      const selected = new Set(heads.map(head => head.source));
      this.setMeta("sourceErrors", (this.meta<{source:string;error:string}[]>("sourceErrors") ?? []).filter(error => !selected.has(error.source) && !selected.has(error.source.replace(/^chat:/, "bot:"))));
      this.event("checkpoints_rebaselined", { sources: [...selected], generation, at });
      return heads.map(head => ({ resource: head.source, outcome: "removed", detail: "Previous cursor/partial buffer replaced by observed current position; retained content and suppression unchanged; no inference admitted" }));
    });
  }
}
