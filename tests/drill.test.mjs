import {DatabaseSync} from 'node:sqlite';
import test from 'node:test';
import assert from 'node:assert/strict';
import {DRILLS, drillState, drillPutState, drillExport, drillRoute} from '../src/drill.js';

function env(t) {
  const sql = new DatabaseSync(':memory:'); t.after(() => sql.close());
  const DB = {
    prepare(query) {
      let args = [];
      return { sel: /^\s*select/i.test(query),
        bind(...v) { args = v; return this; },
        async run() { const r = sql.prepare(query).run(...args); return {meta: {changes: Number(r.changes)}}; },
        async all() { return {results: sql.prepare(query).all(...args)}; },
        async first() { return sql.prepare(query).get(...args) ?? null; },
      };
    },
    async batch(stmts) { const out = []; for (const s of stmts) out.push(await (s.sel ? s.all() : s.run())); return out; },
  };
  return {DB, APP_TOKEN: 'test-app-token'};
}
const json = (o, status = 200) => new Response(JSON.stringify(o), {status, headers: {'Content-Type': 'application/json'}});

test('drill: 移行 (replace) → 読み出しで同じ値が返る (dict・配列・数値も)', async t => {
  const e = env(t);
  const kokugo = {'読解:指示語': {stage: 2, due: '2026-11-14', last_miss: '2026-11-10'}, '語句:馬が合う': {stage: 0, due: '2026-11-12'}};
  const r = await drillPutState(e, 'saya_kokugo', {replace: true, set: kokugo});
  assert.equal(r.set, 2);
  assert.deepEqual((await drillState(e, 'saya_kokugo')).state, kokugo);
  const tokei = {stage: 'full', streak: 0, history: [{date: '2026-10-29', miss: []}]};
  await drillPutState(e, 'hikizan_tokei', {replace: true, set: tokei});
  assert.deepEqual((await drillState(e, 'hikizan_tokei')).state, tokei);
  assert.deepEqual((await drillState(e, 'sansu_srs')).state, {});
});

test('drill: 差分 upsert・null で削除・replace で全入れ替え・名前ごとに独立', async t => {
  const e = env(t);
  await drillPutState(e, 'rika_review', {set: {a: {stage: 1}, b: {stage: 2}}});
  await drillPutState(e, 'shakai_review', {set: {a: {stage: 9}}});
  await drillPutState(e, 'rika_review', {set: {a: {stage: 3}, b: null}});
  assert.deepEqual((await drillState(e, 'rika_review')).state, {a: {stage: 3}});
  assert.deepEqual((await drillState(e, 'shakai_review')).state, {a: {stage: 9}});
  await drillPutState(e, 'rika_review', {replace: true, set: {z: {stage: 0}}});
  assert.deepEqual((await drillState(e, 'rika_review')).state, {z: {stage: 0}});
});

test('drill: ファイルは許可リストだけ。長すぎるキー・巨大な値は飛ばす', async t => {
  const e = env(t);
  const r = await drillPutState(e, 'yuzuki_hiragana', {set: {['x'.repeat(201)]: {a: 1}, ok: {a: 1}}, files: {'review.txt': 'め\nこ\n', 'evil.txt': 'x'}});
  assert.deepEqual(r.files, ['review.txt']);
  assert.equal(r.set, 1);
  assert.equal(r.skipped, 2);
  assert.deepEqual((await drillState(e, 'yuzuki_hiragana')).files, {'review.txt': 'め\nこ\n'});
  const r2 = await drillPutState(e, 'sansu_srs', {files: {'review.txt': 'x'}});
  assert.deepEqual(r2.files, []);
});

test('drill: export は全ドリル分を返す', async t => {
  const e = env(t);
  await drillPutState(e, 'sansu_srs', {set: {keta0: {stage: 1, due: '2026-10-29'}}});
  const x = await drillExport(e);
  assert.deepEqual(Object.keys(x.names).sort(), Object.keys(DRILLS).sort());
  assert.deepEqual(x.names.sansu_srs.state, {keta0: {stage: 1, due: '2026-10-29'}});
});

test('drill: ルートは Kairos の認証のみ。名前は許可リストだけ', async t => {
  const e = env(t);
  const call = (method, path, admin, body) => drillRoute(new Request('https://x' + path, {method, body: body ? JSON.stringify(body) : undefined}), e, new URL('https://x' + path), {admin, json});
  assert.equal(await call('GET', '/api/other/state', true), null);
  assert.equal((await call('GET', '/api/drill/state?name=sansu_srs', false)).status, 401);
  assert.equal((await call('GET', '/api/drill/state?name=nope', true)).status, 400);
  assert.equal((await call('GET', '/api/drill/state?name=constructor', true)).status, 400);
  const put = await call('PUT', '/api/drill/state?name=sansu_srs', true, {set: {keta0: {stage: 2}}});
  assert.equal((await put.json()).set, 1);
  const got = await (await call('GET', '/api/drill/state?name=sansu_srs', true)).json();
  assert.deepEqual(got.state, {keta0: {stage: 2}});
  assert.equal((await call('GET', '/api/drill/export', true)).status, 200);
});
