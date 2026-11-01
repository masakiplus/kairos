import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// サブタスク分割の規約（docs/rules.md §5-2, 2026-11-01）が MCP 規約・API 規約・正本の3か所でそろっていること
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

test('MCP 規約にサブタスク分割の基準と作り方がある', () => {
  const s = read('../src/mcp.js');
  assert.match(s, /サブタスクに分ける（確認は要らない/);
  for (const w of ['本人の手番と AI の手番', '親アイテム', '開始日', '先行タスク', 'サブアイテム', '全部終わったら親を完了'])
    assert.ok(s.includes(w), w);
});

test('/api/storage/agent の rules にもサブタスク分割がある', () => {
  const s = read('../src/d1.js');
  assert.match(s, /Subtasks \(rules\.md §5-2\): when updating or creating a task, split it without asking/);
});

test('docs/rules.md に §5-2 があり、§5 の依存の例外を明記している', () => {
  const s = read('../docs/rules.md');
  assert.match(s, /## 5-2\. サブタスク（分割）/);
  assert.match(s, /§5 の「依存は自動では結ばない」の例外/);
});
