import {DatabaseSync} from 'node:sqlite';
import test from 'node:test';
import assert from 'node:assert/strict';
import {initD1, d1Notion, storageRoute, ensureBodyEdits} from '../src/d1.js';
import {knowledgeIndex, resolvePath, inspectBody, knowledgeRoute} from '../src/knowledge.js';

// 知識文書 (PRJ・archive・ref) を D1 の今の置き場のまま文書として引き、Notion からの早送りは Kairos 未編集の文書だけ通す。
const P = 'a'.repeat(32), NESTED = 'b'.repeat(32), SUB = 'c'.repeat(32), REF = 'e'.repeat(32), ARC = 'f'.repeat(32);
const PDS = '1'.repeat(32), RDS = '2'.repeat(32), T0 = '2026-10-18T00:00:00.000Z';
function setup(t) {
  const sql = new DatabaseSync(':memory:'); t.after(() => sql.close());
  const DB = {prepare(query){let args=[];return {bind(...v){args=v;return this;},async run(){return sql.prepare(query).run(...args);},async all(){return {results:sql.prepare(query).all(...args)};},async first(){return sql.prepare(query).get(...args)||null;}};},
    async batch(stmts){sql.exec('BEGIN');try{const out=[];for(const s of stmts)out.push(await s.all());sql.exec('COMMIT');return out;}catch(e){sql.exec('ROLLBACK');throw e;}}};
  const env = {DB, DATA_BACKEND: 'd1', PROJECTS_DATA_SOURCE_ID: PDS, KAIROS_ORIGIN: 'https://kairos.test', NOTION_TOKEN: 'x'};
  const page = (id, ds, props, extra = {}) => ({object: 'page', id, last_edited_time: T0, parent: {data_source_id: ds}, properties: props, ...extra});
  const src = s => ({移行元: {type: 'rich_text', rich_text: [{plain_text: s}]}, 名前: {type: 'title', title: [{plain_text: s}]}});
  const block = (id, type, text, extra = {}) => ({object: 'block', id, type, last_edited_by: {object: 'user', id: 'notion-person'}, [type]: type === 'child_page' ? {title: text} : {rich_text: [{plain_text: text}]}, created_time: T0, last_edited_time: T0, has_children: false, ...extra});
  const seed = async () => {
    await initD1(env); await ensureBodyEdits(env);
    sql.exec(`CREATE TABLE IF NOT EXISTS docs (id TEXT PRIMARY KEY, collection TEXT, title TEXT, parent_id TEXT, props TEXT, body_md TEXT, created TEXT, updated TEXT, version INTEGER, body_status TEXT, conv TEXT)`);
    sql.prepare('INSERT INTO entity_schemas VALUES(?,?,?)').run(PDS, 'projects', JSON.stringify({properties: {名前: {type: 'title'}, 移行元: {type: 'rich_text'}}}));
    sql.prepare('INSERT INTO entity_schemas VALUES(?,?,?)').run(RDS, 'reference', JSON.stringify({properties: {名前: {type: 'title'}, 移行元: {type: 'rich_text'}}}));
    const put = (id, ds, coll, p) => {sql.prepare('INSERT INTO entities(id,ds,collection,payload) VALUES(?,?,?,?)').run(id, ds, coll, JSON.stringify(p));sql.prepare('INSERT INTO entity_bodies VALUES(?,1)').run(id);sql.prepare('INSERT INTO entity_body_versions VALUES(?,?)').run(id, T0);};
    put(P, PDS, 'projects', page(P, PDS, src('PRJ/負債')));
    put(NESTED, PDS, 'projects', page(NESTED, PDS, src('PRJ/負債/ルーブル')));
    put(ARC, PDS, 'projects', page(ARC, PDS, src('archive/電力会社比較_2026-04')));
    put(REF, RDS, 'reference', page(REF, RDS, src('ref/家電/洗濯機.md')));
    put(SUB, '', 'pages', {object: 'page', id: SUB, last_edited_time: T0, parent: {type: 'page_id', page_id: P}, properties: {title: {type: 'title', title: [{plain_text: '検討.md'}]}}});
    const child = (parent, b, pos) => sql.prepare('INSERT INTO entity_children VALUES(?,?,?,?)').run(parent, b.id.replace(/-/g, ''), pos, JSON.stringify(b));
    child(P, block('11'.repeat(16), 'callout', 'このページが正本である'), 0);
    child(P, block('12'.repeat(16), 'toggle', '経緯', {has_children: true}), 1);
    child('12'.repeat(16), block('13'.repeat(16), 'paragraph', '入れ子'), 0);
    sql.prepare('INSERT INTO entity_bodies VALUES(?,1)').run('12'.repeat(16));
    child(P, block(SUB, 'child_page', '検討.md'), 2);
    child(SUB, block('14'.repeat(16), 'paragraph', '子ページの本文'), 0);
    child(REF, block('15'.repeat(16), 'paragraph', '取説'), 0);
  };
  const json = (body, status = 200) => ({body, status});
  const storage = (path, qs) => storageRoute({method: 'POST', headers: new Headers()}, env, new URL('https://kairos.test/api/storage/' + path + '?' + new URLSearchParams(qs)), json);
  return {sql, env, seed, storage, json, block};
}

