import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import test from 'node:test';
import assert from 'node:assert/strict';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {initD1} from '../src/d1.js';
import {classifyEntry,launchEntry,cloudRepo,parseUsageRows,weekStart,weeklyReport,launchAdd,launchRows} from '../src/launches.js';
// 2026-10-29: 🤖 の入口 (cloud/mac/cowork) の切り分け規則・打刻・週次集計
const src=name=>readFileSync(new URL('../src/'+name,import.meta.url),'utf8');
const sys={area:'自動化・システム',kind:'作業',env:[]};

test('規則: Mac の印が先、次にリポジトリの仕事、それ以外は Cowork',()=>{
 assert.equal(classifyEntry({...sys,name:'kairos の launchd を直す'}).entry,'mac','Mac の語はリポジトリ名より先');
 assert.equal(classifyEntry({...sys,name:'何か',env:['紙・郵送']}).entry,'mac');
 assert.equal(classifyEntry({name:'保険の書類をスキャン'}).entry,'mac');
 const c=classifyEntry({...sys,name:'saito-tools の棚卸しを直す'});
 assert.deepEqual([c.entry,c.repo],['cloud','masakiplus/saito-tools']);
 assert.equal(classifyEntry({...sys,name:'tasks-pwa の表示'}).repo,'masakiplus/kairos');
 assert.equal(classifyEntry({...sys,name:'画面の不具合'},'src は tools/foo.py').entry,'cloud','本文の語でも当たる');
 assert.equal(classifyEntry({...sys,kind:'判断',name:'kairos の方針'}).entry,'cowork','判断はクラウドに振らない');
 assert.equal(classifyEntry({area:'家計・キャッシュフロー',kind:'作業',name:'kairos で家計'}).entry,'cowork','エリア違い');
 assert.equal(classifyEntry({name:'学校に連絡'}).entry,'cowork');
 assert.equal(classifyEntry({name:'何でも',env:['クラウド']}).entry,'cloud','手で付けたクラウドは勝つ');
 assert.equal(classifyEntry({name:'何でも',env:['クラウド','Mac']}).entry,'mac','Mac の印があれば Mac (規則の順)');
 assert.equal(cloudRepo('saito-workers 移行'),'masakiplus/saito-workers');
});

test('打刻の入口: 実行環境にクラウドがあれば cloud (画面の飛び先と同じ)、Claude 以外はアプリ名',()=>{
 assert.equal(launchEntry({env:['クラウド','Mac']},'claude'),'cloud','画面は isCloudTask で claude.ai/code へ飛ばす');
 assert.equal(launchEntry({env:['Mac']},'claude'),'mac');
 assert.equal(launchEntry({...sys,name:'kairos の修正'},'claude'),'cowork','実行環境が空なら飛び先は claude.ai/new (判定は rule 列で別に残る)');
 assert.equal(launchEntry({env:['クラウド']},'chatgpt'),'chatgpt');
 assert.equal(launchEntry({env:['クラウド']},'claude','https://claude.ai/code/session_x'),'cloud');
 assert.equal(launchEntry({env:['クラウド']},'claude','https://claude.ai/chat/abc'),'cowork','前回のチャットを開き直すならチャット側');
});

test('使用率ログ: 日時と週間% だけを拾い、取得不可・見出しは捨てる',()=>{
 const rows=[['日時(JST)','曜日','週間%'],['---','---','---'],['2026-10-20 06:54','火','取得不可'],['2026-10-20 (動作確認の手動実行)','火','取得不可'],['2026-10-26 17:54','月','0（リセット済み）'],['2026-10-20 08:16（動作確認3回目）','火','8']];
 assert.deepEqual(parseUsageRows(rows),[{at:'2026-10-20T08:16:00+09:00',pct:8},{at:'2026-10-26T17:54:00+09:00',pct:0}]);
});

test('週は月曜 16:00 JST で区切る',()=>{
 const ms=s=>Date.parse(s);
 assert.equal(weekStart(ms('2026-10-26T16:00:00+09:00')),ms('2026-10-26T16:00:00+09:00'));
 assert.equal(weekStart(ms('2026-10-26T15:59:00+09:00')),ms('2026-10-19T16:00:00+09:00'));
 assert.equal(weekStart(ms('2026-11-01T23:00:00+09:00')),ms('2026-10-26T16:00:00+09:00'));
 assert.equal(weekStart(ms('2026-10-27T00:30:00+09:00')),ms('2026-10-26T16:00:00+09:00'),'JST の日付が UTC と違う時間帯');
});

