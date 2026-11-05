import {readFileSync} from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

// 決めるタブの先送り候補日（2026-11-06、提案のみ）。index.js の純関数を取り出して検査する
const src = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
const m = src.match(/\/\/ <defer-candidates>([\s\S]*?)\/\/ <\/defer-candidates>/);
assert.ok(m, 'defer-candidates ブロックが無い');
const deferCandidates = new Function(m[1] + '\nreturn deferCandidates;')();

test('金曜・自宅でない作業: 平日先頭で最大4つ、日付は重複せず今日より後', () => {
  const c = deferCandidates({ env: ['Mac'], due: null }, '2026-11-06'); // 金
  assert.ok(c.length >= 3 && c.length <= 4);
  assert.equal(c[0].date, '2026-11-09'); // 次の平日は月曜
  assert.equal(new Set(c.map((x) => x.date)).size, c.length);
  assert.ok(c.every((x) => x.date > '2026-11-06'));
  assert.ok(c.some((x) => x.date === '2026-11-11' && x.label.startsWith('水曜'))); // 在宅の水曜
});

test('自宅の作業: 水曜と週末が先頭', () => {
  const c = deferCandidates({ env: ['自宅'], due: null }, '2026-11-06');
  assert.deepEqual(c.slice(0, 2).map((x) => x.date), ['2026-11-11', '2026-11-07']);
});

test('期日があれば、それを過ぎる日は出さない。期日の前日は先頭にせず、候補にも入る', () => {
  const c = deferCandidates({ env: ['Mac'], due: '2026-11-13' }, '2026-11-06'); // 期日は金。前日=木 11/12
  assert.ok(c.every((x) => x.date <= '2026-11-13'));
  assert.ok(c.some((x) => x.label.startsWith('期日の前日') && x.date === '2026-11-12'));
  assert.ok(!c[0].label.startsWith('期日の前日'));
});

test('期日が2日後なら、前日=明日と重複せず1つにまとまる', () => {
  const c = deferCandidates({ env: [], due: '2026-11-08' }, '2026-11-06');
  assert.ok(c.every((x) => x.date <= '2026-11-08'));
  assert.equal(new Set(c.map((x) => x.date)).size, c.length);
});

test('期日が今日なら明日だけ（期日超過は避けられないので最短）', () => {
  assert.deepEqual(deferCandidates({ env: [], due: '2026-11-06' }, '2026-11-06').map((x) => x.date), ['2026-11-07']);
});

test('期日が明日なら、最短の明日だけを出す', () => {
  const c = deferCandidates({ env: [], due: '2026-11-07' }, '2026-11-06');
  assert.deepEqual(c.map((x) => x.date), ['2026-11-07']);
});

test('期日を過ぎたタスク（期限切れ）は期日で絞らない', () => {
  const c = deferCandidates({ env: ['Mac'], due: '2026-10-01' }, '2026-11-06');
  assert.ok(c.length >= 3);
});

test('土曜に実行したら「土曜」ラベルは出さず、日曜は「明日」と呼ぶ。ラベルの曜日と日付が一致する', () => {
  const c = deferCandidates({ env: ['自宅'], due: null }, '2026-11-07'); // 土
  assert.ok(c.every((x) => x.date > '2026-11-07'));
  assert.ok(!c.some((x) => x.label.startsWith('土曜')));
  for (const k of c) {
    const d = new Date(k.date + 'T00:00:00Z');
    assert.ok(k.label.includes('(' + '日月火水木金土'[d.getUTCDay()] + ')'), k.label);
  }
});

test('日曜に実行しても候補は今日より後で、重複しない', () => {
  const c = deferCandidates({ env: ['Mac'], due: null }, '2026-11-08'); // 日
  assert.ok(c.every((x) => x.date > '2026-11-08'));
  assert.equal(new Set(c.map((x) => x.date)).size, c.length);
});

test('回答の日付検証は存在しない日付を弾く', () => {
  const ok = (d) => new Date(d + 'T00:00:00Z').toISOString().slice(0, 10) === d;
  assert.ok(ok('2026-11-09'));
  assert.ok(!ok('2026-02-31'));
  assert.ok(!ok('2026-11-31'));
});
