import {DatabaseSync} from 'node:sqlite';
import test from 'node:test';
import assert from 'node:assert/strict';
import {tapsAdd, tapsReport} from '../src/taps.js';

function env(t) {
  const sql = new DatabaseSync(':memory:'); t.after(() => sql.close());
  const DB = {
    prepare(query) {
      let args = [];
      return { sel: /^\s*select/i.test(query),
        bind(...v) { args = v; return this; },
        async run() { return sql.prepare(query).run(...args); },
        async all() { return {results: sql.prepare(query).all(...args)}; },
      };
    },
    async batch(stmts) { const out = []; for (const s of stmts) out.push(await (s.sel ? s.all() : s.run())); return out; },
  };
  return {DB};
}

test('タップ計測: 加算・集計・不正キーの除外', async t => {
  const e = env(t);
  assert.deepEqual(await tapsAdd(e, {items: [{k: 'sheet:done', n: 2}, {k: 'sheet:defer?days=1', n: 1}, {k: 'bad key<script>', n: 5}, {k: '', n: 1}]}), {ok: true, stored: 2});
  await tapsAdd(e, {items: [{k: 'sheet:done', n: 3}, {k: 'sheet:#sheetClose'}]});
  const r = await tapsReport(e, 30);
  assert.equal(r.total, 7);
  assert.deepEqual(r.keys.map(x => [x.key, x.n]), [['sheet:done', 5], ['sheet:defer?days=1', 1], ['sheet:#sheetClose', 1]]);
});

test('タップ計測: DB が無い環境では何もしない', async () => {
  assert.deepEqual(await tapsAdd({}, {items: [{k: 'a', n: 1}]}), {ok: true, stored: 0});
  assert.equal((await tapsReport({}, 7)).total, 0);
});
