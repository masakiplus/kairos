import {DatabaseSync} from 'node:sqlite';
import test from 'node:test';
import assert from 'node:assert/strict';
import {initD1,d1Notion} from '../src/d1.js';
// 片肺完了 (ステータス=完了 なのに 完了✓ が無い／完了✓ なのに ステータス=未着手) を書き込みの層で作らせない (2026-11-14)
async function setup(t){
 const sql=new DatabaseSync(':memory:');t.after(()=>sql.close());
 const DB={prepare(query){let args=[];return {bind(...v){args=v;return this;},async run(){return sql.prepare(query).run(...args);},async all(){return {results:sql.prepare(query).all(...args)};},async first(){return sql.prepare(query).get(...args)||null;}};},async batch(stmts){sql.exec('BEGIN');try{const out=[];for(const s of stmts)out.push(await s.all());sql.exec('COMMIT');return out;}catch(e){sql.exec('ROLLBACK');throw e;}}};
 const ds='d'.repeat(32),env={DB,TASKS_DATA_SOURCE_ID:ds,KAIROS_ORIGIN:'https://kairos.test'};
 await initD1(env);
 sql.prepare('INSERT INTO entity_schemas VALUES(?,?,?)').run(ds,'tasks',JSON.stringify({properties:{名前:{id:'title',type:'title'},完了:{id:'done',type:'checkbox'},完了日:{id:'dd',type:'date'},ステータス:{id:'st',type:'status'},開始日:{id:'sd',type:'date'}}}));
 t.mock.method(globalThis,'fetch',()=>{throw new Error('Notion must not be called');});
 const call=(path,method,body)=>d1Notion({...env},path,{method,...(body?{body:JSON.stringify(body)}:{})});
 const create=props=>call('/pages','POST',{parent:{data_source_id:ds},properties:{名前:{title:[{text:{content:'検証'}}]},...props}});
 const patch=(id,props)=>call('/pages/'+id,'PATCH',{properties:props});
 return {create,patch};
}
const today=new Date(Date.now()+9*3600e3).toISOString().slice(0,10);
const triple=p=>[p.properties.完了.checkbox,p.properties.ステータス?.status?.name ?? null,p.properties.完了日?.date?.start ?? null];
test('ステータス=完了 で作ったタスクは 完了✓ と 完了日 も入る',async t=>{
 const {create}=await setup(t);
 assert.deepEqual(triple(await create({ステータス:{status:{name:'完了'}}})),[true,'完了',today]);
 assert.deepEqual(triple(await create({完了:{checkbox:true}})),[true,'完了',today]);
 assert.deepEqual(triple(await create({ステータス:{status:{name:'未着手'}}})),[false,'未着手',null]);
 assert.deepEqual(triple(await create({})),[false,null,null]);
});
test('更新で片方だけ書かれても 3 点がそろう',async t=>{
 const {create,patch}=await setup(t);
 const a=await create({ステータス:{status:{name:'進行中'}}});
 assert.deepEqual(triple(await patch(a.id,{ステータス:{status:{name:'完了'}}})),[true,'完了',today]);
 const b=await create({});
 assert.deepEqual(triple(await patch(b.id,{完了:{checkbox:true}})),[true,'完了',today]);
 const c=await create({});
 assert.deepEqual(triple(await patch(c.id,{完了:{checkbox:true},完了日:{date:{start:'2026-10-17'}},ステータス:{status:{name:'完了'}}})),[true,'完了','2026-10-17']);
 // 完了済みへの無関係な更新は 完了日 を動かさない
 assert.deepEqual(triple(await patch(c.id,{開始日:{date:{start:'2026-11-01'}}})),[true,'完了','2026-10-17']);
});
test('完了済みのステータスだけを戻す書き込みは断り、戻すときは 3 点とも戻る',async t=>{
 const {create,patch}=await setup(t);
 const a=await create({ステータス:{status:{name:'完了'}}});
 await assert.rejects(patch(a.id,{ステータス:{status:{name:'未着手'}}}),/reopen/);
 await assert.rejects(patch(a.id,{完了:{checkbox:true},ステータス:{status:{name:'未着手'}}}),/3 点セット/);
 await assert.rejects(patch(a.id,{完了:{checkbox:false},ステータス:{status:{name:'完了'}}}),/3 点セット/);
 assert.deepEqual(triple(await patch(a.id,{開始日:{date:null}})),[true,'完了',today]);
 assert.deepEqual(triple(await patch(a.id,{完了:{checkbox:false}})),[false,'未着手',null]);
 const b=await create({ステータス:{status:{name:'完了'}}});
 assert.deepEqual(triple(await patch(b.id,{完了:{checkbox:false},完了日:{date:null},ステータス:{status:{name:'進行中'}}})),[false,'進行中',null]);
 assert.deepEqual(triple(await patch(b.id,{ステータス:{status:{name:'人対応'}}})),[false,'人対応',null]);
});
