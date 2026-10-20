import {DatabaseSync} from 'node:sqlite';
import test from 'node:test';
import assert from 'node:assert/strict';
import {initD1, d1Notion} from '../src/d1.js';

// K1（Notion 書き込みゼロ移行）: 単体ブロックの更新・追加コレクションのページのアーカイブ・POST /search。

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
  const env = {DB, TASKS_DATA_SOURCE_ID: 'd'.repeat(32), KAIROS_ORIGIN: 'https://kairos.test', NOTION_TOKEN: 'x', APP_TOKEN: 'y'};
  return {sql, env};
}
const para = (s) => ({type: 'paragraph', paragraph: {rich_text: [{text: {content: s}}]}});
const callout = (s) => ({type: 'callout', callout: {rich_text: [{text: {content: s}}], icon: {emoji: '📌'}}});
const plain = (b) => b[b.type].rich_text.map(x => x.plain_text).join('');
const DS = 'e'.repeat(32);

async function setupPage(t, title = 'P') {
  const {sql, env} = setup(t);
  await initD1(env);
  if (!sql.prepare('SELECT 1 FROM entity_schemas WHERE id=?').get(DS))
    sql.prepare('INSERT INTO entity_schemas VALUES(?,?,?)').run(DS, 'sessions', JSON.stringify({object: 'data_source', properties: {名前: {id: 'title', type: 'title'}}}));
  const mk = async (name) => d1Notion(env, '/pages', {method: 'POST', body: JSON.stringify({parent: {data_source_id: DS}, properties: {名前: {title: [{text: {content: name}}]}}})});
  const p = await mk(title);
  return {env, sql, id: p.id, mk};
}

test('PATCH /blocks/:id: 中身だけ差し替わり、id・順番・種別・アイコンは保たれる。親の更新時刻が進む', async t => {
  const {env, sql, id} = await setupPage(t);
  const path = '/blocks/' + id + '/children';
  await d1Notion(env, path, {method: 'PATCH', body: JSON.stringify({children: [callout('作成中'), para('本文'), para('末尾')]})});
  const kids = await d1Notion(env, path);
  const [banner] = kids.results;
  sql.prepare("UPDATE entities SET payload=json_set(payload,'$.last_edited_time','2000-01-01T00:00:00.000Z') WHERE id=?").run(id.replace(/-/g, ''));
  const out = await d1Notion(env, '/blocks/' + banner.id, {method: 'PATCH', body: JSON.stringify({callout: {rich_text: [{text: {content: 'Kairos が正本'}}]}})});
  assert.equal(out.id, banner.id);
  assert.equal(out.type, 'callout');
  assert.equal(plain(out), 'Kairos が正本');
  assert.deepEqual(out.callout.icon, {emoji: '📌'}); // 渡さなかった項目は残る
  const after = await d1Notion(env, path);
  assert.deepEqual(after.results.map(b => b.type), ['callout', 'paragraph', 'paragraph']);
  assert.equal(plain(after.results[0]), 'Kairos が正本');
  assert.equal(plain(after.results[1]), '本文');
  const edited = JSON.parse(sql.prepare('SELECT payload FROM entities WHERE id=?').get(id.replace(/-/g, '')).payload).last_edited_time;
  assert.ok(edited > '2000-01-01T00:00:00.000Z');
});

test('PATCH /blocks/:id: 別の種別の中身・知らない項目・無い id は失敗し、何も変わらない', async t => {
  const {env, id} = await setupPage(t);
  const path = '/blocks/' + id + '/children';
  await d1Notion(env, path, {method: 'PATCH', body: JSON.stringify({children: [para('a')]})});
  const [b] = (await d1Notion(env, path)).results;
  await assert.rejects(d1Notion(env, '/blocks/' + b.id, {method: 'PATCH', body: JSON.stringify({callout: {rich_text: []}})}), /Unsupported D1 block field/);
  await assert.rejects(d1Notion(env, '/blocks/' + b.id, {method: 'PATCH', body: JSON.stringify({})}), /content required/);
  await assert.rejects(d1Notion(env, '/blocks/' + 'f'.repeat(32), {method: 'PATCH', body: JSON.stringify({paragraph: {rich_text: []}})}), /block not found/);
  assert.equal(plain((await d1Notion(env, path)).results[0]), 'a');
});

