import {readFileSync} from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {initD1} from '../src/d1.js';
const src=name=>readFileSync(new URL('../src/'+name,import.meta.url),'utf8');
// 決めるタブ (2026-11-02): 問いごとの選択肢「[案 …]」をカードにし、案の無い未決は「AI が先に調べる」へ回す
test('Decisions の [案] 行が選択肢になり、選んだ案の文と効き目で決着する。案の無い未決は prep',async()=>{
 const ds='e'.repeat(32),withOpts='1'.repeat(32),noOpts='2'.repeat(32);
 const source=src('lab.js')+'\n'+src('d1.js').replace(/^import .*;$/gm,'')+'\n'+src('knowledge.js').replace(/^import .*;$/gm,'').replace(/^export /gm,'')+'\n'+src('icons.js').replaceAll('export const ', 'const ')+'\n'+['APP_HTML','SW_JS','MANIFEST'].map((name,i)=>'const '+name+'='+JSON.stringify(src(['app.html','sw.txt','manifest.webmanifest'][i]))+';').join('\n')+'\nconst {isMcpPath,mcpRoute}=(()=>{'+src('mcp.js').replace(/^export /gm,'')+'\nreturn {isMcpPath,mcpRoute};})();\n'+src('index.js').replace(/^import .*\n/gm,'');
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,compatibilityDate:'2026-09-01',d1Databases:['DB'],bindings:{APP_TOKEN:'test-only-token',DATA_BACKEND:'d1',DECISIONS_DATA_SOURCE_ID:ds},outboundService:()=>new Response('blocked',{status:500}),script:source}));
 try{
  const db=await mf.getD1Database('DB');await initD1({DB:db});
  await db.prepare('INSERT INTO entity_schemas VALUES(?,?,?)').bind(ds,'decisions',JSON.stringify({properties:{名前:{type:'title'},状態:{type:'select',select:{options:[{name:'提案中'},{name:'提示済み'},{name:'決着'}]}},決定:{type:'select',select:{options:[{name:'着手する'},{name:'棚上げ'},{name:'削除'}]}},問い:{type:'rich_text'},結論:{type:'rich_text'},日付:{type:'date'},開始日:{type:'date'},決定日:{type:'date'}}})).run();
  const rt=(s)=>({type:'rich_text',rich_text:[{plain_text:s,text:{content:s}}]});
  const row=(id,name,q,date)=>db.prepare('INSERT INTO entities(id,ds,collection,payload) VALUES(?,?,?,?)').bind(id,ds,'decisions',JSON.stringify({id,properties:{名前:{type:'title',title:[{plain_text:name}]},状態:{type:'select',select:{name:'提案中'}},問い:rt(q),日付:{type:'date',date:{start:date}}}})).run();
  await row(withOpts,'体重計測を続けるか','2週とも 1/7。\n[案 着手 推奨] 週3に下げる — 毎日は続かなかった\n[案 着手] 毎日のまま置き場所を変える\n[案 やめる] やめる — ほかの指標で足りる','2026-10-01');
  await row(noOpts,'AMS lite を買うか','ブラックフライデーの実売価格を見て決める','2026-10-02');
  const api=async(path,body)=>{const r=await mf.dispatchFetch('https://kairos.test'+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer test-only-token','Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,data:await r.json()};};
  const rv=await api('/api/review');assert.equal(rv.status,200);
  const a=rv.data.questions.find(q=>q.id.replace(/-/g,'')===withOpts),b=rv.data.questions.find(q=>q.id.replace(/-/g,'')===noOpts);
  assert.equal(a.prep,false);
  assert.deepEqual(a.options.map(o=>o.t),['週3に下げる','毎日のまま置き場所を変える','やめる','今は決めない']);
  assert.equal(a.options[0].pri,true);assert.equal(a.options[0].s,'毎日は続かなかった');
  assert.equal(a.body,'2週とも 1/7。'); // 案の行は本文に出さない
  assert.equal(b.prep,true);
  const ans=await api('/api/review/decision/'+withOpts,{answer:'opt:2',note:''});assert.equal(ans.status,200,JSON.stringify(ans.data));
  const p=JSON.parse((await db.prepare('SELECT payload FROM entities WHERE id=?').bind(withOpts).first()).payload).properties;
  assert.equal(p.状態.select.name,'決着');assert.equal(p.決定.select.name,'削除');
  assert.match(p.結論.rich_text.map(t=>t.plain_text??t.text?.content).join(''),/^やめる \(/);
  assert.equal((await api('/api/review/decision/'+withOpts,{answer:'opt:9'})).status>=400,true);
  // 応答は D1 に置いて使い回し、答えた (書き込んだ) あとは作り直す
  assert.ok(await db.prepare("SELECT 1 FROM storage_control WHERE key='resp:review'").first());
  const again=await api('/api/review');
  assert.equal(again.data.questions.some(q=>q.id.replace(/-/g,'')===withOpts),false);
  assert.equal(again.data.questions.some(q=>q.id.replace(/-/g,'')===noOpts),true);
 }finally{await mf.dispose();}
});

