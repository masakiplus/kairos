import {readFileSync} from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {initD1} from '../src/d1.js';
const src=name=>readFileSync(new URL('../src/'+name,import.meta.url),'utf8');
test('一覧の応答を D1 に置いて使い回し、書き込みのあとは使わない (複数ビュー ?views= も)',async()=>{
 const ds='d'.repeat(32),id='a'.repeat(32);let outbound=0;
 const source=src('lab.js')+'\n'+src('d1.js').replace(/^import .*;$/gm,'')+'\n'+src('knowledge.js').replace(/^import .*;$/gm,'').replace(/^export /gm,'')+'\n'+src('icons.js').replaceAll('export const ', 'const ')+'\n'+['APP_HTML','SW_JS','MANIFEST'].map((name,i)=>'const '+name+'='+JSON.stringify(src(['app.html','sw.txt','manifest.webmanifest'][i]))+';').join('\n')+'\nconst {isMcpPath,mcpRoute}=(()=>{'+src('mcp.js').replace(/^export /gm,'')+'\nreturn {isMcpPath,mcpRoute};})();\n'+src('index.js').replace(/^import .*\n/gm,'');
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,compatibilityDate:'2026-09-01',d1Databases:['DB'],bindings:{APP_TOKEN:'test-only-token',DATA_BACKEND:'d1'},outboundService:()=>{outbound++;return new Response('blocked',{status:500});},script:source}));
 try{
  const db=await mf.getD1Database('DB');await initD1({DB:db});
  await db.prepare('INSERT INTO entity_schemas VALUES(?,?,?)').bind(ds,'tasks',JSON.stringify({properties:{名前:{type:'title'},完了:{type:'checkbox'},ステータス:{type:'status'},実行環境:{type:'multi_select',multi_select:{options:[{name:'スマホ'},{name:'電話'}]}},担当:{type:'select',select:{options:[]}}}})).run();
  const today=new Date(Date.now()+9*3600000).toISOString().slice(0,10);
  await db.prepare('INSERT INTO entities(id,ds,collection,payload) VALUES(?,?,?,?)').bind(id,ds,'tasks',JSON.stringify({id,properties:{名前:{type:'title',title:[{plain_text:'検証タスク'}]},完了:{type:'checkbox',checkbox:false},期日:{type:'date',date:{start:today}},ステータス:{type:'status',status:{name:'未着手'}}}})).run();
  const api=async(path,body,preview=false)=>{const response=await mf.dispatchFetch('https://kairos.test'+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer test-only-token','Content-Type':'application/json',...(preview?{'X-Kairos-Preview':'d1'}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:response.status,data:await response.json()};};
  const first=await api('/api/tasks?view=today');assert.equal(first.status,200);const name0=first.data.tasks[0].name;
  const row=await db.prepare("SELECT value FROM storage_control WHERE key='resp:tasks:today'").first();assert.ok(row,'応答が D1 に保存される');
  const parts=row.value.split('\n');const body=JSON.parse(parts.slice(2).join('\n'));body.tasks[0].name='CACHED';
  await db.prepare("UPDATE storage_control SET value=? WHERE key='resp:tasks:today'").bind(parts[0]+'\n'+parts[1]+'\n'+JSON.stringify(body)).run();
  assert.equal((await api('/api/tasks?view=today')).data.tasks[0].name,'CACHED','書き込みが無ければ保存した応答を返す');
  const multi=await api('/api/tasks?views=today,doing');assert.equal(multi.status,200);assert.equal(multi.data.views.today.tasks[0].name,'CACHED');assert.ok(Array.isArray(multi.data.views.doing.tasks));
  const done=await api('/api/tasks/'+id+'/done',{});assert.equal(done.status,200);
  const after=await api('/api/tasks?view=today');assert.ok(after.data.tasks.every(t=>t.name!=='CACHED'),'書き込み後は保存した応答を使わない');assert.ok(after.data.tasks.every(t=>t.done),'完了が反映される');
  assert.equal(name0.length>0,true);
  }finally{await mf.dispose();}
});
