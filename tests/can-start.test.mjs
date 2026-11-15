import {readFileSync} from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
// 2026-11-15: 今日できる を期日の 7 日窓から開始日基準へ。開始日が空のタスクは起票時に既定を入れる
const idx=readFileSync(new URL('../src/index.js',import.meta.url),'utf8');
const d1=readFileSync(new URL('../src/d1.js',import.meta.url),'utf8');
const html=readFileSync(new URL('../src/app.html',import.meta.url),'utf8');
const passesView=new Function('PHONE_ENV_NAMES','CLOUD_ENV','return '+idx.match(/function passesView\([\s\S]*?\n}\n/)[0])(['スマホ'],'クラウド');
const today='2026-11-15';
const base={done:false,owner:null,projectIds:[],status:'未着手',env:[],blocked:false,start:'2026-11-15'};
test('開始日が来ていれば期日が 8 日以上先でも 今日できる に出す',()=>{
 assert.equal(passesView({...base,due:'2026-12-13'},'can',today),true);
 assert.equal(passesView({...base,due:'2026-11-16'},'can',today),true);
 assert.equal(passesView({...base,due:null},'can',today),true);
});
test('期日が今日以前は 今日やる 側、開始日が先は出さない',()=>{
 assert.equal(passesView({...base,due:'2026-11-15'},'can',today),false);
 assert.equal(passesView({...base,due:'2026-11-10'},'can',today),false);
 assert.equal(passesView({...base,start:'2026-11-16',due:'2026-11-30'},'can',today),false);
 assert.equal(passesView({...base,status:'待ち',due:'2026-11-30'},'can',today),false);
});
test('派生値の 前倒し候補 から 7 日窓が消えている',()=>{
 assert.equal((d1.match(/'前倒し候補':ready==='着手可'&&!excluded&&\(!due\|\|due>today\)\?'候補':''/g)||[]).length,2);
 assert.ok(!/due<=inWeek\)\)\?'候補'|due<=week\)\)\?'候補'/.test(d1));
});
test('起票時の開始日の既定',()=>{
 const src=d1.match(/function taskStartDefault\([\s\S]*?\n}\n/)[0];
 const f=new Function('return '+src)();
 const defs={'開始日':{type:'date'}};
 const t0=new Date(Date.now()+9*3600000).toISOString().slice(0,10);
 assert.equal(f({},defs)['開始日'].date.start,t0,'空なら今日');
 assert.equal(f({'期日':{date:{start:'2020-01-02'}}},defs)['開始日'].date.start,'2020-01-02','期日が過去ならその日');
 assert.equal(f({'期日':{date:{start:'2099-01-02'}}},defs)['開始日'].date.start,t0,'期日が先でも今日');
 assert.equal(f({'開始日':{date:{start:'2099-01-01'}}},defs)['開始日'].date.start,'2099-01-01','指定は触らない');
 assert.equal(f({'完了':{checkbox:true}},defs)['開始日'],undefined,'完了で作る行は触らない');
 assert.equal(f({},{})['開始日'],undefined,'開始日の列が無い DB は触らない');
});
test('画面: 開始日なし 節と 今日から チップ',()=>{
 assert.match(html,/"nost", tasks\.filter\(\(t\) => !t\.start\)/);
 assert.match(html,/data-startnow/);
 assert.match(html,/!t\.start && !t\.done && !t\.blocked && !t\.aiActive \?/,'AI 処理中のカードには出さない');
 assert.match(html,/async function startNow\(t\)/);
});
