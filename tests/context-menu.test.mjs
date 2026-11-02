import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
// 2026-11-03: 一覧の行の右クリックメニュー。todo・wait はシートの 🚦 状態 (テンプレートで生成) にある。項目はシートの操作から使われているものだけ、シートと同じ操作名 (act の action) を使う
const html=readFileSync(new URL('../src/app.html',import.meta.url),'utf8');
const part=(from,to)=>html.slice(html.indexOf(from),html.indexOf(to));
const ctx={};runInNewContext(part('  // ---- 右クリックメニュー (','  // ---- end 右クリックメニュー ----')+';this.api={cmenuItems};',ctx);
const {cmenuItems}=ctx.api;
const keys=(t)=>[...cmenuItems(t)].filter(x=>x!=='-').map(x=>x.m);
const sheetActions=new Set([...html.matchAll(/data-a="([^"]+)"/g)].map(m=>m[1]));

test('未完了の行: 主な操作が頻度順に並ぶ',()=>{
 assert.deepEqual(keys({}),['done','ai','mit','defer?days=1','defer?to=weekend','defer?to=nextweek','wait','skip','open']);
});
test('メニューの操作はすべてシートにもある操作 (Worker に新しい口を足さない)',()=>{
 for(const k of keys({}).concat(keys({mit:true}),keys({status:'待ち'}),keys({done:true}))){
  if(k==='ai'||k==='open')continue;
  assert.ok(sheetActions.has(k)||['mit-clear','todo','wait'].includes(k),k);
 }
});
test('状態に合わせて出し分ける',()=>{
 assert.ok(keys({mit:true}).includes('mit-clear'));assert.ok(!keys({mit:true}).includes('mit'));
 assert.ok(keys({status:'待ち'}).includes('todo'));assert.ok(!keys({status:'待ち'}).includes('wait'));
 assert.deepEqual(keys({done:true}),['reopen','open'],'完了済み (検索) は戻すか開くだけ');
});
test('先行待ちは AI と詳細だけ押せる (シートと同じ制約)',()=>{
 const on=[...cmenuItems({blocked:true})].filter(x=>x!=='-'&&!x.off).map(x=>x.m);
 assert.deepEqual(on,['ai','open']);
});