test('週次集計: 入口別の本数・クラウドの割合・枠の 1 日ごとの使用率、クレジット期間の印',()=>{
 const L=[{ts:'2026-11-09T23:00:00Z',entry:'cloud'},{ts:'2026-11-10T01:00:00Z',entry:'cowork'},{ts:'2026-11-10T02:00:00Z',entry:'cloud'},{ts:'2026-11-01T00:00:00Z',entry:'mac'}];
 const U=[{at:'2026-11-10T06:55:00+09:00',pct:3},{at:'2026-11-10T17:54:00+09:00',pct:9},{at:'2026-11-03T06:55:00+09:00',pct:30}];
 const r=weeklyReport(L,U,2,Date.parse('2026-11-11T12:00:00+09:00'));
 assert.equal(r.weeks.length,2);
 const [prev,cur]=r.weeks;
 assert.equal(prev.start,'2026-11-02 16:00 JST');assert.equal(prev.credit,true,'11/5 までのクレジット期間に始まった週');
 assert.equal(cur.start,'2026-11-09 16:00 JST');assert.equal(cur.credit,false);
 assert.deepEqual(cur.launches,{cloud:2,cowork:1});assert.equal(cur.cloudShare,67);
 assert.equal(cur.lastUsagePct,9);
 assert.deepEqual(cur.days[0],{from:'2026-11-09',dow:'月',launches:{cloud:2,cowork:1},usagePct:3,usageAt:'2026-11-10T06:55:00+09:00'});
 assert.equal(cur.days[1].usagePct,9,'火 16:00 以降は火の枠');
 assert.deepEqual(prev.launches,{},'11/1 は前々週');
});

test('打刻: D1 に 1 行ずつ残し、DB が無ければ何もしない',async t=>{
 const sql=new DatabaseSync(':memory:');t.after(()=>sql.close());
 const DB={prepare(q){let a=[];return {bind(...v){a=v;return this;},async run(){return sql.prepare(q).run(...a);},async all(){return {results:sql.prepare(q).all(...a)};}};}};
 await launchAdd({DB},{taskId:'aaaa-bbbb',entry:'cloud',repo:'masakiplus/kairos',mode:'実行',resume:false,device:'android',rule:'cloud',now:Date.parse('2026-10-29T01:00:00Z')});
 const rows=await launchRows({DB},0);
 assert.deepEqual(rows.map(r=>[r.day,r.task_id,r.entry,r.repo,r.resume,r.device]),[['2026-10-29','aaaabbbb','cloud','masakiplus/kairos',0,'android']]);
 assert.deepEqual(await launchAdd({},{taskId:'x',entry:'cloud'}),{ok:true,stored:0});
});

