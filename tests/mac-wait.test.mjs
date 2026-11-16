import {readFileSync} from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
// 2026-11-17: 🖥 Mac待ち。AI の手番のまま Mac・ブラウザのつながるセッションを待つステータス (人対応 とは別)
const idx=readFileSync(new URL('../src/index.js',import.meta.url),'utf8');
const d1=readFileSync(new URL('../src/d1.js',import.meta.url),'utf8');
const mcp=readFileSync(new URL('../src/mcp.js',import.meta.url),'utf8');
const html=readFileSync(new URL('../src/app.html',import.meta.url),'utf8');
const passesView=new Function('PHONE_ENV_NAMES','CLOUD_ENV','return '+idx.match(/function passesView\([\s\S]*?\n}\n/)[0])(['スマホ'],'クラウド');
const today='2026-11-17';
const base={done:false,owner:null,projectIds:[],status:'Mac待ち',env:['Mac'],blocked:false,start:'2026-11-17'};
test('Mac待ち は今日系タブ (本人の一覧) に出さない',()=>{
 for(const v of ['today','can','phone','cloud'])assert.equal(passesView({...base,due:'2026-11-17'},v,today),false,v);
 assert.equal(passesView({...base,due:'2026-11-30',env:['クラウド']},'cloud',today),false);
});
test('着手中と view=mac には出す。開始日が先なら出さない',()=>{
 assert.equal(passesView(base,'doing',today),true);
 assert.equal(passesView(base,'mac',today),true);
 assert.equal(passesView({...base,start:'2026-11-20'},'mac',today),false);
 assert.equal(passesView({...base,status:'人対応'},'mac',today),false);
 assert.equal(passesView({...base,owner:'真実'},'mac',today),false,'委任中は出さない');
 assert.equal(passesView({...base,status:'未着手',due:'2026-11-30'},'can',today),true,'ほかのステータスは従来どおり');
});
test('PJ別・開始日なし には従来どおり出る',()=>{
 assert.equal(passesView({...base,projectIds:['p']},'project',today),true);
 assert.equal(passesView({...base,start:null},'nostart',today),true);
});
test('Worker: mac の操作・一覧・🤖 で進行中へ戻す',()=>{
 assert.match(idx,/\|human\|mac\|start\|/);
 assert.match(idx,/if \(action === "mac"\) \{/);
 assert.match(idx,/"AI処理開始": \{ date: null \}/);
 assert.match(idx,/mac: \{\n    filter: \{ and: \[NOT_DONE, \{ property: "ステータス", status: \{ equals: MAC_WAIT \} \}\] \}/);
 assert.match(idx,/cur\.status === "人対応" \|\| cur\.status === MAC_WAIT\) props\["ステータス"\] = \{ status: \{ name: "進行中" \} \}/);
 assert.doesNotMatch(idx.match(/async function wipCount[\s\S]*?\n}\n/)[0],/MAC_WAIT|Mac待ち/,'WIP には数えない');
});
test('D1: ステータスの選択肢を冪等に足す',()=>{
 assert.match(d1,/property:'ステータス',type:'status',option:\{id:'kairos-macwait',name:'Mac待ち'/);
 assert.match(d1,/'\.'\+type\+'\.options'/);
});
test('MCP: mac の操作と view、規約',()=>{
 assert.match(mcp,/enum: \["done", "skip", "dup", "reopen", "human", "mac", "ai_clear"\]/);
 assert.match(mcp,/"cloud", "mac", "doing"/);
 assert.match(mcp,/closing \|\| action === "mac"/);
 assert.match(mcp,/human ではなく mac/);
});
test('画面: 着手中の節・状態ボタン・行のチップ',()=>{
 assert.match(html,/\["mac", "Mac待ち", "🖥"\]/);
 assert.match(html,/"mach", mw\]/);
 assert.match(html,/mac: "Mac待ち" \}/);
 assert.match(html,/metaBtn\("mac"/);
});
test('D1: ステータスに Mac待ち を冪等に足し、既存の選択肢は変えない',async t=>{
 const {DatabaseSync}=await import('node:sqlite');
 const {initD1,ensureSchemaOptions}=await import('../src/d1.js');
 const sql=new DatabaseSync(':memory:');t.after(()=>sql.close());
 const DB={prepare(query){let args=[];return {bind(...v){args=v;return this;},async run(){return sql.prepare(query).run(...args);},async all(){return {results:sql.prepare(query).all(...args)};},async first(){return sql.prepare(query).get(...args)||null;}};},async batch(stmts){for(const s of stmts)await s.run();}};
 await initD1({DB});
 const ds='d'.repeat(32);
 const st=['未着手','人対応','進行中','待ち','完了'].map((name,i)=>({id:String(i),name,color:'default'}));
 sql.prepare('INSERT INTO entity_schemas VALUES(?,?,?)').run(ds,'tasks',JSON.stringify({properties:{ステータス:{type:'status',status:{options:st,groups:[]}},実行環境:{type:'multi_select',multi_select:{options:[]}}}}));
 await ensureSchemaOptions({DB});await ensureSchemaOptions({DB});
 const p=JSON.parse(sql.prepare('SELECT payload FROM entity_schemas WHERE id=?').get(ds).payload).properties;
 assert.deepEqual(p.ステータス.status.options.map(o=>o.name),['未着手','人対応','進行中','待ち','完了','Mac待ち']);
 assert.deepEqual(p.ステータス.status.options.slice(0,5),st);
 assert.ok(p.実行環境.multi_select.options.some(o=>o.name==='クラウド'),'multi_select の移行は従来どおり');
});
