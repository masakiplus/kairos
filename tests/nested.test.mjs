import {DatabaseSync} from 'node:sqlite';
import test from 'node:test';
import assert from 'node:assert/strict';
import {initD1, d1Notion, storageRoute, ensureBodyEdits} from '../src/d1.js';

// 追加コレクション (daily など) の未取得の入れ子だけを Notion から取る。親の本文・Kairos で書いた日報は消さない。
const DAILY = 'd'.repeat(32), TASK = 'a'.repeat(32), REF = 'e'.repeat(32);
const TABLE = '21'.repeat(16), ROW1 = '22'.repeat(16), ROW2 = '23'.repeat(16), TOP = '24'.repeat(16), MINE = '25'.repeat(16);
const LIST = '26'.repeat(16), DEEP = '27'.repeat(16), DEEPER = '28'.repeat(16), IMG = '29'.repeat(16), TTABLE = '31'.repeat(16), RTABLE = '32'.repeat(16);
const DDS = '3'.repeat(32), TDS = '4'.repeat(32), RDS = '5'.repeat(32), T0 = '2026-10-19T00:00:00.000Z';
function setup(t) {
  const sql = new DatabaseSync(':memory:'); t.after(() => sql.close());
  const DB = {prepare(query){let args=[];return {bind(...v){args=v;return this;},async run(){return sql.prepare(query).run(...args);},async all(){return {results:sql.prepare(query).all(...args)};},async first(){return sql.prepare(query).get(...args)||null;}};},
    async batch(stmts){sql.exec('BEGIN');try{const out=[];for(const s of stmts)out.push(await s.all());sql.exec('COMMIT');return out;}catch(e){sql.exec('ROLLBACK');throw e;}}};
  const env = {DB, DATA_BACKEND: 'd1', TASKS_DATA_SOURCE_ID: TDS, KAIROS_ORIGIN: 'https://kairos.test', NOTION_TOKEN: 'x'};
  const block = (id, type, extra = {}) => ({object: 'block', id, type, [type]: type === 'table_row' ? {cells: [[{plain_text: id.slice(0, 4)}]]} : {rich_text: [{plain_text: id.slice(0, 4)}]}, created_time: T0, last_edited_time: T0, has_children: false, ...extra});
  const seed = async () => {
    await initD1(env); await ensureBodyEdits(env);
    sql.exec(`CREATE TABLE IF NOT EXISTS docs (id TEXT PRIMARY KEY, collection TEXT, title TEXT, parent_id TEXT, props TEXT, body_md TEXT, created TEXT, updated TEXT, version INTEGER, body_status TEXT, conv TEXT)`);
    for (const [ds, coll] of [[DDS, 'daily'], [TDS, 'tasks'], [RDS, 'reference']]) sql.prepare('INSERT INTO entity_schemas VALUES(?,?,?)').run(ds, coll, JSON.stringify({properties: {名前: {type: 'title'}}}));
    const put = (id, ds, coll) => {sql.prepare('INSERT INTO entities(id,ds,collection,payload) VALUES(?,?,?,?)').run(id, ds, coll, JSON.stringify({object: 'page', id, last_edited_time: T0, parent: {data_source_id: ds}, properties: {名前: {type: 'title', title: [{plain_text: id}]}}}));sql.prepare('INSERT INTO entity_bodies VALUES(?,1)').run(id);sql.prepare('INSERT INTO entity_body_versions VALUES(?,?)').run(id, T0);};
    put(DAILY, DDS, 'daily'); put(TASK, TDS, 'tasks'); put(REF, RDS, 'reference');
    const child = (parent, b, pos) => sql.prepare('INSERT INTO entity_children VALUES(?,?,?,?)').run(parent, b.id, pos, JSON.stringify(b));
    child(DAILY, block(TOP, 'paragraph'), 0);
    child(DAILY, block(TABLE, 'table', {table: {table_width: 1}, has_children: true}), 1);
    child(DAILY, block(LIST, 'bulleted_list_item', {has_children: true}), 2);
    child(TASK, block(TTABLE, 'table', {table: {table_width: 1}, has_children: true}), 0);
    child(REF, block(RTABLE, 'table', {table: {table_width: 1}, has_children: true}), 0);
  };
  const json = (body, status = 200) => ({body, status});
  const call = (method, path, qs = {}) => storageRoute({method, headers: new Headers()}, env, new URL('https://kairos.test/api/storage/' + path + '?' + new URLSearchParams(qs)), json);
  return {sql, env, seed, call, block};
}

