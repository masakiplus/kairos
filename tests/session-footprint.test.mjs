import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// 会話の足跡の書き先（docs/sessions.md, 2026-11-03）が MCP 規約・API 規約・🤖 依頼文・正本でそろっていること
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

test('MCP 規約: 足跡は Kairos の sessions、Notion は退役で、正本は docs/sessions.md', () => {
  const s = read('../src/mcp.js');
  assert.match(s, /会話の足跡は Kairos の sessions に kairos_create で書く/);
  assert.match(s, /セッション足跡の規約」ページは退役/);
  assert.match(s, /こちらを優先する。書き方の正本は docs\/sessions\.md/);
});

test('/api/storage/agent の rules にも足跡の書き先がある', () => {
  const s = read('../src/d1.js');
  assert.match(s, /Session footprints \(docs\/sessions\.md\): .*Kairos sessions data source/);
  assert.match(s, /Never write to Notion 📻 Sessions/);
});

test('🤖 の依頼文は足跡を Kairos の sessions に向ける', () => {
  const s = read('../src/app.html');
  assert.match(s, /会話の足跡は終わるときKairosのsessionsに1件書いてください（NotionのSessionsは退役）/);
});

test('docs/sessions.md が正本で、書き方の表と Decisions との関係がある', () => {
  const s = read('../docs/sessions.md');
  assert.match(s, /このページが会話の足跡（セッション足跡）の書き方の正本である/);
  for (const w of ['database: "sessions"', '手戻り', '対象スキル', '関連決定', '残課題ハーベスタ', '書かないこと'])
    assert.ok(s.includes(w), w);
});
