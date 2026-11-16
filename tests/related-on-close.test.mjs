import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// 閉じたときの関連タスクの見直しと細かすぎるタスクの統合 (docs/rules.md §5-4, 2026-11-17) が 3 か所と実装にそろっていること
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

test('MCP 規約に「閉じたら関連タスクを見直す」と統合の基準がある', () => {
  const s = read('../src/mcp.js');
  for (const w of ['閉じたら、関連タスクを見直す', 'allChildrenDone が true なら親も閉じる', '細かすぎるタスク', 'dup（with に残す1件の名前）', '§5-2 の分割基準に当たる子は除く'])
    assert.ok(s.includes(w), w);
});

test('kairos_task_action が dup と with を受け、閉じるときは related=1 を付けて next を返す', () => {
  const s = read('../src/mcp.js');
  assert.match(s, /enum: \["done", "skip", "dup", "reopen", "human", "mac", "ai_clear"\]/);
  assert.ok(s.includes('qs.set("related", "1")'));
  assert.ok(s.includes('const CLOSE_NEXT ='));
});

test('Worker は ?related=1 のときだけ relatedOnClose を呼ぶ', () => {
  const s = read('../src/index.js');
  assert.ok(s.includes('async function relatedOnClose(env, t, id)'));
  assert.ok(s.includes('url.searchParams.get("related") === "1"'));
  assert.ok(s.includes('childIds: (p["サブアイテム"]'));
});

test('/api/storage/agent と docs/rules.md にも §5-4 がある', () => {
  assert.ok(read('../src/d1.js').includes('Related tasks on close (rules.md §5-4)'));
  assert.match(read('../docs/rules.md'), /## 5-4\. 閉じたときの関連タスクの見直しと、細かすぎるタスクの統合/);
});