test('一覧: 追加コレクションの未取得の入れ子だけを出し、中核 (tasks) の分は出さない', async t => {
  const {env, seed, call} = setup(t); await seed();
  const r = await call('GET', 'nested-pending');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.items.map(x => x.id).sort(), [TABLE, LIST, RTABLE].sort());
  assert.deepEqual(r.body.counts, {daily: 2, reference: 1});
  assert.equal(r.body.owners, 2);
  assert.deepEqual((await call('GET', 'nested-pending', {coll: 'reference'})).body.items.map(x => x.id), [RTABLE]);
  assert.equal((await call('POST', 'nested-pending')).status, 405);
  await assert.rejects(d1Notion(env, '/blocks/' + TABLE + '/children'), /not been migrated/);
});

test('取り込み: 親の本文と Kairos で書いた日報は残し、入れ子を下まで埋める', async t => {
  const {sql, env, seed, call, block} = setup(t); await seed();
  // 切り替え後に Kairos で日報へ書いた分
  await d1Notion(env, '/blocks/' + DAILY + '/children', {method: 'PATCH', body: JSON.stringify({children: [{type: 'paragraph', paragraph: {rich_text: [{text: {content: 'Kairos で書いた'}}]}}]})});
  const edited = sql.prepare('SELECT edited FROM entity_body_edits WHERE id=?').get(DAILY).edited;
  const revision = sql.prepare('SELECT revision FROM entities WHERE id=?').get(DAILY).revision;
  const notion = {
    ['/blocks/' + TABLE + '/children']: [{results: [block(ROW1, 'table_row')], has_more: true, next_cursor: 'c1'}, {results: [block(ROW2, 'table_row')], has_more: false}],
    ['/blocks/' + LIST + '/children']: [{results: [block(DEEP, 'bulleted_list_item', {has_children: true}), block(IMG, 'image', {image: {type: 'file', file: {url: 'https://prod-files-secure.s3.us-west-2.amazonaws.com/x.png'}}})], has_more: false}],
    ['/blocks/' + DEEP + '/children']: [{results: [block(DEEPER, 'paragraph')], has_more: false}],
  };
  const seen = [];
  t.mock.method(globalThis, 'fetch', async (u, init = {}) => {
    assert.ok(!init.method || init.method === 'GET', 'Notion へは読み取りだけ');
    const url = new URL(u), key = url.pathname.replace('/v1', '');
    seen.push(key + (url.searchParams.get('start_cursor') ? '#' + url.searchParams.get('start_cursor') : ''));
    const pages = notion[key]; if (!pages) throw new Error('unexpected ' + key);
    return new Response(JSON.stringify(url.searchParams.get('start_cursor') ? pages[1] : pages[0]));
  });
  const a = await call('POST', 'capture-nested', {id: TABLE});
  assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.equal(a.body.next, 'c1'); assert.equal(a.body.collection, 'daily'); assert.equal(a.body.owner, DAILY);
  await assert.rejects(d1Notion(env, '/blocks/' + TABLE + '/children'), /not been migrated/, '途中では読めない');
  assert.equal((await call('POST', 'capture-nested', {id: TABLE, cursor: 'c1'})).status, 200);
  assert.deepEqual((await d1Notion(env, '/blocks/' + TABLE + '/children')).results.map(b => b.id), [ROW1, ROW2]);
  const l = await call('POST', 'capture-nested', {id: LIST});
  assert.deepEqual(l.body.children, [DEEP]); assert.deepEqual(l.body.assets, [IMG]);
  assert.equal((await call('POST', 'capture-nested', {id: DEEP})).status, 200);
  assert.equal((await d1Notion(env, '/blocks/' + DEEP + '/children')).results[0].id, DEEPER);
  assert.deepEqual(seen, ['/blocks/' + TABLE + '/children', '/blocks/' + TABLE + '/children#c1', '/blocks/' + LIST + '/children', '/blocks/' + DEEP + '/children']);
  // 親の本文は Kairos で書いた行も含めてそのまま、Kairos 編集の印・ページの版も動かない
  const top = (await d1Notion(env, '/blocks/' + DAILY + '/children')).results;
  assert.deepEqual(top.slice(0, 3).map(b => b.id), [TOP, TABLE, LIST]);
  assert.equal(top[3].paragraph.rich_text[0].plain_text, 'Kairos で書いた');
  assert.equal(sql.prepare('SELECT edited FROM entity_body_edits WHERE id=?').get(DAILY).edited, edited);
  assert.equal(sql.prepare('SELECT revision FROM entities WHERE id=?').get(DAILY).revision, revision);
  // 取り込み済みはもう取らない、一覧からも消える
  assert.equal((await call('POST', 'capture-nested', {id: TABLE})).status, 409);
  assert.deepEqual((await call('GET', 'nested-pending')).body.items.map(x => x.id), [RTABLE]);
});

