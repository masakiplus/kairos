import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
// 2026-11-05: 着手中タブの見やすさ (Decisions 7515ec1f)。A 場所で小分け・B 次の一手・C 待ちにできそう・D 親子を畳む・E 重複?・F 内訳メーター
const idx=readFileSync(new URL('../src/index.js',import.meta.url),'utf8');
const html=readFileSync(new URL('../src/app.html',import.meta.url),'utf8');
const part=(from,to)=>html.slice(html.indexOf(from),html.indexOf(to));
const pageToTask=new Function('todayJst','AI_ACTIVE_MS','return '+idx.match(/function pageToTask\(page\) \{[\s\S]*?\n}\n/)[0])(()=>'2026-11-05',7200000);
const wipRows=new Function('return '+idx.match(/function wipRows\(rows\) \{[\s\S]*?\n}\n/)[0])();
const ctx={};runInNewContext(part('  // ---- 着手中 (','  // ---- end 着手中 ----')+';this.api={nextStep,placeKey,groupByPlace,looksWaiting,foldParents,dupPairs,wipSummary,ageDays,cellCol,placeGrid,cellMatch};',ctx);
const {nextStep,placeKey,groupByPlace,looksWaiting,foldParents,dupPairs,wipSummary,ageDays,cellCol,placeGrid,cellMatch}=ctx.api;
const T=(id,extra={})=>({id,name:id,env:[],status:'人対応',parentIds:[],projectIds:[],rawDesc:'',...extra});
const ids=ts=>ts.map(t=>t.id);

