import {readFileSync} from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {initD1} from '../src/d1.js';
// 2026-11-14: 要求ログ (docs/logging.md)。失敗と遅い要求だけを D1 の req_log に残し、古い行を捨てる
const src=name=>readFileSync(new URL('../src/'+name,import.meta.url),'utf8');
const bundle=()=>src('lab.js')+'\n'+src('d1.js').replace(/^import .*;$/gm,'')+'\n'+src('knowledge.js').replace(/^import .*;$/gm,'').replace(/^export /gm,'')+'\n'+src('icons.js').replaceAll('export const ', 'const ')+'\n'+src('launches.js').replace(/^export /gm,'')+'\n'+src('taps.js').replace(/^export /gm,'')+'\n'+['APP_HTML','SW_JS','MANIFEST'].map((name,i)=>'const '+name+'='+JSON.stringify(src(['app.html','sw.txt','manifest.webmanifest'][i]))+';').join('\n')+'\nconst {isMcpPath,mcpRoute}=(()=>{'+src('mcp.js').replace(/^export /gm,'')+'\nreturn {isMcpPath,mcpRoute};})();\n'+src('index.js').replace(/^import .*\n/gm,'');
const H={Authorization:'Bearer test-only-token','Content-Type':'application/json'};
const ds='d'.repeat(32),id='a'.repeat(32);

async function boot(bindings){
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,compatibilityDate:'2026-09-01',d1Databases:['DB'],bindings:{APP_TOKEN:'test-only-token',DATA_BACKEND:'d1',TASKS_DATA_SOURCE_ID:ds,...bindings},outboundService:()=>new Response('blocked',{status:500}),script:bundle()}));
 const db=await mf.getD1Database('DB');await initD1({DB:db});
 await db.prepare('INSERT INTO entity_schemas VALUES(?,?,?)').bind(ds,'tasks',JSON.stringify({properties:{名前:{type:'title'},完了:{type:'checkbox'},ステータス:{type:'status'},実行環境:{type:'multi_select',multi_select:{options:[{name:'Mac'}]}},担当:{type:'select',select:{options:[]}},AI処理開始:{type:'date'},AI処理種別:{type:'select',select:{options:[{name:'実行'},{name:'更新'}]}},AIセッション:{type:'url'}}})).run();
 await db.prepare('INSERT INTO entities(id,ds,collection,payload) VALUES(?,?,?,?)').bind(id,ds,'tasks',JSON.stringify({id,properties:{名前:{type:'title',title:[{plain_text:'検証'}]},完了:{type:'checkbox',checkbox:false},ステータス:{type:'status',status:{name:'未着手'}},実行環境:{type:'multi_select',multi_select:[]}}})).run();
 const call=async(path,method='GET')=>{const r=await mf.dispatchFetch('https://kairos.test'+path,{method,headers:H});return {status:r.status,data:await r.json()};};
 // 記録は応答の後 (waitUntil) に書かれるので、行が出るまで少し待つ
 const logged=async(want)=>{for(let i=0;i<40;i++){const d=(await call('/api/reqlog?days=1')).data;if(want(d.rows))return d;await new Promise(r=>setTimeout(r,50));}return (await call('/api/reqlog?days=1')).data;};
 return {mf,db,call,logged};
}

test('遅い要求を req_log に残す: ID は :id に丸め、クエリは残さず、古い行は捨てる',async()=>{
 const {mf,db,call,logged}=await boot({REQLOG_SLOW_MS:'0',REQLOG_KEEP_DAYS:'30'}); // 0 ミリ秒以上=全要求を「遅い」として残す
 try{
  assert.equal((await call('/api/tasks/'+id+'/ai?mode=run&provider=claude&dev=mac','POST')).status,200);
  const first=await logged(rows=>rows.some(r=>r.route==='/api/tasks/:id/ai'));
  const row=first.rows.find(r=>r.route==='/api/tasks/:id/ai');
  assert.deepEqual([row.method,row.status,row.src,row.err],['POST',200,'http',null]);
  assert.ok(row.ms>=0&&/^\d{4}-\d\d-\d\dT/.test(row.ts));
  assert.ok(!JSON.stringify(first.rows).includes(id),'生の ID を残さない');
  assert.ok(!JSON.stringify(first.rows).includes('provider='),'クエリ文字列を残さない');
  assert.ok(!first.rows.some(r=>r.route==='/api/reqlog'),'ログを読む要求は記録しない');
  assert.deepEqual([first.slowMs,first.keepDays],[0,30]);
  // ローテーション: 保持日数より古い行は、次に書くときに消える。期間内の行は残る
  const iso=d=>new Date(Date.now()-d*86400000).toISOString();
  for(const [d,route] of [[40,'/old'],[5,'/recent']]) await db.prepare('INSERT INTO req_log(ts,method,route,status,ms,src,err) VALUES(?,?,?,?,?,?,?)').bind(iso(d),'GET',route,502,10,'http','x').run();
  assert.equal((await call('/api/entry/rules')).status,200);
  await logged(rows=>rows.some(r=>r.route==='/api/entry/rules'));
  const left=(await db.prepare('SELECT route FROM req_log ORDER BY ts').all()).results.map(r=>r.route);
  assert.ok(!left.includes('/old'),'40 日前の行は捨てる');assert.ok(left.includes('/recent'),'5 日前の行は残す');
  const wide=(await call('/api/reqlog?days=10')).data;
  const sum=wide.routes.find(r=>r.route==='/recent');
  assert.deepEqual([sum.n,sum.errors,sum.maxMs],[1,1,10],'道ごとの件数・失敗数・最大所要時間');
 }finally{await mf.dispose();}
});

test('既定では速い成功は D1 に残さず、失敗 (5xx) は本文つきで残す',async()=>{
 const {mf,db,call,logged}=await boot({});
 try{
  assert.equal((await call('/api/entry/rules')).status,200);
  await db.prepare('DROP TABLE entities').run(); // D1 の失敗を起こす
  const bad=await call('/api/tasks/'+id+'/ai?mode=run','POST');
  assert.ok(bad.status>=500,'表が無ければ失敗で返る');
  const d=await logged(rows=>rows.some(r=>r.status>=500));
  const row=d.rows.find(r=>r.status>=500);
  assert.deepEqual([row.method,row.route,row.src],['POST','/api/tasks/:id/ai','http']);
  assert.match(row.err,/entities/,'失敗の本文の先頭を残す');
  assert.ok(!d.rows.some(r=>r.route==='/api/entry/rules'),'速い成功は残さない');
 }finally{await mf.dispose();}
});
