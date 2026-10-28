import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {runInNewContext} from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {initD1,ensureSchemaOptions} from '../src/d1.js';
// 2026-10-29: 実行環境「クラウド」・「クラウドで」ビュー・🤖 の Claude Code クラウド行き
const src=name=>readFileSync(new URL('../src/'+name,import.meta.url),'utf8');
function sqliteDB(t){
 const sql=new DatabaseSync(':memory:');t.after(()=>sql.close());
 const DB={prepare(query){let args=[];return {bind(...v){args=v;return this;},async run(){return sql.prepare(query).run(...args);},async all(){return {results:sql.prepare(query).all(...args)};},async first(){return sql.prepare(query).get(...args)||null;}};},async batch(stmts){sql.exec('BEGIN');try{const out=[];for(const s of stmts)out.push(await s.all());sql.exec('COMMIT');return out;}catch(e){sql.exec('ROLLBACK');throw e;}}};
 return {sql,DB};
}
const optionNames=(sql,id)=>JSON.parse(sql.prepare('SELECT payload FROM entity_schemas WHERE id=?').get(id).payload).properties.実行環境.multi_select.options.map(o=>o.name);

test('選択肢の追加は冪等で、既存の選択肢と並び順を変えない',async t=>{
 const {sql,DB}=sqliteDB(t);await initD1({DB});
 const ds='d'.repeat(32),other='e'.repeat(32);
 const existing=[{id:'1',name:'自宅',color:'red'},{id:'2',name:'Mac',color:'gray'},{id:'3',name:'スマホ',color:'green'}];
 sql.prepare('INSERT INTO entity_schemas VALUES(?,?,?)').run(ds,'tasks',JSON.stringify({properties:{実行環境:{type:'multi_select',multi_select:{options:existing}}}}));
 sql.prepare('INSERT INTO entity_schemas VALUES(?,?,?)').run(other,'projects',JSON.stringify({properties:{実行環境:{type:'multi_select',multi_select:{options:[]}}}}));
 const task=JSON.stringify({id:'a'.repeat(32),properties:{実行環境:{type:'multi_select',multi_select:[{name:'Mac'}]}}});
 sql.prepare('INSERT INTO entities(id,ds,collection,payload) VALUES(?,?,?,?)').run('a'.repeat(32),ds,'tasks',task);
 await ensureSchemaOptions({DB});await ensureSchemaOptions({DB});
 assert.deepEqual(optionNames(sql,ds),['自宅','Mac','スマホ','クラウド']);
 const opts=JSON.parse(sql.prepare('SELECT payload FROM entity_schemas WHERE id=?').get(ds).payload).properties.実行環境.multi_select.options;
 assert.deepEqual(opts.slice(0,3),existing,'既存の選択肢は id・色ごとそのまま');
 assert.deepEqual(optionNames(sql,other),[],'tasks 以外のスキーマには触れない');
 assert.equal(sql.prepare('SELECT payload FROM entities').get().payload,task,'既存タスクの値は変えない');
});
test('実行環境の列が無いスキーマや、既に手で足した選択肢には何もしない',async t=>{
 const {sql,DB}=sqliteDB(t);await initD1({DB});
 const a='a'.repeat(32),b='b'.repeat(32);
 const noProp=JSON.stringify({properties:{名前:{type:'title'}}});
 sql.prepare('INSERT INTO entity_schemas VALUES(?,?,?)').run(a,'tasks',noProp);
 sql.prepare('INSERT INTO entity_schemas VALUES(?,?,?)').run(b,'tasks',JSON.stringify({properties:{実行環境:{type:'multi_select',multi_select:{options:[{name:'クラウド',color:'purple'},{name:'Mac'}]}}}}));
 await ensureSchemaOptions({DB});
 assert.equal(sql.prepare('SELECT payload FROM entity_schemas WHERE id=?').get(a).payload,noProp);
 assert.deepEqual(optionNames(sql,b),['クラウド','Mac']);
});

test('クラウドで: 実行環境にクラウドを含む着手可だけ (待ち・待機・先行待ちは除く)',()=>{
 const idx=src('index.js');
 const passesView=new Function('PHONE_ENV_NAMES','CLOUD_ENV','return '+idx.match(/function passesView\([\s\S]*?\n}\n/)[0])(['スマホ','iPhone'],'クラウド');
 const today='2026-10-29',base={done:false,owner:null,projectIds:[],status:'未着手',env:['クラウド'],blocked:false};
 assert.equal(passesView(base,'cloud',today),true);
 assert.equal(passesView({...base,env:['クラウド','Mac'],due:'2026-12-01'},'cloud',today),true,'期日が先でも出す (スマホで と同じ)');
 assert.equal(passesView({...base,env:['スマホ']},'cloud',today),false);
 assert.equal(passesView({...base,status:'待ち'},'cloud',today),false);
 assert.equal(passesView({...base,start:'2026-10-30'},'cloud',today),false);
 assert.equal(passesView({...base,blocked:true},'cloud',today),false);
 assert.equal(passesView({...base,owner:'家族'},'cloud',today),false);
 assert.equal(passesView({...base,env:['スマホ']},'phone',today),true,'スマホで は従来どおり');
});