test('答え合わせも [案 当たり|部分的|外れ] 行で選択肢になり、無ければ prep。選ぶと 検証結果 と 学び が入る',async()=>{
 const ds='e'.repeat(32),v1='4'.repeat(32),v2='5'.repeat(32);
 const source=src('lab.js')+'\n'+src('d1.js').replace(/^import .*;$/gm,'')+'\n'+src('knowledge.js').replace(/^import .*;$/gm,'').replace(/^export /gm,'')+'\n'+src('icons.js').replaceAll('export const ', 'const ')+'\n'+['APP_HTML','SW_JS','MANIFEST'].map((name,i)=>'const '+name+'='+JSON.stringify(src(['app.html','sw.txt','manifest.webmanifest'][i]))+';').join('\n')+'\nconst {isMcpPath,mcpRoute}=(()=>{'+src('mcp.js').replace(/^export /gm,'')+'\nreturn {isMcpPath,mcpRoute};})();\n'+src('index.js').replace(/^import .*\n/gm,'');
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,compatibilityDate:'2026-09-01',d1Databases:['DB'],bindings:{APP_TOKEN:'test-only-token',DATA_BACKEND:'d1',DECISIONS_DATA_SOURCE_ID:ds},outboundService:()=>new Response('blocked',{status:500}),script:source}));
 try{
  const db=await mf.getD1Database('DB');await initD1({DB:db});
  await db.prepare('INSERT INTO entity_schemas VALUES(?,?,?)').bind(ds,'decisions',JSON.stringify({properties:{名前:{type:'title'},状態:{type:'select',select:{options:[{name:'決着'}]}},検証結果:{type:'select',select:{options:[{name:'当たり'},{name:'部分的'},{name:'外れ'},{name:'検証不要'}]}},問い:{type:'rich_text'},学び:{type:'rich_text'},結論:{type:'rich_text'},検証日:{type:'date'}}})).run();
  const rt=(s)=>({type:'rich_text',rich_text:[{plain_text:s,text:{content:s}}]});
  const row=(id,name,q)=>db.prepare('INSERT INTO entities(id,ds,collection,payload) VALUES(?,?,?,?)').bind(id,ds,'decisions',JSON.stringify({id,properties:{名前:{type:'title',title:[{plain_text:name}]},状態:{type:'select',select:{name:'決着'}},問い:rt(q),結論:rt('着手する'),検証日:{type:'date',date:{start:'2026-10-01'}}}})).run();
  await row(v1,'体重計測を週3に下げる','元の問い\n実績: 10月は週3を4週とも達成\n[案 当たり 推奨] 続いた — 4週とも週3\n[案 着手] 決定の案は答え合わせに出さない\n[案 部分的] 一部 — 体重は横ばい');
  await row(v2,'iDeCoを据え置く','元の問い');
  const api=async(path,body)=>{const r=await mf.dispatchFetch('https://kairos.test'+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer test-only-token','Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,data:await r.json()};};
  const rv=await api('/api/review');assert.equal(rv.status,200);
  const a=rv.data.questions.find(q=>q.kind==='verify'&&q.id.replace(/-/g,'')===v1),b=rv.data.questions.find(q=>q.kind==='verify'&&q.id.replace(/-/g,'')===v2);
  assert.equal(a.prep,false);assert.equal(b.prep,true);
  assert.deepEqual(a.options.map(o=>o.t),['当たり：続いた','部分的：一部']);
  assert.equal(a.options[0].pri,true);assert.match(a.body,/実績: 10月は週3/);
  assert.equal((await api('/api/review/verify/'+v1,{answer:'opt:0',note:''})).status,200);
  const p=JSON.parse((await db.prepare('SELECT payload FROM entities WHERE id=?').bind(v1).first()).payload).properties;
  assert.equal(p.検証結果.select.name,'当たり');
  assert.equal(p.学び.rich_text.map(t=>t.plain_text??t.text?.content).join(''),'続いた — 4週とも週3');
 }finally{await mf.dispose();}
});