test('一覧とパス解決: README は行の本文、子ページは題名、入れ子の行が勝つ、ref は行そのもの', async t => {
  const {env, seed} = setup(t); await seed();
  const docs = await knowledgeIndex(env);
  assert.deepEqual(docs.map(d => d.path), ['PRJ/負債/README.md', 'PRJ/負債/ルーブル/README.md', 'PRJ/負債/検討.md', 'archive/電力会社比較_2026-04/README.md', 'ref/家電/洗濯機.md']);
  assert.equal(resolvePath(docs, 'PRJ/負債/README.md').id, P);
  assert.equal(resolvePath(docs, 'PRJ/負債/検討.md').id, SUB);
  assert.equal(resolvePath(docs, 'PRJ/負債/ルーブル/README.md').id, NESTED);
  assert.deepEqual(resolvePath(docs, 'PRJ/負債/ルーブル/新規.md'), {path: 'PRJ/負債/ルーブル/新規.md', id: null, kind: 'sub', row: 'PRJ/負債/ルーブル', parent: NESTED});
  assert.equal(resolvePath(docs, './ref/家電/洗濯機.md').id, REF);
  assert.equal(resolvePath(docs, 'ref/無い.md'), null);
  assert.equal(resolvePath(docs, 'PRJ/無い/README.md'), null);
  const r = await knowledgeRoute({method: 'GET'}, env, new URL('https://kairos.test/api/knowledge/resolve?path=' + encodeURIComponent('archive/電力会社比較_2026-04/README.md')), (b, s = 200) => ({b, s}));
  assert.equal(r.b.id, ARC);
  assert.equal(docs.find(d => d.path === 'PRJ/負債/README.md').bodyEdited, T0, '上の段のブロックの時刻');
});

test('Kairos で本文を書くと、入れ子のブロックでも持ち主のページに印が付き、新しいブロックに時刻が入る', async t => {
  const {sql, env, seed} = setup(t); await seed();
  assert.equal((await inspectBody(env, P)).touched, false);
  await d1Notion(env, '/blocks/' + '13'.repeat(16), {method: 'PATCH', body: JSON.stringify({paragraph: {rich_text: [{text: {content: '直した'}}]}})});
  assert.ok(sql.prepare('SELECT edited FROM entity_body_edits WHERE id=?').get(P));
  assert.equal((await inspectBody(env, P)).touched, true);
  assert.equal((await inspectBody(env, SUB)).touched, false, '子ページは別の文書');
  const nested = JSON.parse(sql.prepare('SELECT payload FROM entity_children WHERE id=?').get('13'.repeat(16)).payload);
  assert.equal(nested.last_edited_by, undefined, 'Kairos での編集を取り込み時の人に付けない');
  const readme = (await knowledgeIndex(env)).find(d => d.path === 'PRJ/負債/README.md');
  assert.ok(readme.bodyEdited > T0, '入れ子の編集も本文の時刻に出る');
  const added = await d1Notion(env, '/blocks/' + SUB + '/children', {method: 'PATCH', body: JSON.stringify({children: [{type: 'paragraph', paragraph: {rich_text: [{text: {content: '追記'}}]}}]})});
  assert.ok(added.results[0].created_time && added.results[0].last_edited_time);
  assert.ok(sql.prepare('SELECT edited FROM entity_body_edits WHERE id=?').get(SUB));
  await d1Notion(env, '/blocks/' + '15'.repeat(16), {method: 'DELETE'});
  assert.equal((await inspectBody(env, REF)).touched, true);
});

