import {DatabaseSync} from 'node:sqlite';
import test from 'node:test';
import assert from 'node:assert/strict';
import {initD1, d1Notion, storageRoute, collectionOfSource, isExtraName} from '../src/d1.js';

// 中核6コレクション以外(例: sessions)を登録して、collection 名が引ければよい。
function setup(t) {
  const sql = new DatabaseSync(':memory:'); t.after(() => sql.close());
  const DB = {
    prepare(query) {
      let args = [];
      return { sel: /^\s*select/i.test(query),
        bind(...v) { args = v; return this; },
        async run() { return sql.prepare(query).run(...args); },
        async all() { return {results: sql.prepare(query).all(...args)}; },
        async first() { return sql.prepare(query).get(...args) ?? null; },
      };
    },
    async batch(stmts) { const out = []; for (const s of stmts) out.push(await (s.sel ? s.all() : s.run())); return out; },
  };
  const tasksDs = 'd'.repeat(32), sessDs = 'e'.repeat(32);
  const env = {DB, TASKS_DATA_SOURCE_ID: tasksDs, KAIROS_ORIGIN: 'https://kairos.test', NOTION_TOKEN: 'x', APP_TOKEN: 'y'};
  return {sql, env, tasksDs, sessDs};
}
const schemaOf = (props) => JSON.stringify({object: 'data_source', properties: props});

test('名前の規則: 小文字英数字と _、予約語は不可', () => {
  assert.equal(isExtraName('sessions'), true);
  assert.equal(isExtraName('daily_notes'), true);
  assert.equal(isExtraName('tasks'), false);
  assert.equal(isExtraName('nested'), false);
  assert.equal(isExtraName('pages'), false);
  assert.equal(isExtraName('Sessions'), false);
  assert.equal(isExtraName('a'), false);
  assert.equal(isExtraName(''), false);
});

test('collectionOfSource: 中核は環境変数、追加分は entity_schemas から引く', async t => {
  const {sql, env, tasksDs, sessDs} = setup(t);
  await initD1(env);
  sql.prepare('INSERT INTO entity_schemas VALUES(?,?,?)').run(sessDs, 'sessions', schemaOf({}));
  assert.equal(await collectionOfSource(env, tasksDs), 'tasks');
  assert.equal(await collectionOfSource(env, sessDs), 'sessions');
  assert.equal(await collectionOfSource(env, 'f'.repeat(32)), null);
});

test('追加コレクションの行を D1 だけで作れて、collection が sessions になる', async t => {
  const {sql, env, sessDs} = setup(t);
  await initD1(env);
  sql.prepare('INSERT INTO entity_schemas VALUES(?,?,?)').run(sessDs, 'sessions', schemaOf({名前: {id: 'title', type: 'title'}}));
  t.mock.method(globalThis, 'fetch', () => { throw new Error('Notion must not be called'); });
  const created = await d1Notion(env, '/pages', {method: 'POST', body: JSON.stringify({parent: {data_source_id: sessDs}, properties: {名前: {title: [{text: {content: 'セッションA'}}]}}})});
  assert.equal(created.properties.名前.title[0].plain_text, 'セッションA');
  const row = sql.prepare('SELECT collection, ds FROM entities').get();
  assert.equal(row.collection, 'sessions');
  assert.equal(row.ds, sessDs);
  const q = await d1Notion(env, '/data_sources/' + sessDs + '/query', {method: 'POST', body: JSON.stringify({page_size: 10})});
  assert.equal(q.results.length, 1);
});

test('/api/storage/sources は中核6つに続けて追加コレクションを返す(nested は返さない)', async t => {
  const {sql, env, sessDs} = setup(t);
  await initD1(env);
  sql.prepare('INSERT INTO entity_schemas VALUES(?,?,?)').run(sessDs, 'sessions', schemaOf({}));
  sql.prepare('INSERT INTO entity_schemas VALUES(?,?,?)').run('9'.repeat(32), 'nested', schemaOf({}));
  const json = (body, status = 200) => ({body, status});
  const r = await storageRoute({method: 'GET', headers: new Headers()}, env, new URL('https://kairos.test/api/storage/sources'), json);
  const names = r.body.sources.map(s => s.collection);
  assert.deepEqual(names.slice(0, 6), ['tasks', 'projects', 'roles', 'decisions', 'habits', 'habit_log']);
  assert.ok(names.includes('sessions'));
  assert.ok(!names.includes('nested'));
});

test('capture: 名前が不正・予約語・ds 欠落は 400、別名で登録済みなら 409', async t => {
  const {sql, env, sessDs} = setup(t);
  await initD1(env);
  sql.prepare('INSERT INTO entity_schemas VALUES(?,?,?)').run(sessDs, 'sessions', schemaOf({}));
  const json = (body, status = 200) => ({body, status});
  const call = (qs) => storageRoute({method: 'POST', headers: new Headers()}, env, new URL('https://kairos.test/api/storage/capture?' + qs), json);
  assert.equal((await call('coll=Bad-Name&ds=' + 'a'.repeat(32))).status, 400);
  assert.equal((await call('coll=nested&ds=' + 'a'.repeat(32))).status, 400);
  assert.equal((await call('coll=sessions')).status, 400);
  assert.equal((await call('coll=daily&ds=' + sessDs)).status, 409);
});

test('D1 切替後: 中核の capture は 409、追加コレクションの capture は入口を通る', async t => {
  const {env} = setup(t);
  env.DATA_BACKEND = 'd1';
  const json = (body, status = 200) => ({body, status});
  const call = (q) => storageRoute({method: 'POST', headers: new Headers()}, env, new URL('https://kairos.test/api/storage/capture?' + q), json);
  assert.equal((await call('coll=tasks')).status, 409);
  assert.equal((await call('coll=sessions')).status, 400); // ds 欠落で弾かれる=切替ガードは通った
});
