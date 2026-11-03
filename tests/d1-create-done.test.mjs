import {readFileSync} from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';

// 2026-11-04: 起票時に ステータス=完了 だけで作られたタスクが「片肺完了」(完了フラグ・完了日なし) になり、夜間棚卸しが期日を繰り越し続けた件の再発防止
test('起票で ステータス=完了 だけ渡しても 完了・完了日・ステータス の3点が揃い AI処理開始 は空になる',async()=>{
 const lab=readFileSync(new URL('../src/lab.js',import.meta.url),'utf8');
 const native=readFileSync(new URL('../src/d1.js',import.meta.url),'utf8').replace(/^import .*;$/gm,'')+'\n'+readFileSync(new URL('../src/knowledge.js',import.meta.url),'utf8').replace(/^import .*;$/gm,'').replace(/^export /gm,'');
 let outbound=0;
 const ds='d'.repeat(32),id='a'.repeat(32);
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,compatibilityDate:'2026-09-01',d1Databases:['DB'],bindings:{TASKS_DATA_SOURCE_ID:ds,DATA_BACKEND:'d1'},outboundService:()=>{outbound++;return new Response('no outbound',{status:500});},script:lab+'\n'+native+`\nexport default {async fetch(req,env){const u=new URL(req.url);if(u.pathname==='/init'){await initD1(env);return Response.json({ok:true});}if(u.pathname.startsWith('/api/storage/'))return storageRoute(req,env,u,(v,s=200)=>Response.json(v,{status:s}));return Response.json(await d1Notion({...env,KAIROS_ORIGIN:'https://kairos.test'},u.pathname+u.search,{method:req.method,...(req.method==='GET'?{}:{body:await req.text()})}));}};`}));
 try{
  const api=async(path,body,method)=>{const r=await mf.dispatchFetch('https://kairos.test'+path,{method:method || (body?'PATCH':'GET'),...(body?{body:JSON.stringify(body)}:{})});assert.equal(r.status,200,await r.clone().text());return r.json();};
  await api('/init');const db=await mf.getD1Database('DB');
  await db.prepare('INSERT INTO entity_schemas VALUES(?,?,?)').bind(ds,'tasks',JSON.stringify({properties:{名前:{type:'title'},完了:{type:'checkbox'},完了日:{type:'date'},ステータス:{type:'status'},AI処理開始:{type:'date'}}})).run();
  const page=await api('/pages',{parent:{data_source_id:ds},properties:{名前:{title:[{text:{content:'片肺検証'}}]},ステータス:{status:{name:'完了'}},AI処理開始:{date:{start:'2026-11-03T01:41:28.557Z'}}}},'POST');
  assert.equal(page.properties.完了.checkbox,true);
  assert.equal(page.properties.ステータス.status.name,'完了');
  assert.match(page.properties.完了日.date.start,/^\d{4}-\d{2}-\d{2}$/);
  assert.equal(page.properties.AI処理開始.date,null);
  const open=await api('/pages',{parent:{data_source_id:ds},properties:{名前:{title:[{text:{content:'未完了'}}]},ステータス:{status:{name:'未着手'}}}},'POST');
  assert.equal(open.properties.完了.checkbox,false);
  assert.equal(open.properties.完了日.date,null);
  assert.equal(outbound,0);
 }finally{await mf.dispose();}});
