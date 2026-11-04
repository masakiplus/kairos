import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// kairos_create で Habits を作れる（2026-11-05）。Roles / Projects は従来どおり更新だけ。
const s = readFileSync(new URL('../src/mcp.js', import.meta.url), 'utf8');

test('kairos_create: Roles / Projects は作れず、Habits は作れる', () => {
  assert.match(s, /\["roles", "projects"\]\.includes\(normName\(a\.database\)\)/);
  assert.doesNotMatch(s, /\["roles", "projects", "habits"\]/);
  assert.match(s, /Roles \/ Projects は更新だけ/);
});

test('kairos_create: 習慣は 状態 を省くと「提案中」で作る（有効化は習慣棚卸し）', () => {
  assert.match(s, /normName\(a\.database\) === "habits" && a\.fields\["状態"\] == null/);
  assert.match(s, /状態: "提案中"/);
  assert.match(s, /habits は 状態 を省くと「提案中」で作る/);
});
