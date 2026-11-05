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

test('期日があれば、それを過ぎる日は出さない。期日の前日は先頭にしない', () => {
  const c = deferCandidates({ env: ['自宅'], due: '2026-11-12' }, '2026-11-06');
  assert.ok(c.every((x) => x.date <= '2026-11-12'));
  assert.ok(c.some((x) => x.label.startsWith('期日の前日') && x.date === '2026-11-11') || c.some((x) => x.date === '2026-11-11'));
  assert.ok(!c[0].label.startsWith('期日の前日'));
});

test('期日が明日なら、最短の明日だけを出す', () => {
  const c = deferCandidates({ env: [], due: '2026-11-07' }, '2026-11-06');
  assert.deepEqual(c.map((x) => x.date), ['2026-11-07']);
});

test('期日を過ぎたタスク（期限切れ）は期日で絞らない', () => {
  const c = deferCandidates({ env: ['Mac'], due: '2026-10-01' }, '2026-11-06');
  assert.ok(c.length >= 3);
});

test('土曜に実行しても、候補は今日より後になる', () => {
  const c = deferCandidates({ env: ['自宅'], due: null }, '2026-11-07'); // 土
  assert.ok(c.every((x) => x.date > '2026-11-07'));
});