test('本体API: 起動時に選択肢を足し、view=cloud が返り、シートのトグルでクラウドを付けられる',async()=>{
 const ds='d'.repeat(32),ids=['a'.repeat(32),'b'.repeat(32),'c'.repeat(32)];let outbound=0;
 const source=src('lab.js')+'\n'+src('d1.js').replace(/^import .*;$/m,'')+'\n'+src('icons.js').replaceAll('export const ', 'const ')+'\n'+['APP_HTML','SW_JS','MANIFEST'].map((name,i)=>'const '+name+'='+JSON.stringify(src(['app.html','sw.txt','manifest.webmanifest'][i]))+';').join('\n')+'\nconst {isMcpPath,mcpRoute}=(()=>{'+src('mcp.js').replace(/^export /gm,'')+'\nreturn {isMcpPath,mcpRoute};})();\n'+src('index.js').replace(/^import .*\n/gm,'');
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,compatibilityDate:'2026-09-01',d1Databases:['DB'],bindings:{APP_TOKEN:'test-only-token',DATA_BACKEND:'d1'},outboundService:()=>{outbound++;return new Response('blocked',{status:500});},script:source}));
 try{
  const db=await mf.getD1Database('DB');await initD1({DB:db});
  await db.prepare('INSERT INTO entity_schemas VALUES(?,?,?)').bind(ds,'tasks',JSON.stringify({properties:{名前:{type:'title'},完了:{type:'checkbox'},ステータス:{type:'status'},実行環境:{type:'multi_select',multi_select:{options:[{name:'Mac'},{name:'スマホ'},{name:'電話'}]}},担当:{type:'select',select:{options:[]}}}})).run();
  const row=(id,name,env)=>db.prepare('INSERT INTO entities(id,ds,collection,payload) VALUES(?,?,?,?)').bind(id,ds,'tasks',JSON.stringify({id,properties:{名前:{type:'title',title:[{plain_text:name}]},完了:{type:'checkbox',checkbox:false},ステータス:{type:'status',status:{name:'未着手'}},実行環境:{type:'multi_select',multi_select:env.map(name=>({name}))}}})).run();
  await row(ids[0],'クラウドの作業',['クラウド','Mac']);await row(ids[1],'スマホの作業',['スマホ']);await row(ids[2],'あとで付ける',['Mac']);
  const api=async(path,method='GET')=>{const r=await mf.dispatchFetch('https://kairos.test'+path,{method,headers:{Authorization:'Bearer test-only-token','Content-Type':'application/json'}});return {status:r.status,data:await r.json()};};
  const cloud=await api('/api/tasks?view=cloud');assert.equal(cloud.status,200);
  assert.deepEqual(cloud.data.tasks.map(t=>t.name),['クラウドの作業']);
  assert.deepEqual((await api('/api/tasks?view=phone')).data.tasks.map(t=>t.name),['スマホの作業'],'スマホで は従来どおり');
  const opts=JSON.parse((await db.prepare('SELECT payload FROM entity_schemas WHERE id=?').bind(ds).first()).payload).properties.実行環境.multi_select.options.map(o=>o.name);
  assert.deepEqual(opts,['Mac','スマホ','電話','クラウド']);
  const set=await api('/api/tasks/'+ids[2]+'/env?set='+encodeURIComponent('Mac,クラウド'),'POST');assert.equal(set.status,200);
  assert.deepEqual(set.data.task.env,['Mac','クラウド'],'スキーマにあるので弾かれない');
  const counts=await api('/api/tasks?views=today,can,phone,cloud');assert.equal(counts.data.views.cloud.tasks.length,2);
  assert.equal(outbound,0);
 }finally{await mf.dispose();}
});

