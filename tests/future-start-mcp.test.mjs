import test from 'node:test';
import assert from 'node:assert/strict';
import { futureStartFix } from '../src/mcp.js';

const schema = { ステータス: { type: 'status' }, 開始日: { type: 'date' }, AI処理開始: { type: 'date' }, AI処理種別: { type: 'select' } };
const page = (status, ai) => ({ properties: { ステータス: { status: { name: status } }, AI処理開始: { date: ai ? { start: ai } : null } } });
const future = new Date(Date.now() + 9 * 3600e3 + 10 * 86400e3).toISOString().slice(0, 10);
const past = new Date(Date.now() + 9 * 3600e3 - 86400e3).toISOString().slice(0, 10);

test('開始日を先にすると 進行中→未着手、AI処理開始を空に', () => {
  assert.deepEqual(futureStartFix('tasks', schema, page('進行中', '2026-11-01T06:50:00Z'), { 開始日: future }),
    { ステータス: '未着手', AI処理開始: null, AI処理種別: null });
});
test('人対応 はそのまま、AI処理開始 だけ空に', () => {
  assert.deepEqual(futureStartFix('tasks', schema, page('人対応', '2026-11-01T06:50:00Z'), { 開始日: future }), { AI処理開始: null, AI処理種別: null });
});
test('ステータスを同時に指定したらそれに従う', () => {
  assert.deepEqual(futureStartFix('tasks', schema, page('進行中', null), { 開始日: future, ステータス: '進行中' }), {});
});
test('開始日が今日以前・空・タスク以外は何もしない', () => {
  assert.deepEqual(futureStartFix('tasks', schema, page('進行中', 'x'), { 開始日: past }), {});
  assert.deepEqual(futureStartFix('tasks', schema, page('進行中', 'x'), { 開始日: null }), {});
  assert.deepEqual(futureStartFix('tasks', schema, page('進行中', 'x'), { 期日: future }), {});
  assert.deepEqual(futureStartFix('projects', schema, page('進行中', 'x'), { 開始日: future }), {});
});
test('日付オブジェクト形式も読む', () => {
  assert.deepEqual(futureStartFix('tasks', schema, page('進行中', null), { 開始日: { start: future } }), { ステータス: '未着手' });
});