test('ページの下に子ページを作れて、一覧とパス解決に出る', async t => {
  const {env, seed} = setup(t); await seed();
  const made = await d1Notion(env, '/pages', {method: 'POST', body: JSON.stringify({parent: {page_id: NESTED}, properties: {title: [{text: {content: '経緯_第18回報告書.md'}}]}, children: [{type: 'paragraph', paragraph: {rich_text: [{text: {content: '本文'}}]}}]})});
  assert.equal(made.properties.title.title[0].plain_text, '経緯_第18回報告書.md');
  const hit = resolvePath(await knowledgeIndex(env), 'PRJ/負債/ルーブル/経緯_第18回報告書.md');
  assert.equal(hit.id, made.id.replace(/-/g, ''));
  const body = await d1Notion(env, '/blocks/' + hit.id + '/children');
  assert.equal(body.results[0].paragraph.rich_text[0].plain_text, '本文');
  await assert.rejects(d1Notion(env, '/pages', {method: 'POST', body: JSON.stringify({parent: {page_id: '9'.repeat(32)}, properties: {title: [{text: {content: 'x'}}]}})}), /not found/);
});

test('早送り: 未編集の文書だけ取り直し、子ページの本文は消さず、終われば印を外して再取り込みを断る', async t => {
  const {sql, env, seed, storage, block} = setup(t); await seed();
  const NEWSUB = 'd'.repeat(32), T1 = '2026-10-22T00:00:00.000Z';
  const notion = {
    ['/blocks/' + P + '/children']: {results: [block('21'.repeat(16), 'paragraph', 'Notion で書いた最新'), block(SUB, 'child_page', '検討.md'), block(NEWSUB, 'child_page', '新規.md')], has_more: false},
    ['/pages/' + NEWSUB]: {object: 'page', id: NEWSUB, last_edited_time: T1, parent: {type: 'page_id', page_id: P}, properties: {title: {type: 'title', title: [{plain_text: '新規.md'}]}}},
    ['/blocks/' + NEWSUB + '/children']: {results: [block('22'.repeat(16), 'paragraph', '新しい子')], has_more: false},
  };
  t.mock.method(globalThis, 'fetch', async (u, init = {}) => {
    assert.ok(!init.method || init.method === 'GET', 'Notion へは読み取りだけ');
    const key = new URL(u).pathname.replace('/v1', '');
    if (!notion[key]) throw new Error('unexpected ' + key);
    return new Response(JSON.stringify(notion[key]));
  });
  // 門の前は取り込めない
  assert.equal((await storage('capture-body', {id: P})).status, 409);
  const begin = await storage('knowledge-begin', {id: P, session: 'sess-0001'});
  assert.equal(begin.status, 200, JSON.stringify(begin.body));
  assert.ok(sql.prepare('SELECT 1 FROM entity_children WHERE parent_id=?').get(SUB), '子ページの本文は残す');
  assert.equal(sql.prepare('SELECT COUNT(*) n FROM entity_children WHERE parent_id=?').get('12'.repeat(16)).n, 0, '入れ子は消す');
  const body = await storage('capture-body', {id: P});
  assert.equal(body.status, 200, JSON.stringify(body.body));
  assert.deepEqual(body.body.pages.map(x => x.replace(/-/g, '')), [SUB, NEWSUB]);
  assert.equal((await storage('capture-page', {id: SUB})).status, 409, '既にある子ページの属性は上書きしない');
  assert.equal((await storage('capture-body', {id: SUB})).status, 409, '既にある子ページの本文は別の文書');
  assert.equal((await storage('capture-page', {id: NEWSUB})).status, 200);
  assert.equal((await storage('capture-body', {id: NEWSUB})).status, 200);
  assert.equal((await storage('knowledge-end', {id: P, session: 'other-session', notion_edited: T1})).status, 409);
  const end = await storage('knowledge-end', {id: P, session: 'sess-0001', notion_edited: T1});
  assert.equal(end.status, 200, JSON.stringify(end.body));
  assert.deepEqual(end.body.openMarks, [NEWSUB]);
  assert.equal((await storage('knowledge-end', {id: NEWSUB, session: 'sess-0001', notion_edited: T1})).status, 200);
  assert.equal(sql.prepare('SELECT updated FROM entity_body_versions WHERE id=?').get(P).updated, T1);
  assert.equal(sql.prepare("SELECT COUNT(*) n FROM storage_control WHERE key LIKE 'kref:%'").get().n, 0);
  assert.equal((await storage('capture-body', {id: P})).status, 409, '終わったら再び閉じる');
  const docs = await knowledgeIndex(env);
  assert.ok(docs.some(d => d.path === 'PRJ/負債/新規.md'));
  assert.equal((await d1Notion(env, '/blocks/' + P + '/children')).results[0].paragraph.rich_text[0].plain_text, 'Notion で書いた最新');
  assert.equal((await d1Notion(env, '/blocks/' + SUB + '/children')).results[0].paragraph.rich_text[0].plain_text, '子ページの本文');
});