test('D1 の query は created_time の新しい順に並べられる（移行した行と後から書いた行が混ざっても）',async()=>{
 const ds='f'.repeat(32);
 const source=src('lab.js')+'\n'+src('d1.js').replace(/^import .*;$/gm,'')+'\n'+src('knowledge.js').replace(/^import .*;$/gm,'').replace(/^export /gm,'')+'\n'+src('icons.js').replaceAll('export const ', 'const ')+'\n'+['APP_HTML','SW_JS','MANIFEST'].map((name,i)=>'const '+name+'='+JSON.stringify(src(['app.html','sw.txt','manifest.webmanifest'][i]))+';').join('\n')+'\nconst {isMcpPath,mcpRoute}=(()=>{'+src('mcp.js').replace(/^export /gm,'')+'\nreturn {isMcpPath,mcpRoute};})();\n'+src('index.js').replace(/^import .*\n/gm,'');
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,compatibilityDate:'2026-09-01',d1Databases:['DB'],bindings:{APP_TOKEN:'test-only-token',DATA_BACKEND:'d1'},outboundService:()=>new Response('blocked',{status:500}),script:source}));
 try{
  const db=await mf.getD1Database('DB');await initD1({DB:db});
  await db.prepare('INSERT INTO entity_schemas VALUES(?,?,?)').bind(ds,'sessions',JSON.stringify({properties:{名前:{type:'title'}}})).run();
  const row=(id,name,at)=>db.prepare('INSERT INTO entities(id,ds,collection,payload) VALUES(?,?,?,?)').bind(id,ds,'sessions',JSON.stringify({id,created_time:at,properties:{名前:{type:'title',title:[{plain_text:name}]}}})).run();
  await row('1'.repeat(32),'移行 10/19','2026-10-19T11:00:00.000Z');await row('2'.repeat(32),'移行 9/1','2026-09-01T00:00:00.000Z');await row('3'.repeat(32),'Kairos 11/2','2026-11-02T07:00:00.000Z');
  const r=await mf.dispatchFetch('https://kairos.test/api/data/data_sources/'+ds+'/query',{method:'POST',headers:{Authorization:'Bearer test-only-token','Content-Type':'application/json'},body:JSON.stringify({page_size:2,sorts:[{timestamp:'created_time',direction:'descending'}]})});
  const j=await r.json();assert.equal(r.status,200,JSON.stringify(j));
  assert.deepEqual(j.results.map(p=>p.properties.名前.title[0].plain_text),['Kairos 11/2','移行 10/19']);
 }finally{await mf.dispose();}
});
