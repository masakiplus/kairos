import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
// 2026-11-03: 🔍 絞り込みシート (ラベル・コンテキスト・種類)。一覧の行に labels・kind を載せ、画面は 3 軸 AND で絞る
const idx=readFileSync(new URL('../src/index.js',import.meta.url),'utf8');
const html=readFileSync(new URL('../src/app.html',import.meta.url),'utf8');
const part=(from,to)=>html.slice(html.indexOf(from),html.indexOf(to));
const pageToTask=new Function('todayJst','AI_ACTIVE_MS','return '+idx.match(/function pageToTask\(page\) \{[\s\S]*?\n}\n/)[0])(()=>'2026-11-03',7200000);
const ctx={};runInNewContext(part('  // ---- 絞り込み (','  // ---- end 絞り込み ----')+';this.api={FILTER_VIEWS,filterOn,cleanFilter,filterMatch,applyFilter,filterOptions};',ctx);
const {FILTER_VIEWS,filterOn,cleanFilter,filterMatch,applyFilter,filterOptions}=ctx.api;
const T=(id,labels,env,kind,extra={})=>({id,labels,env,kind,...extra});
const rows=[T('a',['AI提案'],['スマホ'],'連絡'),T('b',['AI提案','Home'],['Mac'],'作業'),T('c',['Home'],['スマホ'],'支払い'),T('d',[],[],null),T('e',['Work'],['Mac'],'作業',{aiActive:true})];
const ids=ts=>ts.map(t=>t.id);

test('一覧の行に labels と kind が入る (読むだけ)',()=>{
 const t=pageToTask({id:'x',url:'u',properties:{'名前':{title:[{plain_text:'題'}]},'ラベル':{multi_select:[{name:'AI提案'},{name:'Home'}]},'種類':{select:{name:'連絡'}},'実行環境':{multi_select:[{name:'スマホ'}]}}});
 assert.deepEqual([...t.labels],['AI提案','Home']);assert.equal(t.kind,'連絡');assert.deepEqual([...t.env],['スマホ']);
 const e=pageToTask({id:'y',url:'u',properties:{}});
 assert.deepEqual([...e.labels],[]);assert.equal(e.kind,null);
});
test('3 軸は AND。未選択の軸は条件にしない',()=>{
 assert.deepEqual(ids(rows.filter(t=>filterMatch(t,{label:'AI提案'}))),['a','b']);
 assert.deepEqual(ids(rows.filter(t=>filterMatch(t,{label:'AI提案',env:'スマホ'}))),['a']);
 assert.deepEqual(ids(rows.filter(t=>filterMatch(t,{label:'Home',env:'スマホ',kind:'支払い'}))),['c']);
 assert.deepEqual(ids(rows.filter(t=>filterMatch(t,{kind:'作業'}))),['b','e']);
 assert.deepEqual(ids(rows.filter(t=>filterMatch(t,{}))),['a','b','c','d','e']);
});
test('🤖 処理中の行は絞り込み中も残す',()=>{
 assert.deepEqual(ids(applyFilter(rows,{label:'AI提案'},'today')),['a','b','e']);
});
test('役割・決める など一覧でないタブでは効かせない',()=>{
 for(const v of ['roles','review','deps','graph','quad'])assert.equal(applyFilter(rows,{label:'AI提案'},v),rows,v);
 for(const v of ['today','can','phone','doing','project','delegated','cloud','search'])assert.ok(FILTER_VIEWS.includes(v),v);
 assert.equal(applyFilter(rows,{},'today'),rows,'未選択なら元の配列のまま');
});
test('シートの件数は「その値を選んだら何件か」。選択中の値は 0 件でも残す',()=>{
 const o=filterOptions(rows,{env:'スマホ'},'label');
 assert.equal(o.all,2);assert.deepEqual(JSON.parse(JSON.stringify(o.opts)),[['AI提案',1],['Home',1],['Work',0]]);
 const k=filterOptions(rows,{kind:'請求'},'kind');
 assert.ok(k.opts.some(([v,n])=>v==='請求'&&n===0));
});
test('保存値の掃除: 未知の軸・空・文字列以外は落とす',()=>{
 assert.deepEqual({...cleanFilter({label:'AI提案',env:'',kind:3,area:'x'})},{label:'AI提案'});
 assert.deepEqual({...cleanFilter(null)},{});
 assert.equal(filterOn({}),false);assert.equal(filterOn({env:'Mac'}),true);
});
test('ヘッダーに絞り込みボタン。任せるAI はヘッダーから外してタスクのシートへ',()=>{
 const header=html.slice(html.indexOf('<header'),html.indexOf('</header>'));
 assert.match(header,/id="fltChip"/);assert.doesNotMatch(header,/aiProvider|任せるAI/);
 assert.match(html,/🤖 \$\{aiName\(\)\} に任せる \$\{aiSelectHtml\(\)\}/);
});
test('名前がカタカナの「カイロス」でも kairos リポジトリに渡す',()=>{
 const cloudRepo=new Function('return '+html.match(/  function cloudRepo\(t\) \{[\s\S]*?\n  }\n/)[0])();
 assert.equal(cloudRepo({name:'カイロスに絞り込みシートを付ける'}),'masakiplus/kairos');
 assert.equal(cloudRepo({name:'Kairos の修正'}),'masakiplus/kairos');
 assert.equal(cloudRepo({name:'日報の整理'}),'masakiplus/saito-tools');
});
