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
  assert.match(html,/\$\("#add"\)\.hidden = view === "roles" \|\| view === "review" \|\| view === "habits";/);
  assert.match(html,/\.\.\.extra, \.\.\.\(pj \? \{ projectId: pj\.id \} : \{\}\)/);
  assert.match(html,/id="addOwner"/);
});
