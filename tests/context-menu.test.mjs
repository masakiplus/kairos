import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
// 2026-11-03: 一覧の行の右クリックメニュー。項目はシートの操作のうち使われているものだけ (docs/design-notes.md)。action はシートと同じ名前
const html=readFileSync(new URL('../src/app.html',import.meta.url),'utf8');
const part=(from,to)=>html.slice(html.indexOf(from),html.indexOf(to));
const ctx={};runInNewContext(part('  // ---- 右クリックメニュー (','  // ---- end 右クリックメニュー ----')+';this.api={cmenuItems};',ctx);
const {cmenuItems}=ctx.api;
const keys=(t,dg='真実')=>[...cmenuItems(t,dg)].filter(x=>x!=='-').map(x=>x.m);
const sheetActions=new Set([...html.matchAll(/data-a="([^"]+)"/g)].map(m=>m[1]));

test('未完了の行: 完了・🤖 を先頭に、使われている操作だけ並ぶ',()=>{
 assert.deepEqual(keys({}),['done','ai','ai-update','mit','defer?days=1','defer?to=weekend','defer?to=nextweek','delegate?to=%E7%9C%9F%E5%AE%9F','skip','open']);
});
test('メニューの操作はすべてシートにもある操作 (Worker に新しい口を足さない)',()=>{
 for(const k of keys({}).concat(keys({mit:true}),keys({owner:'真実'}),keys({done:true}))){
  if(k==='ai'||k==='ai-update'||k==='open'||k.startsWith('delegate?to='))continue; // 🤖 と 詳細 は画面内、委任はシートの data-dg と同じ delegate?to=
  assert.ok(sheetActions.has(k)||k==='mit-clear',k);
 }
});
test('状態に合わせて出し分ける',()=>{
 assert.ok(keys({mit:true}).includes('mit-clear'));assert.ok(!keys({mit:true}).includes('mit'));
 assert.ok(keys({owner:'真実'}).includes('delegate?to='),'委任中は 自分に戻す');
 assert.ok(!keys({},null).some(k=>k.startsWith('delegate')),'委任先が無ければ出さない');
 assert.deepEqual(keys({done:true}),['reopen','open'],'完了済み (検索) は戻すか開くだけ');
});
test('先行待ちは 🤖 (進める・更新)・委任・詳細だけ押せる (シートと同じ制約)',()=>{
 const on=[...cmenuItems({blocked:true},'真実')].filter(x=>x!=='-'&&!x.off).map(x=>x.m);
 assert.deepEqual(on,['ai','ai-update','delegate?to=%E7%9C%9F%E5%AE%9F','open']);
});
