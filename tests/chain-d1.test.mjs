import {readFileSync} from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {initD1} from '../src/d1.js';
const src=name=>readFileSync(new URL('../src/'+name,import.meta.url),'utf8');
test('D1 で先行チェーンが返る (2026-11-04 確認中のまま止まる件)',async()=>{
 const ds='d'.repeat(32),a='a'.repeat(32),b='b'.repeat(32);
 const source=src('lab.js')+'\n'+src('d1.js').replace(/^import .*;$/gm,'')+'\n'+src('knowledge.js').replace(/^import .*;$/gm,'').replace(/^export /gm,'')+'\n'+src('icons.js').replaceAll('export const ', 'const ')+'\n'+['APP_HTML','SW_JS','MANIFEST'].map((name,i)=>'const '+name+'='+JSON.stringify(src(['app.html','sw.txt','manifest.webmanifest'][i]))+';').join('\n')+'\nconst {isMcpPath,mcpRoute}=(()=>{'+src('mcp.js').replace(/^export /gm,'')+'\nreturn {isMcpPath,mcpRoute};})();\n'+src('index.js').replace(/^import .*\n/gm,'');
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,compatibilityDate:'2026-09-01',d1Databases:['DB'],bindings:{APP_TOKEN:'t',DATA_BACKEND:'d1',TASKS_DATA_SOURCE_ID:ds},outboundService:()=>new Response('blocked',{status:500}),script:source}));
 try{
  const db=await mf.getD1Database('DB');await initD1({DB:db});
  await db.prepare('INSERT INTO entity_schemas VALUES(?,?,?)').bind(ds,'tasks',JSON.stringify({properties:{名前:{type:'title'},完了:{type:'checkbox'},先行タスク:{type:'relation',relation:{data_source_id:ds}}}})).run();
  const page=(id,name,preds)=>({id,properties:{名前:{type:'title',title:[{plain_text:name}]},完了:{type:'checkbox',checkbox:false},ステータス:{type:'status',status:{name:'人対応'}},先行タスク:{type:'relation',relation:preds.map(id=>({id}))}}});
  await db.prepare('INSERT INTO entities(id,ds,collection,payload) VALUES(?,?,?,?)').bind(a,ds,'tasks',JSON.stringify(page(a,'①',[]))).run();
  await db.prepare('INSERT INTO entities(id,ds,collection,payload) VALUES(?,?,?,?)').bind(b,ds,'tasks',JSON.stringify(page(b,'②',[a]))).run();
  await db.prepare('INSERT INTO entity_links VALUES(?,?,?)').bind(b,'先行タスク',a).run();
  const ctl=new AbortController();const timer=setTimeout(()=>ctl.abort(),15000);
  const r=await mf.dispatchFetch('https://kairos.test/api/tasks/'+b+'/chain',{headers:{Authorization:'Bearer t'},signal:ctl.signal});clearTimeout(timer);
  const body=await r.text();
  assert.equal(r.status,200,body);
  const j=JSON.parse(body);assert.deepEqual(j.chain.map(t=>t.name),['①']);
  // D1 に無い先行は飛ばし、先行待ちにも数えない
  const c='c'.repeat(32),gone='e'.repeat(32);
  await db.prepare('INSERT INTO entities(id,ds,collection,payload) VALUES(?,?,?,?)').bind(c,ds,'tasks',JSON.stringify(page(c,'③',[gone]))).run();
  await db.prepare('INSERT INTO entity_links VALUES(?,?,?)').bind(c,'先行タスク',gone).run();
  const r2=await mf.dispatchFetch('https://kairos.test/api/tasks/'+c+'/chain',{headers:{Authorization:'Bearer t'}});
  assert.equal(r2.status,200);assert.deepEqual((await r2.json()).chain,[]);
  const list=await (await mf.dispatchFetch('https://kairos.test/api/tasks?view=all',{headers:{Authorization:'Bearer t'}})).json();
  const t3=(list.tasks||[]).find(t=>t.name==='③');if(t3)assert.equal(t3.blocked,false);
 }finally{await mf.dispose();}
});
