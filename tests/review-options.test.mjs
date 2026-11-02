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
 }finally{await mf.dispose();}
});