test('早送りの門: Kairos で書いた文書は断り、ページの時刻だけ動いた文書は accept が要る、知識文書以外は断る', async t => {
  const {sql, env, seed, storage} = setup(t); await seed();
  await d1Notion(env, '/blocks/' + REF + '/children', {method: 'PATCH', body: JSON.stringify({children: [{type: 'paragraph', paragraph: {rich_text: [{text: {content: 'Kairos で追記'}}]}}]})});
  const r1 = await storage('knowledge-begin', {id: REF, session: 'sess-0002'});
  assert.equal(r1.status, 409); assert.match(r1.body.error, /Edited in Kairos/);
  sql.prepare("UPDATE entities SET payload=json_set(payload,'$.last_edited_time','2026-10-20T00:00:00.000Z') WHERE id=?").run(ARC);
  const r2 = await storage('knowledge-begin', {id: ARC, session: 'sess-0002'});
  assert.equal(r2.status, 409); assert.match(r2.body.error, /accept/);
  assert.equal((await storage('knowledge-begin', {id: ARC, session: 'sess-0002', accept: '1'})).status, 200);
  sql.prepare('INSERT INTO entities(id,ds,collection,payload) VALUES(?,?,?,?)').run('7'.repeat(32), 'x', 'tasks', JSON.stringify({id: '7'.repeat(32), properties: {}}));
  assert.equal((await storage('knowledge-begin', {id: '7'.repeat(32), session: 'sess-0002'})).status, 409);
  assert.equal((await storage('knowledge-begin', {id: P, session: 'bad'})).status, 400);
});

test('新しい ref 行は予約してから入れ、Reference 以外のページなら戻す', async t => {
  const {sql, env, seed, storage} = setup(t); await seed();
  const NEWREF = '3'.repeat(32), OTHER = '4'.repeat(32);
  t.mock.method(globalThis, 'fetch', async u => {
    const id = new URL(u).pathname.split('/').pop();
    const ds = id === NEWREF ? RDS : '5'.repeat(32);
    return new Response(JSON.stringify({object: 'page', id, last_edited_time: T0, parent: {type: 'data_source_id', data_source_id: ds}, properties: {名前: {type: 'title', title: [{plain_text: 'n'}]}, 移行元: {type: 'rich_text', rich_text: [{plain_text: 'ref/新規.md'}]}}}));
  });
  assert.equal((await storage('capture-page', {id: NEWREF})).status, 409, '予約なしは断る');
  assert.equal((await storage('knowledge-begin', {id: NEWREF, session: 'sess-0003', new: '1'})).status, 200);
  assert.equal((await storage('capture-page', {id: NEWREF})).status, 200);
  assert.equal(sql.prepare('SELECT collection FROM entities WHERE id=?').get(NEWREF).collection, 'reference');
  assert.equal((await storage('knowledge-begin', {id: OTHER, session: 'sess-0003', new: '1'})).status, 200);
  await assert.rejects(storage('capture-page', {id: OTHER}), /not a Reference row/);
  assert.equal(sql.prepare('SELECT COUNT(*) n FROM entities WHERE id=?').get(OTHER).n, 0);
});
