// Explicit operator-only VM integration probe; not part of pnpm test.
// HYPEMAN_ROOT must name an already running local test-authorized host.
import { BrowserSystem } from '../dist/src/system.js';
import { Backend } from '../dist/src/backend.js';
import { Profiles } from '../dist/src/profiles.js';
import { prepareBotBrowserConfig, browserNamespace } from '../dist/src/config.js';
import { api } from '../dist/api.js';
import { serveSocket, socketPath, operation, botInstance } from '@agentstack/api';
import { z } from 'zod';
import { mkdtemp, mkdir, symlink, writeFile, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
const exec = promisify(execFile);
if (!process.env.HYPEMAN_ROOT || !process.env.AGENT_BROWSER_TOOLCHAIN) throw Error('explicit HYPEMAN_ROOT and AGENT_BROWSER_TOOLCHAIN required');
const root = await mkdtemp('/private/var/folders/9g/l0rgs8rs2_9__kqn0smr9tnh0000gp/T/opencode/db-');
const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith('AGENT_BROWSER_'))), AGENTSTACK_STATE_DIR: root };
const checks=[]; const record=(name,data)=>{checks.push({name,data});console.log(name,JSON.stringify(data));};
await mkdir(root+'/browser/toolchain',{recursive:true}); await symlink(process.env.AGENT_BROWSER_TOOLCHAIN,root+'/browser/toolchain/current');
let inventory=[{id:'bot-proof',url:'unix://'+root+'/fake-bot.sock',state:'running',recoveryIssue:null}];
const bots=await serveSocket({info:{name:'bots',description:'fixture',transportDescription:'fixture',path:socketPath('bots',env)},context:{},operations:[operation({name:'bot_list',description:'fixture',input:z.object({}),output:z.object({bots:z.array(z.unknown())}),async call(){return {bots:inventory};}})]});
const system = new BrowserSystem(env); await system.start(); await system.setHypemanLocation(process.env.HYPEMAN_ROOT); await system.enableHypeman(process.env.HYPEMAN_ROOT);
let backend=new Backend(system); let profiles=new Profiles(backend,system,env); await profiles.start(false);
let service=await serveSocket({info:{name:'browse',description:'fixture',transportDescription:'fixture',path:socketPath('browse',env)},context:{system,backend,profiles},operations:api.operations});
const bot=inventory[0];const config=prepareBotBrowserConfig(env,bot.id,bot.url);const namespace=browserNamespace(env,bot.id,botInstance(bot.url));
const binary=(await system.browserStatus()).location;
const ab=async(...args)=>{const r=await exec(binary,['--config',config,'--namespace',namespace,'--session','default','--idle-timeout','0','--json',...args],{env,timeout:65000,maxBuffer:2000000});return JSON.parse(r.stdout);};
const viewerConfig=root+'/viewer.json'; await writeFile(viewerConfig,'{}');
const instrument=root+'/instrument.js'; await writeFile(instrument,'window.__pcs=[];window.RTCPeerConnection=new Proxy(window.RTCPeerConnection,{construct(T,args){const p=new T(...args);window.__pcs.push(p);return p;}});');
const viewer=async(...args)=>{const r=await exec(binary,['--config',viewerConfig,'--namespace',namespace,'--session','viewer','--json',...args],{env,timeout:65000,maxBuffer:2000000});return JSON.parse(r.stdout);};
try {
 await profiles.tick(); const a=profiles.list()[0]; const b=await profiles.create(bot.id,'Extra'); await profiles.ensure(b.id);
 assert.equal(profiles.list().find(p=>p.id===a.id).state,'ready');
 record('default auto-provisioned',a); record('additional empty profile',profiles.list().find(p=>p.id===b.id));
 record('select A',await profiles.select(bot.id,'default',a.id));
 await ab('open','http://127.0.0.1:9222/json/version');
 await ab('eval','document.body.innerHTML="<button>Old A</button>";document.title="Durable A";document.cookie="proof=yes;Max-Age=3600;path=/";localStorage.setItem("proof","yes");setInterval(()=>document.body.style.background=Math.random()>.5?"red":"blue",200)');
 record('A snapshot',await ab('snapshot','-i'));
 const waiting=ab('wait','1500'); await new Promise(r=>setTimeout(r,100));
 record('select B',await profiles.select(bot.id,'default',b.id)); await waiting;
 record('actual B',await ab('get','cdp-url'));
 try { await ab('click','@e1'); throw Error('old ref unexpectedly accepted'); } catch(e) { assert.match(e.stdout??e.message,/Unknown ref/); record('old refs invalidated',true); }
 await ab('open','http://127.0.0.1:9222/json/version');
 const empty=await ab('eval','({cookie:document.cookie,storage:localStorage.getItem("proof")})'); record('B isolation',empty);
 const view=profiles.list().find(p=>p.id===a.id).observation;
 const html=await(await fetch(view.url)).text(); await writeFile(root+'/neko.html',html); record('Neko HTTP',{url:view.url,bytes:html.length,html:html.slice(0,1500)});
 try {
   await writeFile(root+'/neko-app.js',await(await fetch(new URL('js/app.189b39a3.js',view.url))).text());
   const viewUrl=new URL(view.url);viewUrl.searchParams.set('readOnly','1');
   record('Neko open',await viewer('--init-script',instrument,'open',viewUrl.href)); await new Promise(r=>setTimeout(r,10000));
   record('Neko snapshot',await viewer('snapshot','-i'));
   record('Neko video',await viewer('eval','({text:document.body.innerText,videos:[...document.querySelectorAll("video")].map(v=>({width:v.videoWidth,height:v.videoHeight,time:v.currentTime,paused:v.paused,frames:v.getVideoPlaybackQuality().totalVideoFrames}))})'));
   record('Neko peers',await viewer('eval','Promise.all((window.__pcs||[]).map(async p=>({state:p.connectionState,ice:p.iceConnectionState,video:[...await p.getStats()].map(([k,v])=>v).filter(v=>v.type==="inbound-rtp"&&v.kind==="video").map(v=>({framesDecoded:v.framesDecoded,framesPerSecond:v.framesPerSecond,bytesReceived:v.bytesReceived}))})))'));
 } catch(e) { record('Neko video unavailable',{message:e.message,stdout:e.stdout}); }
 await viewer('close');
 record('select A again',await profiles.select(bot.id,'default',a.id)); record('A retained',await ab('get','title'));
 await ab('eval','document.cookie="lastSecond=yes;Max-Age=3600;path=/";localStorage.setItem("lastSecond","yes")');
 await ab('close'); assert.equal((await fetch(profiles.list().find(p=>p.id===a.id).cdpUrl+'/json/version')).ok,true);
 record('controller close preserved browser',true);
 await service.close(); await profiles.close(); await backend.closeContext(); record('planned shutdown',true);
 backend=new Backend(system); profiles=new Profiles(backend,system,env); await profiles.start(false);
 service=await serveSocket({info:{name:'browse',description:'fixture',transportDescription:'fixture',path:socketPath('browse',env)},context:{system,backend,profiles},operations:api.operations});
 record('cold restart',await profiles.ensure(a.id)); record('post-restart binding',await profiles.select(bot.id,'default',a.id));
 await ab('open','http://127.0.0.1:9222/json/version'); const data=await ab('eval','({cookie:document.cookie,storage:localStorage.getItem("proof"),lastSecond:localStorage.getItem("lastSecond")})'); record('cold persistence',data);
 assert.match(JSON.stringify(data),/proof=yes/); assert.match(JSON.stringify(data),/"storage":"yes"/);
 assert.match(JSON.stringify(data),/lastSecond=yes/); assert.match(JSON.stringify(data),/"lastSecond":"yes"/);
 inventory=[]; await profiles.releaseBot(bot.id); await profiles.tick(); record('Bot deletion retained unassigned profiles',profiles.list());
 assert.ok(profiles.list().every(p=>p.botId===null&&!p.default));
} catch(e) {record('failure',{message:e.message,stack:e.stack,stdout:e.stdout});process.exitCode=1;}
finally {
 // An empty launch config cannot accidentally re-admit a removed Bot while
 // cleaning up a controller which was already disconnected by releaseBot.
 await exec(binary,['--config',viewerConfig,'--namespace',namespace,'--session','default','--json','close'],{env,timeout:20000}).catch(()=>{});
 await viewer('close').catch(()=>{});
 await service.close();
 // Exact receipts belong only to this disposable test state directory.
 for(const r of await backend.list()) {
   if(r.target) await backend.close({session:r.session,lease:r.lease,backend:'local',browserTarget:r.target.name,browserProfile:r.profile});
   else await backend.reconcile(r.session,r.lease);
 }
 await backend.closeContext(); await system.close(); await bots.close();
 record('cleanup',await backend.list());await writeFile(root+'/results.json',JSON.stringify(checks,null,2));console.log('RESULTS '+root+'/results.json');
}
