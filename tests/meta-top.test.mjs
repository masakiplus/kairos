import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// 2026-11-14 利用者「まとめて棚卸しするボタンは各タブの一番上におく」。metaHtml は一覧の先頭に置き、末尾には足さない。
test('画面: 全体を見返すボタン (metaHtml) は各タブの一番上に置く', async () => {
  const html = await readFile(new URL('../src/app.html', import.meta.url), 'utf8');
  const heads = html.match(/list\.innerHTML = metaHtml\((?:view|"roles"|"review")\) \+/g) || [];
  assert.equal(heads.length, 4); // 一覧タブ・役割・決める (問いなし／問いあり)
  assert.doesNotMatch(html, /\+ metaHtml\([^)]*\);/); // 末尾に連結していない
  assert.match(html, /<div class="meta top">/);
  assert.match(html, /\.meta\.top\{margin-top:0\}/);
});
