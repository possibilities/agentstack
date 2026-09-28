// Explicit disposable VM proof; never part of pnpm test.
import { BrowserSystem } from '../dist/src/system.js';
import { Backend } from '../dist/src/backend.js';
import { Profiles } from '../dist/src/profiles.js';
import { api } from '../dist/api.js';
import { prepareBotBrowserConfig, browserNamespace } from '../dist/src/config.js';
import { serveSocket, socketPath, operation, botInstance } from '@agentstack/api';
import { z } from 'zod';
import { mkdtemp, mkdir, symlink, writeFile, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
if (!process.env.HYPEMAN_ROOT || !process.env.AGENT_BROWSER_TOOLCHAIN) throw Error('explicit test-authorized HYPEMAN_ROOT and AGENT_BROWSER_TOOLCHAIN required');
const root = await mkdtemp('/private/var/folders/9g/l0rgs8rs2_9__kqn0smr9tnh0000gp/T/opencode/handoff-');
console.log('PROOF ROOT '+root);
const env={...Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith('AGENT_BROWSER_'))),AGENTSTACK_STATE_DIR:root};
await mkdir(root+'/browser/toolchain',{recursive:true});await symlink(process.env.AGENT_BROWSER_TOOLCHAIN,root+'/browser/toolchain/current');
const system = new BrowserSystem(env);const backend = new Backend(system);
const bot={id:'proof',url:'unix://'+root+'/bot.sock',state:'running',recoveryIssue:null};
const invocation={transport:'mcp',botId:bot.id,instance:botInstance(bot.url),threadId:'main',sessionId:null};
const bots=await serveSocket({info:{name:'bots',description:'fixture',transportDescription:'fixture',path:socketPath('bots',env)},context:{},operations:[
  operation({name:'bot_list',description:'fixture',input:z.object({}),output:z.object({bots:z.array(z.unknown())}),async call(){return {bots:[bot]};}}),
  operation({name:'chat_thread_read',description:'fixture',input:z.object({botId:z.string(),threadId:z.string()}),output:z.object({thread:z.unknown()}),async call(_c,i){assert.equal(i.botId,'proof');assert.equal(i.threadId,'main');return {thread:{id:'main'}};}}),
]});
const profiles=new Profiles(backend,system,env);let service;
const config=prepareBotBrowserConfig(env,bot.id,bot.url);const namespace=browserNamespace(env,bot.id,invocation.instance);
const empty=root+'/viewer.json';await writeFile(empty,'{}');
const instrument=root+'/instrument.js';await writeFile(instrument,`window.__ws=[];window.__dc=[];window.__pcs=[];window.WebSocket=new Proxy(window.WebSocket,{construct(T,a){const w=new T(...a);window.__ws.push(w);return w;}});window.RTCPeerConnection=new Proxy(window.RTCPeerConnection,{construct(T,a){const p=new T(...a);window.__pcs.push(p);p.addEventListener('datachannel',e=>window.__dc.push(e.channel));const c=p.createDataChannel.bind(p);p.createDataChannel=(...a)=>{const d=c(...a);window.__dc.push(d);return d;};return p;}});`);
const exec=promisify(execFile);let binary;
const cmd=async(session,cfg,args)=>JSON.parse((await exec(binary,['--config',cfg,'--namespace',namespace,'--session',session,'--idle-timeout','0','--json',...args],{env,timeout:65000,maxBuffer:2000000})).stdout);
const ab=(...args)=>cmd('default',config,args);const viewer=(...args)=>cmd('viewer',empty,args);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const results=[];const record=(check,data)=>{results.push({check,data});console.log(check,JSON.stringify(data));};
// kernel/neko abe9ac59a634 manager.go routes client-created channels to
// handleLegacy; the server-created channel uses a different binary protocol.
// Use the actual image client's encoder and channel, not the first label match.
const key=`(()=>{const c=window.$client;if(!c?.connected)throw Error('Neko client disconnected');c.sendData('keydown',{key:97});c.sendData('keyup',{key:97});return {id:c._channel.id,encoder:c.sendData.toString()};})()`;
// The server-created channel uses uint32 keysyms and big-endian fields.
const modernKey=`(()=>{const d=window.__dc.find(d=>d!==window.$client._channel&&d.label==='data'&&d.readyState==='open');if(!d)throw Error('no server-created input channel');for(const op of [3,4]){const b=new ArrayBuffer(7),v=new DataView(b);v.setUint8(0,op);v.setUint16(1,4);v.setUint32(3,97);d.send(b);}return {id:d.id};})()`;
try {
  await system.start();await system.setHypemanLocation(process.env.HYPEMAN_ROOT);await system.enableHypeman(process.env.HYPEMAN_ROOT);
  binary=(await system.browserStatus()).location;await profiles.start(false);await profiles.tick();
  service=await serveSocket({info:{name:'browse',description:'fixture',transportDescription:'fixture',path:socketPath('browse',env)},context:{system,backend,profiles},operations:api.operations});
  const a=profiles.list()[0];const b=process.env.PROOF_INPUT_ONLY ? null : await profiles.create(bot.id,'Secondary');if(b)await profiles.ensure(b.id);
  if(a.state==='failed'&&a.error?.includes('within 35 seconds')) {record('slow guest startup',a.error);await sleep(90000);record('same guest readiness retry',await profiles.ensure(a.id));}
  assert.equal((await profiles.select(bot.id,'default',a.id)).state,'connected');
  await ab('open','about:blank');
  await ab('eval',`document.title='GATE-INPUT-PROOF';window.__marker='stable-proof';document.body.innerHTML='<input id="proof" autofocus><button>Old ref</button>';document.querySelector('input').focus();window.__inputEvents=[];for(const type of ['keydown','keyup','mousedown','mouseup'])document.addEventListener(type,e=>window.__inputEvents.push({type,key:e.key,trusted:e.isTrusted}))`);
  await ab('snapshot','-i');
  assert.equal((await profiles.select(bot.id,'parallel',a.id)).state,'connected');
  const waiting=ab('eval','new Promise(r=>setTimeout(()=>r("drained"),1800))').catch(e=>({error:e.stdout??e.message}));await sleep(400);
  let h=await profiles.requestHandoff({profileId:a.id,message:'Type in the focused field',requestId:randomUUID()},invocation);
  record('in-flight command',await waiting);record('handoff drain',h);assert.equal(h.state,'awaiting_human');
  for(const session of ['default','parallel','late']) {
    await assert.rejects(cmd(session,config,['eval','document.title="forbidden"']));
  }
  record('held existing parallel and new controllers',true);
  if(b){assert.equal((await profiles.select(bot.id,'secondary',b.id)).state,'connected');
  record('secondary profile usable',await cmd('secondary',config,['get','title']));}
  const resource=await backend.get('profile:'+a.id);
  const nativeA=JSON.parse(await readFile(root+'/browser/sessions.json','utf8')).find(r=>r.session===resource.session).native;
  const guestExec=async(command,args=[])=>{const response=await fetch(`http://${nativeA.ip}:10001/process/exec`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({command,args,timeout_sec:10}),signal:AbortSignal.timeout(15000)});const result=await response.json();return {...result,stdout:Buffer.from(result.stdout_b64??'','base64').toString(),stderr:Buffer.from(result.stderr_b64??'','base64').toString()};};
  record('native window focus',await guestExec('/bin/sh',['-c','DISPLAY=:1 timeout -k 1 5 xdotool search --name GATE-INPUT-PROOF windowactivate --sync']));
  const observation=profiles.list().find(p=>p.id===a.id).observation.url;
  await viewer('--init-script',instrument,'open',observation);await sleep(7000);
  record('observation receiver',await viewer('eval','({text:document.body.innerText,peers:window.__pcs.map(p=>p.connectionState),dc:window.__dc.map(d=>d.readyState),videos:[...document.querySelectorAll("video")].map(v=>v.getVideoPlaybackQuality().totalVideoFrames)})'));
  await viewer('eval',`window.__ws.find(w=>w.readyState===1).send(JSON.stringify({event:'admin/control'}))`);
  record('observer legacy input',await viewer('eval',key));record('observer modern input',await viewer('eval',modernKey));await sleep(300);
  // Owner diagnostic read from exact disposable profile (not a managed agent path).
  const raw=await backend.launch('profile:'+a.id,true);
  const inspect=async()=>cmd('inspect',empty,['--cdp',raw.cdpUrl,'eval','document.querySelector("input").value']);
  assert.equal((await inspect()).data.result,'');record('observer input unchanged; positive control still required',true);
  const take={id:h.id,expectedRevision:h.revision,requestId:randomUUID()};const taken=await profiles.actHandoff('take',take);h=taken.handoff;record('human take',taken);assert.ok(taken.controlUrl);
  await viewer('open',taken.controlUrl);await sleep(7000);
  record('human receiver',await viewer('eval','({clientId:window.$client.id,peers:window.__pcs.map(p=>p.connectionState),channels:window.__dc.map(d=>({label:d.label,id:d.id,state:d.readyState})),text:document.body.innerText})'));
  await viewer('eval',`window.__ws.find(w=>w.readyState===1).send(JSON.stringify({event:'admin/control'}))`);await sleep(300);
  record('human focus',await cmd('inspect',empty,['--cdp',raw.cdpUrl,'eval','({focus:document.activeElement.outerHTML,visibility:document.visibilityState,hasFocus:document.hasFocus(),screenX,screenY,outerHeight,innerHeight,rect:document.querySelector("input").getBoundingClientRect().toJSON()})']));
  const nekoOrigin=new URL((await backend.observation('profile:'+a.id)).url).origin;
  const admin=await(await fetch(nekoOrigin+'/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'proof-inspect',password:'admin'})})).json();
  record('Neko host',await(await fetch(nekoOrigin+'/api/room/control',{headers:{authorization:'Bearer '+admin.token}})).json());
  record('Neko sessions',await(await fetch(nekoOrigin+'/api/sessions',{headers:{authorization:'Bearer '+admin.token}})).json());
  await viewer('screenshot',root+'/human.png');
  record('input packet sent',await viewer('eval',key));await sleep(1000);
  record('human typed',await inspect());
  assert.equal((await inspect()).data.result,'a');
  record('native X keyboard after human input',await guestExec('/bin/sh',['-c','DISPLAY=:1 timeout -k 1 5 xdotool key b']));await sleep(1000);
  assert.equal((await inspect()).data.result,'ab');
  const events=(await cmd('inspect',empty,['--cdp',raw.cdpUrl,'eval','({marker:window.__marker,events:window.__inputEvents})'])).data.result;record('trusted input events',events);
  assert.equal(events.marker,'stable-proof');for(const key of ['a','b'])assert.ok(events.events.some(e=>e.type==='keydown'&&e.key===key&&e.trusted));
  record('observer refusal validated by human positive control',true);
  const oldUrl=taken.controlUrl;
   h=(await profiles.actHandoff('finish',{id:h.id,expectedRevision:h.revision,requestId:randomUUID(),outcome:'completed',note:'Typed a; native X control added b'})).handoff;
  assert.equal(h.state,'resolved');assert.equal((await fetch(oldUrl)).status,403);
  await sleep(300);
  const revoked=await viewer('eval','({peers:window.__pcs.map(p=>p.connectionState),channels:window.__dc.map(d=>d.readyState)})');
  record('human grant revoked',revoked);assert.ok(revoked.data.result.channels.every(s=>s==='closed'));assert.ok(revoked.data.result.peers.every(s=>s==='closed'));
  const staleInput=await viewer('eval',`window.__dc.map(d=>{try{d.send(new Uint8Array([3,8,0,97,0,0,0,0,0,0,0]));return 'sent';}catch(e){return e.name;}})`);
  record('revoked channels refuse input',staleInput);assert.ok(staleInput.data.result.length>0);assert.ok(staleInput.data.result.every(e=>e==='InvalidStateError'));
  await assert.rejects(ab('click','@e1'),e=>/Unknown ref|not found|snapshot/i.test(e.stdout??e.message));
  record('fresh snapshot after return',await ab('snapshot','-i'));assert.equal((await ab('eval','document.querySelector("input").value')).data.result,'ab');
  await ab('fill','@e1','resumed');assert.equal((await ab('eval','document.querySelector("input").value')).data.result,'resumed');record('resumed automation with fresh ref',true);
  record('completed',h);
} catch(error) {record('failure',{message:error.message,stdout:error.stdout,stack:error.stack});process.exitCode=1;}
finally {
  const native=JSON.parse(await readFile(root+'/browser/sessions.json','utf8').catch(()=>'[]'));
  for(const r of native)if(r.native)await writeFile(root+'/'+r.native.instanceId+'.log',await readFile(process.env.HYPEMAN_ROOT+'/data/guests/'+r.native.instanceId+'/logs/app.log').catch(()=>''));
  if(binary)for(const session of ['default','parallel','late','secondary','viewer','inspect'])await cmd(session,empty,['close']).catch(()=>{});
  await service?.close();
  for(const r of await backend.list())if(r.target)await backend.close({session:r.session,lease:r.lease,backend:'local',browserTarget:r.target.name,browserProfile:r.profile});else await backend.reconcile(r.session,r.lease);
  await profiles.close().catch(()=>{});await backend.closeContext();await system.close();await bots.close();
  record('cleanup',await backend.list());await writeFile(root+'/results.json',JSON.stringify(results,null,2));console.log('RESULTS '+root+'/results.json');
}