test('門: 中核の入れ子・ページ・入れ子の無いブロック・知らない id・cursor だけの再開・読み取り専用は断る', async t => {
  const {sql, env, seed, call} = setup(t); await seed();
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Notion を呼ばない'); });
  assert.equal((await call('POST', 'capture-nested', {id: TTABLE})).status, 409, '中核 (tasks) の入れ子');
  assert.equal((await call('POST', 'capture-nested', {id: DAILY})).status, 409, 'ページ自身');
  assert.equal((await call('POST', 'capture-nested', {id: TOP})).status, 409, '入れ子の無いブロック');
  assert.equal((await call('POST', 'capture-nested', {id: 'f'.repeat(32)})).status, 404);
  assert.equal((await call('POST', 'capture-nested', {id: 'xyz'})).status, 400);
  assert.equal((await call('POST', 'capture-nested', {id: TABLE, cursor: 'c1'})).status, 409, '初回を飛ばした cursor');
  assert.equal((await call('GET', 'capture-nested', {id: TABLE})).status, 405);
  env.D1_READ_ONLY = true;
  assert.equal((await call('POST', 'capture-nested', {id: TABLE})).status, 409);
  delete env.D1_READ_ONLY;
  sql.prepare('INSERT INTO entity_bodies VALUES(?,1)').run(RTABLE);
  assert.equal((await call('POST', 'capture-nested', {id: RTABLE})).status, 409, '取り込み済み');
});

test('途中で止まった回は、cursor なしで呼び直すと前回の分を消して入れ直す', async t => {
  const {sql, seed, call, block} = setup(t); await seed();
  let n = 0;
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify(n++ === 0 ? {results: [block(ROW1, 'table_row')], has_more: true, next_cursor: 'c1'} : {results: [block(ROW1, 'table_row'), block(ROW2, 'table_row')], has_more: false})));
  assert.equal((await call('POST', 'capture-nested', {id: TABLE})).status, 200);
  assert.equal((await call('POST', 'capture-nested', {id: TABLE})).status, 200);
  assert.deepEqual(sql.prepare('SELECT id,position FROM entity_children WHERE parent_id=? ORDER BY position').all(TABLE).map(r => [r.id, r.position]), [[ROW1, 0], [ROW2, 1]]);
});

test('添付: 持ち主が追加コレクションで未保存の添付だけ capture-asset を通す', async t => {
  const {sql, seed, call, block} = setup(t); await seed();
  sql.prepare('INSERT INTO entity_children VALUES(?,?,?,?)').run(LIST, IMG, 0, JSON.stringify(block(IMG, 'image', {image: {type: 'external', external: {url: 'https://example.com/x.png'}}})));
  sql.prepare('INSERT INTO entity_children VALUES(?,?,?,?)').run(TASK, '33'.repeat(16), 1, JSON.stringify(block('33'.repeat(16), 'image', {image: {type: 'external', external: {url: 'https://example.com/y.png'}}})));
  // 門は通る (この添付は外部 URL なので、その先の検査で 409 になる)
  assert.equal((await call('POST', 'capture-asset', {id: IMG})).body.error, 'External attachment needs separate review');
  assert.equal((await call('POST', 'capture-asset', {id: '33'.repeat(16)})).body.error, 'Migration is disabled after D1 cutover', '中核の添付は通さない');
});
