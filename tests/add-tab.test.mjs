import {readFileSync} from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
// 2026-11-15: 追加欄をタブごとに変える。足したタスクがそのタブの条件 (passesView) を満たすこと
const idx=readFileSync(new URL('../src/index.js',import.meta.url),'utf8');
const html=readFileSync(new URL('../src/app.html',import.meta.url),'utf8');
const grab=(re)=>idx.match(re)[0];
const {ADD_TAB_DEFAULTS,addDefaults,passesView}=new Function('PHONE_ENV_NAMES','CLOUD_ENV',
  grab(/const ADD_TAB_DEFAULTS = \{[\s\S]*?\n\};\n/)+grab(/function addDefaults\(tab, body = \{\}\) \{[^\n]*\n/)+grab(/function passesView\(t, view, today\) \{[\s\S]*?\n}\n/)+
  'return {ADD_TAB_DEFAULTS,addDefaults,passesView};')(['スマホ','iPhone'],'クラウド');
const today='2026-11-15';
// quickAdd が作るタスクの形 (index.js と同じ規則) を再現する
const made=(opts)=>({id:'x',done:false,owner:opts.owner||null,projectIds:[],status:opts.status||'未着手',start:today,due:opts.due?today:null,blocked:false,env:['スマホ','自宅']});

test('受け付けるタブは 今日やる・着手中・委任・買い物 の4つ。ほかは既定なし',()=>{
  assert.deepEqual(Object.keys(ADD_TAB_DEFAULTS).sort(),['delegated','doing','shop','today']);
  assert.deepEqual(addDefaults('can'),{});assert.deepEqual(addDefaults('project'),{});assert.deepEqual(addDefaults(undefined),{});
  assert.deepEqual(addDefaults('__proto__'),{});
});
test('足したタスクがそのタブに残る',()=>{
  for(const v of ['today','doing','delegated','can']){
    const t=made(addDefaults(v,{owner:'真実'}));
    assert.equal(passesView(t,v,today),true,v);
  }
});
test('今日できるで足したものは今日やるに出ない (期日を入れない)',()=>{
  assert.equal(passesView(made(addDefaults('can')),'today',today),false);
});
test('委任は担当が空なら null (受け口が 400 を返す)',()=>{
  assert.equal(addDefaults('delegated',{}).owner,null);
  assert.equal(addDefaults('delegated',{owner:' 真実 '}).owner,'真実');
});
test('画面: 買い物タブで追加欄を出し、tab を送る',()=>{
  assert.match(html,/\$\("#add"\)\.hidden = false; syncAddBar\(\);/);
  assert.match(html,/\.\.\.extra, \.\.\.\(pj \? \{ projectId: pj\.id \} : \{\}\)/);
  assert.match(html,/id="addOwner"/);
});

// 2026-11-15 (2): 決める=Decisions の未決、習慣=Habits の提案中、役割=タスクを作って今週の石に置く
const fnBody=(name)=>idx.match(new RegExp('async function '+name+'\\(env, name\\) \\{[\\s\\S]*?\\n}\\n'))[0];
test('決めるタブの追加は Decisions に 提案中・未決・種別 手動 で作る (案の行なし＝AI が先に調べる)',()=>{
  const b=fnBody('quickAddDecision');
  assert.match(b,/DECISIONS_DATA_SOURCE_ID/);
  for(const k of ['"状態": { select: { name: "提案中" } }','"決定": { select: { name: "未決" } }','"種別": { select: { name: "手動" } }']) assert.ok(b.includes(k),k);
});
test('習慣タブの追加は Habits に 提案中 で作る (有効化は棚卸しで本人)',()=>{
  const b=fnBody('quickAddHabit');
  assert.match(b,/HABITS_DATA_SOURCE_ID/);
  assert.ok(b.includes('"状態": { select: { name: "提案中" } }'));
  assert.ok(!b.includes('"有効"'));
});
test('役割タブ: roleId を確かめてから作り、setRoleGoal で今週の石に置く',()=>{
  const i=idx.indexOf('if (body.tab === "roles") {'); assert.ok(i>0);
  const seg=idx.slice(i,i+900);
  assert.ok(seg.indexOf('unknown role')<seg.indexOf('quickAdd('),'役割を確かめてからタスクを作る');
  assert.match(seg,/setRoleGoal\(env, roleId, task\.id\)/);
  assert.match(seg,/roleError/,'石を置けなくても 201 で返し、再送で二重にしない');
});
test('画面: 役割タブは終わっていない石を置き換える前に確かめる',()=>{
  assert.match(html,/st\.state !== "done" && !confirm\(/);
  assert.doesNotMatch(html,/st && st\.taskId && st\.state !== "done"/,'自由文の目標も確かめる');
  assert.match(html,/id="addRole"/);
});

test('setRoleGoal: 書式外の自由文の目標も補足に残す',()=>{
  const seg=idx.slice(idx.indexOf('async function setRoleGoal'),idx.indexOf('async function setRoleGoal')+1200);
  assert.match(seg,/前の目標「\$\{prev\.slice\(0, 80\)\}」/);
});
