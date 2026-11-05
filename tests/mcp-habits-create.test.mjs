import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// kairos_create で Habits（2026-11-05）と Projects（2026-11-05）を作れる。Roles は従来どおり更新だけ。
const s = readFileSync(new URL('../src/mcp.js', import.meta.url), 'utf8');

test('kairos_create: Roles は作れず、Habits / Projects は作れる', () => {
  assert.match(s, /normName\(a\.database\) === "roles"\) throw new Error\("この DB には作れません（Roles は更新だけ）"\)/);
  assert.doesNotMatch(s, /\["roles", "projects"/);
  assert.match(s, /（Roles は作れない）/);
});

test('kairos_create: 習慣は 状態 を省くと「提案中」で作る（有効化は習慣棚卸し）', () => {
  assert.match(s, /normName\(a\.database\) === "habits" && a\.fields\["状態"\] == null/);
  assert.match(s, /状態: "提案中"/);
  assert.match(s, /habits は 状態 を省くと「提案中」で作る/);
});

test('kairos_create: プロジェクトは 名前 が必須で、列を絞り、ステータスを省くと「未着手」', () => {
  assert.match(s, /const PROJECT_CREATE_FIELDS = \["名前", "役割", "ステータス", "テーマ", "対応ゴール", "完了条件", "関係者", "開始日", "ローカルパス"\]/);
  assert.match(s, /projects を作るには 名前 が要ります/);
  assert.match(s, /normName\(a\.database\) === "projects"/);
  assert.match(s, /ステータス: "未着手"/);
});