test('親アイテム を parentIds で読む',()=>{
 const t=pageToTask({id:'c',url:'u',properties:{'親アイテム':{relation:[{id:'p'}]}}});
 assert.deepEqual([...t.parentIds],['p']);
 assert.deepEqual([...pageToTask({id:'x',url:'u',properties:{}}).parentIds],[]);
});
test('WIP の件数は 子が着手中の親を数えない (サーバー)',()=>{
 const rows=[T('p'),T('c',{parentIds:['p']}),T('z')];
 assert.deepEqual(ids(wipRows(rows)),['c','z']);
});
test('B 次の一手: 人対応 行を優先、なければ 何を の先頭。留意 は切る',()=>{
 assert.equal(nextStep(T('a',{rawDesc:'人対応: 夜便が届くのを確かめたら完了\nなぜ: x\n何を: y'})),'夜便が届くのを確かめたら完了');
 assert.equal(nextStep(T('b',{rawDesc:'なぜ: x\n何を: 箱を持って店頭で売る。留意: 身分証'})),'箱を持って店頭で売る。');
 assert.equal(nextStep(T('c',{rawDesc:'何を: '+'あ'.repeat(60)})).length,48);
 assert.equal(nextStep(T('d')),'');
});
test('A 場所: 外出 → 道具 → 自宅 の順。いまできる組を先に',()=>{
 assert.equal(placeKey(T('a',{env:['自宅','スマホ']}),'スマホ'),'📱 スマホ');
 assert.equal(placeKey(T('b',{env:['外出','スマホ']}),'スマホ'),'🚶 外出');
 assert.equal(placeKey(T('c',{env:['Mac','早朝']}),'スマホ'),'💻 Mac');
 assert.equal(placeKey(T('d',{env:['真実と']}),'スマホ'),'🌐 どこでも');
 const rows=[T('m',{env:['Mac']}),T('o',{env:['外出']}),T('p',{env:['スマホ']})];
 const why=t=>t.env.includes('外出')?'外出で':'';
 const g=groupByPlace(rows,'スマホ',why);
 assert.deepEqual([...g.map(x=>x.key)],['💻 Mac','📱 スマホ','🚶 外出'],'いまできない 外出 は後ろ');
 assert.equal(g[0].now,1);assert.equal(g[2].now,0);
});
test('C 待ちにできそう: 届く・返事を待つ など。🤖 処理中と既に待ちは除く',()=>{
 assert.equal(looksWaiting(T('a',{rawDesc:'人対応: 夜便が届くのを確かめたら完了'})),true);
 assert.equal(looksWaiting(T('b',{rawDesc:'何を: Gmail の返信を確認し、未返信なら電話する'})),false,'自分で確かめて電話する手番は待ちではない');
 assert.equal(looksWaiting(T('c',{rawDesc:'人対応: 届くのを確かめたら完了',aiActive:true})),false);
 assert.equal(looksWaiting(T('d',{rawDesc:'何を: 返事を待つ',status:'待ち'})),false);
});
test('D 親子: 子がいれば親を畳み、子に親を持たせる。🤖・⭐ の親は畳まない',()=>{
 const f=foldParents([T('p'),T('c',{parentIds:['p']}),T('z')]);
 assert.deepEqual(ids(f.shown),['c','z']);assert.equal(f.parentOf.get('c').id,'p');
 assert.deepEqual(ids(foldParents([T('p',{aiActive:true}),T('c',{parentIds:['p']})]).shown),['p','c']);
 assert.deepEqual(ids(foldParents([T('p',{mit:true}),T('c',{parentIds:['p']})]).shown),['p','c']);
 assert.deepEqual(ids(foldParents([T('c',{parentIds:['gone']})]).shown),['c'],'親が一覧にいなければそのまま');
});
test('E 重複?: 11/5 の実データで Grok の 2 件だけが当たる。親子・別 PJ は除く',()=>{
 const P='pj-blog';
 const rows=[
  T('zev',{name:'都ZEVの審査状況の返信を確認する（未返信なら電話）'}),
  T('memo',{name:'X PremiumとGrokの使い分けの続編に載せる体験メモを書く',projectIds:[P]}),
  T('g1',{name:'車でGrokと車内Wi-Fiを実際に試し、記事2本に足す数字と写真を取る',projectIds:[P]}),
  T('g2',{name:'おとく研究所: 車で Grok と Wi-Fi 運用を試して追記の材料を取る',projectIds:[P]}),
  T('aw',{name:'Apple Watch Ultra 2 をじゃんぱらで売る'}),
  T('aw1',{name:'①じゃんぱらの店頭で Apple Watch Ultra 2 を売る',parentIds:['aw']}),
  T('sbj',{name:'SBJ ANYローンの繰上げ手数料・最低金額・返済額軽減型の可否を確かめる'}),
  T('loan',{name:'ローン条件の改善を1件進める の記録の入口を作る（Dreamtime の半自動判定に足す）'}),
 ];
 const d=dupPairs(rows);
 assert.deepEqual([...d.keys()].sort(),['g1','g2']);assert.equal(d.get('g1').id,'g2');
 const other=[T('a',{name:'車でGrokと車内Wi-Fiを試す',projectIds:['x']}),T('b',{name:'車でGrokと車内Wi-Fiを試す',projectIds:['y']})];
 assert.equal(dupPairs(other).size,0,'別 PJ どうしは重複にしない');
});
test('F 内訳: 委任・開始日が先・子のいる親を除いて数える',()=>{
 const rows=[T('a',{aiActive:true,status:'進行中'}),T('b'),T('c',{status:'進行中',mit:true}),T('p'),T('k',{parentIds:['p']}),T('o',{owner:'真実'}),T('f',{start:'2026-12-10'}),T('w',{rawDesc:'人対応: 届くのを確かめたら完了'})];
 const w=wipSummary(rows,'2026-11-05');
 assert.deepEqual({...w},{count:5,ai:1,hu:3,doing:1,mit:1,waitish:1});
});
test('開始からの日数は 3 日以上だけ',()=>{
 assert.equal(ageDays(T('a',{start:'2026-10-29'}),'2026-11-05'),7);
 assert.equal(ageDays(T('b',{start:'2026-11-04'}),'2026-11-05'),0);
 assert.equal(ageDays(T('c'),'2026-11-05'),0);
});
test('画面: 着手中だけに次の一手・メーター・場所の小見出しを出す',()=>{
 assert.match(html,/doingCtx && nextStep\(t\) \? `<div class="nx">/);
 assert.match(html,/list\.innerHTML = metaHtml\(view\) \+ \(wipSum \? wipMeterHtml\(wipSum\) : ""\)/);
 assert.match(html,/view === "doing" \? groupByPlace\(hu, PHONE_ENV, unavailWhy\)/);
 assert.match(html,/v === "doing" \? foldParents\(r\)\.shown\.length/,'タブの件数も親子を 1 件に');
});
test('マス目: 行=場所 (順は固定)、列=🧔/▶/🤖。いまできる行は now>0',()=>{
 const rows=[T('o1',{env:['外出']}),T('o2',{env:['外出'],status:'進行中'}),T('m1',{env:['Mac']}),T('m2',{env:['Mac'],aiActive:true,status:'進行中'}),T('p1',{env:['スマホ']})];
 const why=t=>t.env.includes('外出')?'外出で':'';
 const g=placeGrid(rows,'スマホ',why);
 assert.deepEqual([...g.map(r=>r.key)],['🚶 外出','💻 Mac','📱 スマホ'],'いまできなくても並びは変えない');
 const out=g[0];assert.equal(out.now,0);assert.equal(out.total,2);assert.deepEqual([...out.cells.hu.map(t=>t.id)],['o1']);assert.deepEqual([...out.cells.doing.map(t=>t.id)],['o2']);
 assert.deepEqual([...g[1].cells.ai.map(t=>t.id)],['m2']);assert.equal(g[1].now,2);
 assert.equal(cellCol(T('x',{aiActive:true})),'ai','🤖 処理中は 人対応 でも AI の列');
});
test('マス目の絞り込み: マス・場所の行だけ・列だけ',()=>{
 const o=T('o',{env:['外出']}),m=T('m',{env:['Mac'],status:'進行中'});
 assert.equal(cellMatch(o,{place:'🚶 外出',col:'hu'},'スマホ'),true);
 assert.equal(cellMatch(o,{place:'🚶 外出',col:'doing'},'スマホ'),false);
 assert.equal(cellMatch(m,{place:'💻 Mac',col:null},'スマホ'),true);
 assert.equal(cellMatch(m,{place:null,col:'hu'},'スマホ'),false);
});
test('画面: マス目は着手中だけ、絞る前の行で数え、タブ移動で外す',()=>{
 assert.match(html,/gridH = gridHtml\(placeGrid\(tasks, PHONE_ENV, unavailWhy\), doingCell\);[^\n]*\n\s*if \(doingCell\) tasks = tasks\.filter/);
 assert.match(html,/if \(viewChanged\) doingCell = null;/);
 assert.match(html,/JSON\.stringify\(doingCell\), sigOf\(tasks\)/,'選んだマスが変われば描き直す');
});