test('本体API: 🤖 で打刻、クラウドで の処理中節はクラウドだけ、実行環境が空のものを規則で埋める',async()=>{
 const ds='d'.repeat(32),ids=['a','b','c','e','f'].map(c=>c.repeat(32));
 const source=src('lab.js')+'\n'+src('d1.js').replace(/^import .*;$/gm,'')+'\n'+src('knowledge.js').replace(/^import .*;$/gm,'').replace(/^export /gm,'')+'\n'+src('icons.js').replaceAll('export const ', 'const ')+'\n'+src('launches.js').replace(/^export /gm,'')+'\n'+['APP_HTML','SW_JS','MANIFEST'].map((name,i)=>'const '+name+'='+JSON.stringify(src(['app.html','sw.txt','manifest.webmanifest'][i]))+';').join('\n')+'\nconst {isMcpPath,mcpRoute}=(()=>{'+src('mcp.js').replace(/^export /gm,'')+'\nreturn {isMcpPath,mcpRoute};})();\n'+src('index.js').replace(/^import .*\n/gm,'');
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,compatibilityDate:'2026-09-01',d1Databases:['DB'],bindings:{APP_TOKEN:'test-only-token',DATA_BACKEND:'d1',TASKS_DATA_SOURCE_ID:ds,USAGE_LOG_TASK_ID:ids[4]},outboundService:()=>new Response('blocked',{status:500}),script:source}));
 try{
  const db=await mf.getD1Database('DB');await initD1({DB:db});
  await db.prepare('INSERT INTO entity_schemas VALUES(?,?,?)').bind(ds,'tasks',JSON.stringify({properties:{名前:{type:'title'},完了:{type:'checkbox'},ステータス:{type:'status'},エリア:{type:'select',select:{options:[{name:'自動化・システム'}]}},種類:{type:'select',select:{options:[{name:'作業'}]}},実行環境:{type:'multi_select',multi_select:{options:[{name:'Mac'},{name:'紙・郵送'},{name:'クラウド'}]}},担当:{type:'select',select:{options:[]}},AI処理開始:{type:'date'},AI処理種別:{type:'select',select:{options:[{name:'実行'},{name:'更新'}]}},AIセッション:{type:'url'}}})).run();
  const row=(id,name,env,extra={})=>db.prepare('INSERT INTO entities(id,ds,collection,payload) VALUES(?,?,?,?)').bind(id,ds,'tasks',JSON.stringify({id,properties:{名前:{type:'title',title:[{plain_text:name}]},完了:{type:'checkbox',checkbox:false},ステータス:{type:'status',status:{name:'未着手'}},実行環境:{type:'multi_select',multi_select:env.map(name=>({name}))},...extra}})).run();
  const sys={エリア:{type:'select',select:{name:'自動化・システム'}},種類:{type:'select',select:{name:'作業'}}};
  await row(ids[0],'Kairos の画面を直す',['クラウド']);
  await row(ids[1],'Apple Watch の Trade In',['紙・郵送']);
  await row(ids[2],'saito-tools の棚卸しを直す',[],sys);
  await row(ids[3],'launchd の時刻を変える',[],sys);
  await row(ids[4],'学校に連絡',[]);
  const api=async(path,method='GET')=>{const r=await mf.dispatchFetch('https://kairos.test'+path,{method,headers:{Authorization:'Bearer test-only-token','Content-Type':'application/json'}});return {status:r.status,data:await r.json()};};
  assert.equal((await api('/api/tasks/'+ids[0]+'/ai?mode=run&provider=claude&dev=mac','POST')).status,200);
  assert.equal((await api('/api/tasks/'+ids[1]+'/ai?mode=update&provider=claude&dev=android','POST')).status,200);
  const log=(await api('/api/entry/log?days=1')).data.rows;
  assert.deepEqual(log.map(r=>[r.task_id,r.entry,r.repo,r.mode,r.device,r.rule]),[[ids[0],'cloud','masakiplus/kairos','実行','mac','cloud'],[ids[1],'mac',null,'更新','android','mac']]);
  const cloud=(await api('/api/tasks?view=cloud')).data.tasks.map(t=>t.name);
  assert.deepEqual(cloud,['Kairos の画面を直す'],'紙の 🤖 処理中 は クラウドで に混ぜない');
  assert.ok((await api('/api/tasks?view=can')).data.tasks.some(t=>t.name==='Apple Watch の Trade In'),'他のタブには従来どおり出す');
  const dry=(await api('/api/entry/fill?dry=1','POST')).data;
  assert.deepEqual([dry.cloud.map(x=>x.name),dry.mac.map(x=>x.name),dry.cowork],[['saito-tools の棚卸しを直す'],['launchd の時刻を変える'],1]);
  assert.equal(JSON.parse((await db.prepare('SELECT payload FROM entities WHERE id=?').bind(ids[2]).first()).payload).properties.実行環境.multi_select.length,0,'dry は書かない');
  const fill=(await api('/api/entry/fill','POST')).data;
  assert.match(fill.summary,/クラウドに振った 1 本・Mac に振った 1 本・Cowork のまま 1 本/);
  const envOf=async id=>JSON.parse((await db.prepare('SELECT payload FROM entities WHERE id=?').bind(id).first()).payload).properties.実行環境.multi_select.map(o=>o.name);
  assert.deepEqual(await envOf(ids[2]),['クラウド']);assert.deepEqual(await envOf(ids[3]),['Mac']);assert.deepEqual(await envOf(ids[4]),[]);
  assert.deepEqual(await envOf(ids[0]),['クラウド'],'手で付けたものは触らない');
  const again=(await api('/api/entry/fill','POST')).data;
  assert.deepEqual([again.cloud.length,again.mac.length],[0,0],'2 回目は何もしない');
  // 使用率ログの表 (本文の table) を読む。タスクは USAGE_LOG_TASK_ID で差し替え
  const now=new Date(Date.now()+9*3600000),hm=now.toISOString().slice(0,10)+' '+now.toISOString().slice(11,16);
  const cell=s=>[{type:'text',text:{content:s},plain_text:s}];
  const tr=cs=>({object:'block',type:'table_row',table_row:{cells:cs.map(cell)}});
  await db.prepare('INSERT INTO entity_bodies VALUES(?,1)').bind(ids[4]).run();
  const put=await mf.dispatchFetch('https://kairos.test/api/data/blocks/'+ids[4]+'/children',{method:'PATCH',headers:{Authorization:'Bearer test-only-token','Content-Type':'application/json'},body:JSON.stringify({children:[{object:'block',type:'paragraph',paragraph:{rich_text:cell('所見')}},{object:'block',type:'table',table:{table_width:3,has_column_header:true,children:[tr(['日時(JST)','曜日','週間%']),tr(['2026-10-20 06:54','火','取得不可']),tr([hm,'木','12'])]}}]})});
  assert.equal(put.status,200,await put.clone().text());
  const wk=(await api('/api/entry/weekly?weeks=2')).data;
  assert.equal(wk.weeks.length,2);assert.equal(wk.weeks[1].launches.cloud,1);
  assert.equal(wk.weeks[1].lastUsagePct,12,'本文の表から週間% を拾う');assert.equal(wk.usageSamples,1);
  assert.equal((await api('/api/entry/rules')).data.version,1);
 }finally{await mf.dispose();}
});
