import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import test from 'node:test';
import assert from 'node:assert/strict';
import {initD1,d1Notion,matches,loadState,revDB} from '../src/d1.js';
function setup(t){
 const sql=new DatabaseSync(':memory:');t.after(()=>sql.close());
 const DB={prepare(query){let args=[];return {bind(...v){args=v;return this;},async run(){return sql.prepare(query).run(...args);},async all(){return {results:sql.prepare(query).all(...args)};},async first(){return sql.prepare(query).get(...args)||null;}};},async batch(stmts){sql.exec('BEGIN');try{const out=[];for(const s of stmts)out.push(await s.all());sql.exec('COMMIT');return out;}catch(e){sql.exec('ROLLBACK');throw e;}}};
 const ds='d'.repeat(32),env={DB,TASKS_DATA_SOURCE_ID:ds,KAIROS_ORIGIN:'https://kairos.test'};
 const ids=['a'.repeat(32),'b'.repeat(32)];
 const seed=async()=>{await initD1(env);sql.prepare('INSERT INTO entity_schemas VALUES(?,?,?)').run(ds,'tasks',JSON.stringify({properties:{名前:{id:'title',type:'title'},完了:{id:'done',type:'checkbox'},先行タスク:{id:'pre',type:'relation',relation:{data_source_id:ds,dual_property:{synced_property_name:'後続タスク'}}},後続タスク:{id:'post',type:'relation',relation:{data_source_id:ds,dual_property:{synced_property_name:'先行タスク'}}}}}));for(const id of ids)sql.prepare('INSERT INTO entities(id,ds,collection,payload) VALUES(?,?,?,?)').run(id,ds,'tasks',JSON.stringify({id,url:'https://www.notion.so/'+id,properties:{名前:{type:'title',title:[{plain_text:id[0]}]},完了:{type:'checkbox',checkbox:false},先行タスク:{type:'relation',relation:[]},後続タスク:{type:'relation',relation:[]}}}));};
 return {sql,env,ids,ds,seed};
}
test('D1だけで一覧・作成・更新・完了・取り消しができる',async t=>{
 const {sql,env,ids,ds,seed}=setup(t);await seed();
 t.mock.method(globalThis,'fetch',()=>{throw new Error('Notion must not be called');});
 let q=await d1Notion(env,'/data_sources/'+ds+'/query',{method:'POST',body:JSON.stringify({filter:{property:'完了',checkbox:{equals:false}},page_size:1})});
 assert.equal(q.results.length,1);assert.ok(q.next_cursor);
 const p=await d1Notion(env,'/pages/'+ids[0],{method:'PATCH',body:JSON.stringify({properties:{完了:{checkbox:true},完了日:{date:{start:'2026-10-17'}},ステータス:{status:{name:'完了'}}}})});
 assert.equal(p.properties.完了.checkbox,true);assert.equal(p.properties.ステータス.status.name,'完了');
 await d1Notion(env,'/pages/'+ids[0],{method:'PATCH',body:JSON.stringify({properties:{完了:{checkbox:false},完了日:{date:null},ステータス:{status:{name:'未着手'}}}})});
 assert.equal((await d1Notion(env,'/pages/'+ids[0])).properties.完了.checkbox,false);
 const created=await d1Notion(env,'/pages',{method:'POST',body:JSON.stringify({parent:{data_source_id:ds},properties:{名前:{title:[{text:{content:'日本語の新規'}}]}}})});
 assert.equal(created.properties.名前.title[0].plain_text,'日本語の新規');
 assert.match(created.url,/^https:\/\/kairos.test\/\?page=/);
 assert.equal(sql.prepare('select count(*) n from entities').get().n,3);
});
test('依存の双方向更新と先行完了による着手可否を即時計算する',async t=>{
 const {env,ids,seed}=setup(t);await seed();
 await d1Notion(env,'/pages/'+ids[1],{method:'PATCH',body:JSON.stringify({properties:{先行タスク:{relation:[{id:ids[0]}]}}})});
 let rows=(await loadState(env)).rows;
 assert.equal(rows.get(ids[1]).page.properties.先行未完了数.rollup.number,1);
 assert.equal(rows.get(ids[1]).page.properties.着手可否.formula.string,'先行待ち');
 assert.equal(rows.get(ids[0]).page.properties.後続タスク.relation[0].id,ids[1]);
 await d1Notion(env,'/pages/'+ids[0],{method:'PATCH',body:JSON.stringify({properties:{完了:{checkbox:true}}})});
 rows=(await loadState(env)).rows;
 assert.equal(rows.get(ids[1]).page.properties.着手可否.formula.string,'着手可');
 await d1Notion(env,'/pages/'+ids[1],{method:'PATCH',body:JSON.stringify({properties:{先行タスク:{relation:[]}}})});
 assert.equal((await loadState(env)).rows.get(ids[0]).page.properties.後続タスク.relation.length,0);
});
test('未対応の条件と未移行の本文を黙って空として返さない',async t=>{
 const {env,seed,ids}=setup(t);await seed();
 assert.throws(()=>matches({properties:{}},{property:'名前',title:{unsupported:true}}),/Unsupported/);
 await assert.rejects(d1Notion(env,'/blocks/'+ids[0]+'/children'),/not been migrated/);
});

