import {readFileSync} from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {initD1} from '../src/d1.js';
const src=name=>readFileSync(new URL('../src/'+name,import.meta.url),'utf8');
// 2026-10-23: ⭐ 今日の3つ のタスクを「明日へ」送っても 今日やる に戻ってきて開始日まで今日に書き戻されていた
test('⭐今日の3つのタスクを未来へ延期すると⭐が外れて今日やるから消え、↩で戻る',async()=>{
 const ds='d'.repeat(32),id='b'.repeat(32);
 const source=src('lab.js')+'\n'+src('d1.js').replace(/^import .*;$/gm,'')+'\n'+src('knowledge.js').replace(/^import .*;$/gm,'').replace(/^export /gm,'')+'\n'+src('icons.js').replaceAll('export const ', 'const ')+'\n'+['APP_HTML','SW_JS','MANIFEST'].map((name,i)=>'const '+name+'='+JSON.stringify(src(['app.html','sw.txt','manifest.webmanifest'][i]))+';').join('\n')+'\nconst {isMcpPath,mcpRoute}=(()=>{'+src('mcp.js').replace(/^export /gm,'')+'\nreturn {isMcpPath,mcpRoute};})();\n'+src('index.js').replace(/^import .*\n/gm,'');
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,compatibilityDate:'2026-09-01',d1Databases:['DB'],bindings:{APP_TOKEN:'test-only-token',DATA_BACKEND:'d1'},outboundService:()=>new Response('blocked',{status:500}),script:source}));
 try{
  const db=await mf.getD1Database('DB');await initD1({DB:db});
  await db.prepare('INSERT INTO entity_schemas VALUES(?,?,?)').bind(ds,'tasks',JSON.stringify({properties:{名前:{type:'title'},完了:{type:'checkbox'},ステータス:{type:'status'},開始日:{type:'date'},期日:{type:'date'},今日の3つ:{type:'date'},担当:{type:'select',select:{options:[]}}}})).run();
  const today=new Date(Date.now()+9*3600000).toISOString().slice(0,10);
  await db.prepare('INSERT INTO entities(id,ds,collection,payload) VALUES(?,?,?,?)').bind(id,ds,'tasks',JSON.stringify({id,properties:{名前:{type:'title',title:[{plain_text:'星のタスク'}]},完了:{type:'checkbox',checkbox:false},開始日:{type:'date',date:{start:today}},今日の3つ:{type:'date',date:{start:today}},ステータス:{type:'status',status:{name:'未着手'}}}})).run();
  const api=async(path,body)=>{const r=await mf.dispatchFetch('https://kairos.test'+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer test-only-token','Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,data:await r.json()};};
  const before=(await api('/api/tasks?view=today')).data.tasks.find(t=>t.id===id);
  assert.ok(before?.mit,'延期前は⭐');
  const r=await api('/api/tasks/'+id+'/defer?days=1',{});
  assert.equal(r.status,200);assert.equal(r.data.mitCleared,true);assert.equal(r.data.task.mit,false);assert.ok(r.data.task.start>today);
  const after=(await api('/api/tasks?view=today')).data.tasks.find(t=>t.id===id);
  assert.equal(after,undefined,'今日やるから消える');
  const back=await api('/api/tasks/'+id+'/restore',{startRaw:today,mitRaw:before.mitRaw});
  assert.equal(back.status,200);assert.equal(back.data.task.mit,true);assert.equal(back.data.task.start,today);
 }finally{await mf.dispose();}
});
