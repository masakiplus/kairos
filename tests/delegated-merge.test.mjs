import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
// 一覧の絞り込み (passesView) の後から足す 2 つの合流でも、委任中 (担当あり) は自分のタブに出さない (2026-11-05)
test('⭐ 今日の3つ の合流は委任中を足さない', () => {
  const block = src.slice(src.indexOf('今日の3つ の合流は 今日やる だけ'), src.indexOf('同じページが 2 回返ることがある'));
  assert.match(block, /if \(t\.owner\) continue;/);
});
test('🤖 処理中 の合流は委任タブ以外で委任中を足さない', () => {
  const block = src.slice(src.indexOf('処理中のタスクはどのタブにも出す'), src.indexOf('今日の3つ の合流は 今日やる だけ'));
  assert.match(block, /if \(t\.owner && view !== "delegated"\) continue;/);
});