test('本文追加は日本語と子ブロックを保持し、循環依存を拒否する',async t=>{
 const {sql,env,ids,seed}=setup(t);await seed();
 sql.prepare('INSERT INTO entity_bodies VALUES(?,1)').run(ids[0]);
 await d1Notion(env,'/blocks/'+ids[0]+'/children',{method:'PATCH',body:JSON.stringify({children:[{type:'toggle',toggle:{rich_text:[{text:{content:'日本語'}}],children:[{type:'paragraph',paragraph:{rich_text:[{text:{content:'子の本文'}}]}}]}}]})});
 const root=await d1Notion(env,'/blocks/'+ids[0]+'/children');
 assert.equal(root.results[0].toggle.rich_text[0].plain_text,'日本語');
 const child=await d1Notion(env,'/blocks/'+root.results[0].id+'/children');
 assert.equal(child.results[0].paragraph.rich_text[0].plain_text,'子の本文');
 await d1Notion(env,'/pages/'+ids[1],{method:'PATCH',body:JSON.stringify({properties:{先行タスク:{relation:[{id:ids[0]}]}}})});
 await assert.rejects(d1Notion(env,'/pages/'+ids[0],{method:'PATCH',body:JSON.stringify({properties:{先行タスク:{relation:[{id:ids[1]}]}}})}),/cycle/);
});

test('ページ作成時の本文とrelationの逆側も同じ書き込みで保存する',async t=>{
 const {env,ids,ds,seed}=setup(t);await seed();
 const created=await d1Notion(env,'/pages',{method:'POST',body:JSON.stringify({parent:{data_source_id:ds},properties:{名前:{title:[{text:{content:'新規'}}]},先行タスク:{relation:[{id:ids[0]}]}},children:[{type:'paragraph',paragraph:{rich_text:[{text:{content:'起票時の本文'}}]}}]})});
 const body=await d1Notion(env,'/blocks/'+created.id+'/children');assert.equal(body.results[0].paragraph.rich_text[0].plain_text,'起票時の本文');
 const pre=await d1Notion(env,'/pages/'+ids[0]);assert.ok(pre.properties.後続タスク.relation.some(r=>r.id===created.id));
});

test('同時の一覧リクエストで読取スナップショットを共有する',async t=>{
 const {env,ds,seed}=setup(t);await seed();let calls=0;const original=env.DB.batch;
 env.DB.batch=async stmts=>{calls++;return original(stmts);};
 await Promise.all(Array.from({length:7},()=>d1Notion({...env},'/data_sources/'+ds+'/query',{method:'POST',body:'{}'})));
 assert.equal(calls,1);
});

test('別の口からの更新は指紋で検知し、変化がなければ解析済みの写しを使い回す',async t=>{
 const {sql,env,ids,ds,seed}=setup(t);await seed();
 t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-10-18T03:00:00Z')});
 let calls=0;const original=env.DB.batch;env.DB.batch=async stmts=>{calls++;return original(stmts);};
 const names=async()=>(await d1Notion({...env},'/data_sources/'+ds+'/query',{method:'POST',body:'{}'})).results.map(r=>r.properties.名前.title.map(x=>x.plain_text).join('')).sort();
 const before=await names();assert.equal(calls,1);
 t.mock.timers.tick(2000);
 assert.deepEqual(await names(),before);assert.equal(calls,1,'変化がなければ再読込しない');
 const row=JSON.parse(sql.prepare('SELECT payload FROM entities WHERE id=?').get(ids[0]).payload);
 row.properties.名前={id:'title',type:'title',title:[{type:'text',text:{content:'別端末で変更'},plain_text:'別端末で変更'}]};
 await revDB(env.DB).prepare('UPDATE entities SET payload=?,revision=revision+1 WHERE id=?').bind(JSON.stringify(row),ids[0]).run();
 t.mock.timers.tick(2000);
 assert.ok((await names()).includes('別端末で変更'),'他の isolate の更新を拾う');assert.equal(calls,3,'書き込み1回＋再読込1回');
 t.mock.timers.tick(24*3600*1000);
 await names();assert.equal(calls,4,'日付が変われば派生値のために再読込する');
});

test('書き込みは1行の rev を進め、読み取りだけでは進めない（読み取り枠の節約）',async t=>{
 const {sql,env,ids,seed}=setup(t);await seed();
 const db=revDB(env.DB),rev=()=>Number(sql.prepare("SELECT value FROM storage_control WHERE key='rev'").get().value);
 const r0=rev();
 await db.prepare('SELECT id FROM entities').all();
 await db.batch([db.prepare('SELECT COUNT(*) n FROM entities')]);
 assert.equal(rev(),r0,'読み取りでは進めない');
 await db.prepare('UPDATE entities SET revision=revision+1 WHERE id=?').bind(ids[0]).run();
 assert.equal(rev(),r0+1);
 await db.batch([db.prepare('UPDATE entities SET revision=revision+1 WHERE id=?').bind(ids[1]),db.prepare('SELECT 1')]);
 assert.equal(rev(),r0+2,'書き込みを含むバッチは1回進める');
 assert.equal(revDB(db),db,'二重に包まない');
});
