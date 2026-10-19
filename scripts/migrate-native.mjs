import {readFile,writeFile,mkdir,rename} from 'node:fs/promises';
import {setTimeout as pause} from 'node:timers/promises';
const [configPath, outputDir, phase='all'] = process.argv.slice(2);
if(!configPath||!outputDir||!process.env.APP_TOKEN)throw new Error('Usage: node --env-file=.dev.vars scripts/migrate-native.mjs <github-vars.json> <private-output-dir> [props|bodies|all]');
const vars=JSON.parse(await readFile(configPath,'utf8'));
const origin=vars.find(v=>v.name==='PUBLIC_URL')?.value;
if(origin!=='https://tasks-pwa.masaki-saito.workers.dev')throw new Error('Unexpected Worker destination');
if(!['props','bodies','all'].includes(phase))throw new Error('Unknown migration phase');
const root=outputDir.replace(/\/$/,'')+'/';await mkdir(root,{recursive:true,mode:0o700});
async function api(path){const r=await fetch(origin+'/api/storage/'+path,{method:'POST',headers:{Authorization:'Bearer '+process.env.APP_TOKEN},redirect:'error',signal:AbortSignal.timeout(180000)});if(!r.ok){await writeFile(root+'last-error.json',await r.text(),{mode:0o600});throw new Error(path.split('?')[0]+' HTTP '+r.status);}return r.json();}
if(phase==='props'||phase==='all'){
 await api('init');let counts={};
 for(const coll of ['tasks','projects','roles','decisions','habits','habit_log']){let cursor,n=0;do{const r=await api('capture?'+new URLSearchParams({coll,...(cursor?{cursor}:{})}));cursor=r.next;n+=r.n;console.log(coll,n);await pause(400);}while(cursor);counts[coll]=n;await writeFile(root+'counts.json',JSON.stringify(counts),{mode:0o600});} if(process.env.EXTRA_SOURCES_FILE){const extra=JSON.parse(await readFile(process.env.EXTRA_SOURCES_FILE,'utf8'));for(const {coll,ds} of extra){let cursor,n=0;do{const r=await api('capture?'+new URLSearchParams({coll,ds,...(cursor?{cursor}:{})}));cursor=r.next;n+=r.n;console.log(coll,n);await pause(400);}while(cursor);counts[coll]=n;await writeFile(root+'counts.json',JSON.stringify(counts),{mode:0o600});}}
 const presence=vars.find(v=>v.name==='PRESENCE_PAGE_ID')?.value;if(presence)await api('capture-page?id='+presence);
}

if(phase==='bodies'||phase==='all'){
let state;try{state=JSON.parse(await readFile(root+'body-state.json','utf8'));}catch{state={done:[],queue:[],assets:[],assetsDone:[],databasesDone:[],pagesDone:[],errors:[],blocks:0};}
let writing=Promise.resolve();const save=()=>{const data=JSON.stringify(state);return writing=writing.then(async()=>{await writeFile(root+'body-state.json.tmp',data,{mode:0o600});await rename(root+'body-state.json.tmp',root+'body-state.json');});};
const clean=id=>id.replace(/-/g,'').toLowerCase();
async function bodyApi(path,get=false){for(let attempt=0;attempt<4;attempt++){try{const r=await fetch(origin+'/api/storage/'+path,{method:get?'GET':'POST',headers:{Authorization:'Bearer '+process.env.APP_TOKEN},redirect:'error',signal:AbortSignal.timeout(180000)});if(r.ok)return await r.json();await writeFile(root+'last-body-error.json',await r.text(),{mode:0o600});if(r.status<500&&r.status!==429)throw new Error('HTTP '+r.status);if(attempt===3)throw new Error('HTTP '+r.status);}catch(e){if(attempt===3||/HTTP 4/.test(e.message))throw e;}await pause((attempt+1)*2000);}throw new Error('No response');}
const empty=await bodyApi('complete-empty');for(const id of empty.ids)if(!state.done.includes(id))state.done.push(id);state.queue=state.queue.filter(id=>!state.done.includes(id));
state.queue.unshift(...(state.active || []));state.active=[];
const active=new Map();
const add=ids=>{for(const id of ids){const k=clean(id);if(!state.done.includes(k)&&!state.queue.includes(k)&&!active.has(k)&&!state.errors.some(e=>e.kind==='body'&&e.id===k))state.queue.push(k);}};
async function processBody(id){let cursor=null;try{
 do{
  const r=await bodyApi('capture-body?'+new URLSearchParams({id,...(cursor?{cursor}:{})}));
  state.blocks+=r.n;add(r.children || []);
  for(const page of r.pages || [])if(!state.pagesDone.includes(clean(page))){try{await bodyApi('capture-page?id='+clean(page));state.pagesDone.push(clean(page));add([page]);}catch(e){state.errors.push({kind:'child-page',id:clean(page),error:e.message});}}
  for(const db of r.databases || [])if(!state.databasesDone.includes(clean(db))){try{const info=await bodyApi('capture-database?id='+clean(db));for(const ds of info.sources){let c;do{const source=await bodyApi('capture-source?'+new URLSearchParams({ds,...(c?{cursor:c}:{})}));add(source.ids);c=source.next;await pause(400);}while(c);}state.databasesDone.push(clean(db));}catch(e){state.errors.push({kind:'database',id:clean(db),error:e.message});}}
  for(const asset of r.assets || []){const k=clean(asset);if(!state.assets.includes(k))state.assets.push(k);}
  cursor=r.next;await save();await pause(200);
 }while(cursor);
 state.done.push(id);
 }catch(e){state.errors.push({kind:'body',id,error:e.message});}
}
while(true){
 while(active.size<2&&state.queue.length){const id=state.queue.shift();if(state.done.includes(id)||active.has(id)||state.errors.some(e=>e.kind==='body'&&e.id===id))continue;
  const job=processBody(id).finally(async()=>{active.delete(id);state.active=[...active.keys()];await save();});active.set(id,job);state.active=[...active.keys()];await save();}
 if(active.size){await Promise.race([...active.values()]);if(state.done.length%20===0)console.log('bodies',state.done.length,'queue',state.queue.length,'blocks',state.blocks,'errors',state.errors.length);continue;}
 const manifest=await bodyApi('status?manifest=1',true);add(manifest.ids);await save();if(!state.queue.length)break;
}
for(const id of state.assets)if(!state.assetsDone.includes(id)){try{const r=await bodyApi('capture-asset?id='+id);state.assetsDone.push(id);console.log('asset saved',state.assetsDone.length,'bytes',r.size);}catch(e){state.errors.push({kind:'asset',id,error:e.message});}await save();}
console.log('Body pass complete',JSON.stringify({bodies:state.done.length,blocks:state.blocks,assets:state.assetsDone.length,errors:state.errors.length}));if(state.errors.length)process.exitCode=2;

}
