import {readFileSync} from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
test('実Worker/D1で更新・依存・本文・添付を扱い、Notionを呼ばない',async()=>{
 const lab=readFileSync(new URL('../src/lab.js',import.meta.url),'utf8');
 const native=readFileSync(new URL('../src/d1.js',import.meta.url),'utf8').replace(/^import .*;$/gm,'')+'\n'+readFileSync(new URL('../src/knowledge.js',import.meta.url),'utf8').replace(/^import .*;$/gm,'').replace(/^export /gm,'');
 let outbound=0;
 const ds='d'.repeat(32),id='a'.repeat(32);
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,compatibilityDate:'2026-09-01',d1Databases:['DB'],bindings:{TASKS_DATA_SOURCE_ID:ds,DATA_BACKEND:'d1'},outboundService:()=>{outbound++;return new Response('no outbound',{status:500});},script:lab+'\n'+native+`\nexport default {async fetch(req,env){const u=new URL(req.url);if(u.pathname==='/init'){await initD1(env);return Response.json({ok:true});}if(u.pathname.startsWith('/api/storage/'))return storageRoute(req,env,u,(v,s=200)=>Response.json(v,{status:s}));return Response.json(await d1Notion({...env,KAIROS_ORIGIN:'https://kairos.test'},u.pathname+u.search,{method:req.method,...(req.method==='GET'?{}:{body:await req.text()})}));}};`}));
 try{
  const api=async(path,body,method)=>{const r=await mf.dispatchFetch('https://kairos.test'+path,{method:method || (body?'PATCH':'GET'),...(body?{body:JSON.stringify(body)}:{})});assert.equal(r.status,200,await r.clone().text());return r.json();};
  await api('/init');const db=await mf.getD1Database('DB');
  await db.prepare('INSERT INTO entity_schemas VALUES(?,?,?)').bind(ds,'tasks',JSON.stringify({properties:{名前:{type:'title'},完了:{type:'checkbox'},先行タスク:{type:'relation',relation:{data_source_id:ds,dual_property:{synced_property_name:'後続タスク'}}}}})).run();
  const page=await api('/pages',{parent:{data_source_id:ds},properties:{名前:{title:[{text:{content:'検証'}}]}}},'POST');
  assert.equal(page.properties.名前.title[0].plain_text,'検証');
  const patched=await api('/pages/'+page.id,{properties:{完了:{checkbox:true},完了日:{date:{start:'2026-10-17'}},ステータス:{status:{name:'完了'}}}});
  assert.equal(patched.properties.完了.checkbox,true);
  await api('/blocks/'+page.id+'/children',{children:[{type:'paragraph',paragraph:{rich_text:[{text:{content:'本文\n二行目'}}]}}]});
  const body=await api('/blocks/'+page.id+'/children');assert.equal(body.results[0].paragraph.rich_text[0].plain_text,'本文\n二行目');
  await db.prepare('INSERT INTO entity_assets VALUES(?,?,?,?,1)').bind(id,'application/pdf',3,'test.pdf').run();
  await db.prepare('INSERT INTO entity_asset_chunks VALUES(?,?,?)').bind(id,0,new Uint8Array([1,2,3]).buffer).run();
  const file=await mf.dispatchFetch('https://kairos.test/api/storage/files/'+id);
  assert.equal(file.status,200);assert.deepEqual([...new Uint8Array(await file.arrayBuffer())],[1,2,3]);
  assert.equal(outbound,0);
 }finally{await mf.dispose();}
});
