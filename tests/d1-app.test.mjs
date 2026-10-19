import {readFileSync} from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {initD1} from '../src/d1.js';
const src=name=>readFileSync(new URL('../src/'+name,import.meta.url),'utf8');
test('本体APIがNOTION_TOKENなしで一覧・完了・復元し、プレビューでは更新しない',async()=>{
 const ds='d'.repeat(32),id='a'.repeat(32);let outbound=0;
 const source=src('lab.js')+'\n'+src('d1.js').replace(/^import .*;$/m,'')+'\n'+src('icons.js').replaceAll('export const ', 'const ')+'\n'+['APP_HTML','SW_JS','MANIFEST'].map((name,i)=>'const '+name+'='+JSON.stringify(src(['app.html','sw.txt','manifest.webmanifest'][i]))+';').join('\n')+'\nconst {isMcpPath,mcpRoute}=(()=>{'+src('mcp.js').replace(/^export /gm,'')+'\nreturn {isMcpPath,mcpRoute};})();\n'+src('index.js').replace(/^import .*\n/gm,'');
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,compatibilityDate:'2026-09-01',d1Databases:['DB'],bindings:{APP_TOKEN:'test-only-token',DATA_BACKEND:'d1'},outboundService:()=>{outbound++;return new Response('blocked',{status:500});},script:source}));
 try{
  const db=await mf.getD1Database('DB');await initD1({DB:db});
  await db.prepare('INSERT INTO entity_schemas VALUES(?,?,?)').bind(ds,'tasks',JSON.stringify({properties:{名前:{type:'title'},完了:{type:'checkbox'},ステータス:{type:'status'},実行環境:{type:'multi_select',multi_select:{options:[{name:'スマホ'},{name:'電話'}]}},担当:{type:'select',select:{options:[]}}}})).run();
  const today=new Date(Date.now()+9*3600000).toISOString().slice(0,10);
  await db.prepare('INSERT INTO entities(id,ds,collection,payload) VALUES(?,?,?,?)').bind(id,ds,'tasks',JSON.stringify({id,properties:{名前:{type:'title',title:[{plain_text:'検証タスク'}]},完了:{type:'checkbox',checkbox:false},期日:{type:'date',date:{start:today}},ステータス:{type:'status',status:{name:'未着手'}}}})).run();
  const api=async(path,body,preview=false)=>{const response=await mf.dispatchFetch('https://kairos.test'+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer test-only-token','Content-Type':'application/json',...(preview?{'X-Kairos-Preview':'d1'}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:response.status,data:await response.json()};};
  const list=await api('/api/tasks?view=today');assert.equal(list.status,200);assert.equal(list.data.tasks[0].name,'検証タスク');
  assert.equal((await api('/api/tasks/'+id+'/done',{},true)).status,502);
  assert.equal((await api('/api/tasks?view=today')).data.tasks[0].done,false);
  const done=await api('/api/tasks/'+id+'/done',{});assert.equal(done.status,200);assert.equal(done.data.task.done,true);assert.equal(done.data.task.status,'完了');
  const restored=await api('/api/tasks/'+id+'/restore',{done:false,doneAt:null,status:'未着手'});assert.equal(restored.status,200);assert.equal(restored.data.task.done,false);
  assert.equal((await mf.dispatchFetch('https://kairos.test/api/tasks')).status,401);
  assert.equal(outbound,0);
 }finally{await mf.dispose();}
});