test('PATCH /blocks/:id {archived:true}: DELETE と同じく子ごと消える', async t => {
  const {env, sql, id} = await setupPage(t);
  const path = '/blocks/' + id + '/children';
  await d1Notion(env, path, {method: 'PATCH', body: JSON.stringify({children: [para('a'), {type: 'toggle', toggle: {rich_text: [{text: {content: 't'}}], children: [para('kid')]}}]})});
  const toggle = (await d1Notion(env, path)).results[1];
  const before = sql.prepare('SELECT count(*) n FROM entity_children').get().n;
  const out = await d1Notion(env, '/blocks/' + toggle.id, {method: 'PATCH', body: JSON.stringify({archived: true})});
  assert.equal(out.archived, true);
  assert.equal(sql.prepare('SELECT count(*) n FROM entity_children').get().n, before - 2);
});

test('PATCH /pages/:id {archived}: 追加コレクションは通り、/search と query から消える。戻せる', async t => {
  const {env, id} = await setupPage(t, 'ゴミ');
  const hit = async () => (await d1Notion(env, '/search', {method: 'POST', body: JSON.stringify({query: 'ゴミ'})})).results.map(p => p.id);
  assert.deepEqual(await hit(), [id]);
  const out = await d1Notion(env, '/pages/' + id, {method: 'PATCH', body: JSON.stringify({archived: true})});
  assert.equal(out.archived, true);
  assert.deepEqual(await hit(), []);
  const back = await d1Notion(env, '/pages/' + id, {method: 'PATCH', body: JSON.stringify({archived: false})});
  assert.equal(back.archived, false);
  assert.deepEqual(await hit(), [id]);
});

test('PATCH /pages/:id {archived}: 中核コレクション（Tasks など）は拒否する', async t => {
  const {env, sql} = setup(t);
  await initD1(env);
  const tasksDs = 'd'.repeat(32);
  sql.prepare('INSERT INTO entity_schemas VALUES(?,?,?)').run(tasksDs, 'tasks', JSON.stringify({object: 'data_source', properties: {名前: {id: 'title', type: 'title'}}}));
  const p = await d1Notion(env, '/pages', {method: 'POST', body: JSON.stringify({parent: {data_source_id: tasksDs}, properties: {名前: {title: [{text: {content: 'T'}}]}}})});
  await assert.rejects(d1Notion(env, '/pages/' + p.id, {method: 'PATCH', body: JSON.stringify({archived: true})}), /Unsupported D1 page field: archived/);
});

test('POST /search: 更新の新しい順。query はタイトルの部分一致。ページ送りが効く', async t => {
  const {env, sql, id: aid, mk} = await setupPage(t, 'alpha');
  const b = await mk('Beta note');
  const c = await mk('gamma');
  const stamp = (id, ts) => sql.prepare("UPDATE entities SET payload=json_set(payload,'$.last_edited_time',?) WHERE id=?").run(ts, id.replace(/-/g, ''));
  stamp(aid, '2026-10-01T00:00:00.000Z'); stamp(b.id, '2026-10-03T00:00:00.000Z'); stamp(c.id, '2026-10-02T00:00:00.000Z');
  const names = r => r.results.map(p => p.properties.名前.title[0].plain_text);
  const all = await d1Notion(env, '/search', {method: 'POST', body: JSON.stringify({sort: {direction: 'descending', timestamp: 'last_edited_time'}, filter: {property: 'object', value: 'page'}})});
  assert.equal(all.object, 'list');
  assert.deepEqual(names(all), ['Beta note', 'gamma', 'alpha']);
  const asc = await d1Notion(env, '/search', {method: 'POST', body: JSON.stringify({sort: {direction: 'ascending', timestamp: 'last_edited_time'}})});
  assert.deepEqual(names(asc), ['alpha', 'gamma', 'Beta note']);
  assert.deepEqual(names(await d1Notion(env, '/search', {method: 'POST', body: JSON.stringify({query: 'BETA'})})), ['Beta note']);
  const p1 = await d1Notion(env, '/search', {method: 'POST', body: JSON.stringify({page_size: 2})});
  assert.equal(p1.results.length, 2); assert.equal(p1.has_more, true);
  const p2 = await d1Notion(env, '/search', {method: 'POST', body: JSON.stringify({page_size: 2, start_cursor: p1.next_cursor})});
  assert.deepEqual(names(p2), ['alpha']); assert.equal(p2.has_more, false);
});