// 🤖 の飛び先 (app.html の AI app routing を ai-handoff.test.mjs と同じ要領で切り出す)
const html=src('app.html');
const part=(from,to)=>html.slice(html.indexOf(from),html.indexOf(to));
const helpers=part('  // ---- AI app routing (','  // ---- end AI app routing ----');
const aiHrefSrc=html.match(/  function aiHref\(.*\n/)[0];
function harness({android=false,mac=false}={}){
 const copied=[],toasts=[];
 const context={URL,URLSearchParams,isAndroid:android,isMac:mac,ICONS:{claude:'c'},localStorage:{getItem:()=>null,setItem(){}},location:{origin:'https://kairos.test',href:''},
  navigator:{clipboard:{writeText:async s=>{copied.push(s);}}},toast:m=>toasts.push(m),window:{}};
 runInNewContext(helpers+aiHrefSrc,context);
 return {run:code=>runInNewContext(code,context),context,copied,toasts};
}
const qOf=href=>new URLSearchParams(href.slice(href.indexOf('?')+1).split('#')[0]);
const cloudTask={id:'a'.repeat(32),name:'ブログの記事を見直す',url:'https://kairos.test/?page='+'a'.repeat(32),env:['クラウド'],project:'おとく研究所'};

test('クラウドのタスクは claude.ai/code/new に文面とリポジトリを付けて渡す',()=>{
 const h=harness();h.context.task=cloudTask;
 const href=h.run('aiHref(task,"run")');
 assert.ok(href.startsWith('https://claude.ai/code/new?q='),href.slice(0,60));
 const q=qOf(href);
 assert.equal(q.get('repo'),'masakiplus/saito-tools');
 assert.ok(q.get('q').startsWith('リポジトリ masakiplus/saito-tools を接続し、ブランチを切って着手する。終わったら PR にする。Kairos タスク: '+cloudTask.url+'。説明と本文を先に読む\n'));
 assert.ok(q.get('q').includes('「ブログの記事を見直す」を進めてください'));
 assert.doesNotMatch(q.get('q'),/read_conversation/,'Claude Code にはチャットの道具が無い');
 assert.match(qOf(h.run('aiHref(task,"update")')).get('q'),/内容を見直して更新/);
});
test('Kairos／tasks-pwa なら masakiplus/kairos、saito-workers なら saito-workers を接続する',()=>{
 for(const [extra,repo] of [[{name:'Kairos に何かを足す'},'masakiplus/kairos'],[{name:'tasks-pwa の修正'},'masakiplus/kairos'],[{project:'kairos'},'masakiplus/kairos'],[{name:'Kairos の通知',project:'saito-workers 移行'},'masakiplus/kairos'],[{project:'saito-workers 移行'},'masakiplus/saito-workers'],[{name:'telegram-outbox (saito-workers) の修正'},'masakiplus/saito-workers']]){
  const h=harness();h.context.task={...cloudTask,...extra};
  const q=qOf(h.run('aiHref(task)'));
  assert.equal(q.get('repo'),repo,JSON.stringify(extra));
  assert.ok(q.get('q').startsWith('リポジトリ '+repo+' を接続'));
 }
});
test('Android はアプリへ intent、Mac はデスクトップ版の claude://code/new。クラウド以外は従来の claude.ai/new',()=>{
 const a=harness({android:true});a.context.task=cloudTask;
 const href=a.run('aiHref(task)');
 assert.ok(href.startsWith('intent://claude.ai/code/new?q='));assert.match(href,/package=com\.anthropic\.claude;S\.browser_fallback_url=https%3A%2F%2Fclaude\.ai%2Fcode%2Fnew%3Fq%3D/);
 const m=harness({mac:true});m.context.task=cloudTask;
 const mh=m.run('aiHref(task)'); assert.ok(mh.startsWith('claude://code/new?q='),mh.slice(0,40)); assert.equal(qOf(mh).get('repo'),'masakiplus/saito-tools'); { const c=harness({mac:true}); c.context.href=mh; assert.equal(c.run('copyCloudLink(href)'),true,'claude:// でもコピーする'); assert.equal(c.copied[0],qOf(mh).get('q')); }
 m.context.task={...cloudTask,env:['Mac']};
 assert.ok(m.run('aiHref(task)').startsWith('claude://claude.ai/new?q='));
 const w=harness();w.context.task={...cloudTask,env:[]};
 assert.ok(w.run('aiHref(task)').startsWith('https://claude.ai/new?q='));
});
test('前回のセッションがあれば続きを開き、ChatGPT などを選んでいればクラウド行きにしない',()=>{
 const h=harness();h.context.task={...cloudTask,aiSession:'https://claude.ai/code/session_x'};
 assert.equal(h.run('aiHref(task)'),'https://claude.ai/code/session_x');
 assert.ok(h.run('claudeHref(task,"run")').startsWith('https://claude.ai/code/new?'),'新しいチャットで始める もクラウド側');
 h.run('aiProvider="chatgpt"');h.context.task=cloudTask;
 assert.ok(h.run('aiHref(task)').startsWith('#ai-handoff='));
});
test('クラウド行きのリンクを押すと文面をクリップボードにも入れる',()=>{
 const h=harness();h.context.task=cloudTask;
 h.context.href=h.run('aiHref(task)');
 assert.equal(h.run('copyCloudLink(href)'),true);
 assert.equal(h.copied.length,1);assert.equal(h.copied[0],qOf(h.context.href).get('q'));assert.equal(h.toasts.length,1);
 h.context.href=harness({android:true}).run('aiHref('+JSON.stringify(cloudTask)+')');
 assert.equal(h.run('copyCloudLink(href)'),true);assert.equal(h.copied[1],h.copied[0],'intent でも同じ文面');
 for(const other of ['https://claude.ai/new?q=x','https://claude.ai/code/session_x','#ai-handoff=x','https://evil.test/claude.ai/code/new?q=x']){h.context.href=other;assert.equal(h.run('copyCloudLink(href)'),false,other);}
 assert.equal(h.copied.length,2);
});
