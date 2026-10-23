import {readFileSync} from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
// 2026-10-24: 開始日が先のタスクが今日系タブ・🧔 本人の手番 に出ていた
const idx=readFileSync(new URL('../src/index.js',import.meta.url),'utf8');
const html=readFileSync(new URL('../src/app.html',import.meta.url),'utf8');
const PHONE_ENV_NAMES=['スマホ','iPhone'];
const passesView=new Function('PHONE_ENV_NAMES','return '+idx.match(/function passesView\([\s\S]*?\n}\n/)[0])(PHONE_ENV_NAMES);
const today='2026-10-24';
const base={done:false,owner:null,projectIds:[],status:'未着手',env:[],blocked:false};
test('先行待ちでも開始日が先なら 今日やる に出さない',()=>{
 const t={...base,blocked:true,start:'2026-10-30',due:'2026-10-20'};
 assert.equal(passesView(t,'today',today),false);
 assert.equal(passesView({...t,start:'2026-10-20'},'today',today),true,'開始日が来ていれば従来どおり薄く出す');
});
test('開始日が先の 人対応 は 今日系・着手中 に出さない',()=>{
 const t={...base,status:'人対応',start:'2026-10-26',due:'2026-10-26'};
 for(const v of ['today','can','phone','doing'])assert.equal(passesView(t,v,today),false,v);
 assert.equal(passesView({...t,projectIds:['p']},'project',today),true,'PJ別には出す');
});
test('🧔 本人の手番 の節は開始日が先のものを拾わない',()=>{
 const line=html.match(/const hu = tasks\.filter\(([^\n]*)\);/)[1];
 const pick=new Function('tasks','today','return tasks.filter('+line+')');
 const ts=[{status:'人対応',aiActive:false,start:'2026-10-26'},{status:'人対応',aiActive:false,start:'2026-10-24'},{status:'人対応',aiActive:false,start:null}];
 assert.deepEqual(pick(ts,today).map(t=>t.start),['2026-10-24',null]);
});
