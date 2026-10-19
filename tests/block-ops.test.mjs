import {DatabaseSync} from 'node:sqlite';
import test from 'node:test';
import assert from 'node:assert/strict';
import {initD1, d1Notion} from '../src/d1.js';

// ブロックの「この後ろに挿入 (after)」と「削除 (DELETE /blocks/:id)」。location-sync が日報の節を差し替えるのに使う。
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
const texts = (r) => r.results.map(b => b.paragraph.rich_text[0].plain_text);

async function page(t) {
  const {sql, env} = setup(t);
  await initD1(env);
  const ds = 'e'.repeat(32);
  sql.prepare('INSERT INTO entity_schemas VALUES(?,?,?)').run(ds, 'sessions', JSON.stringify({object: 'data_source', properties: {名前: {id: 'title', type: 'title'}}}));
  const p = await d1Notion(env, '/pages', {method: 'POST', body: JSON.stringify({parent: {data_source_id: ds}, properties: {名前: {title: [{text: {content: 'P'}}]}}})});
  return {env, sql, id: p.id};
}

test('after: 指定ブロックの直後に入り、後ろの順番はずれない', async t => {
  const {env, id} = await page(t);
  const path = '/blocks/' + id + '/children';
  await d1Notion(env, path, {method: 'PATCH', body: JSON.stringify({children: [para('a'), para('b'), para('c')]})});
  const kids = await d1Notion(env, path);
  const r = await d1Notion(env, path, {method: 'PATCH', body: JSON.stringify({children: [para('x'), para('y')], after: kids.results[0].id})});
  assert.equal(r.results.length, 2);
  assert.deepEqual(texts(await d1Notion(env, path)), ['a', 'x', 'y', 'b', 'c']);
  // 連続挿入 (返ってきた最後の id を次の after に使う)
  await d1Notion(env, path, {method: 'PATCH', body: JSON.stringify({children: [para('z')], after: r.results[1].id})});
  assert.deepEqual(texts(await d1Notion(env, path)), ['a', 'x', 'y', 'z', 'b', 'c']);
});

test('after: 無い id は失敗し、何も入らない', async t => {
  const {env, id} = await page(t);
  const path = '/blocks/' + id + '/children';
  await d1Notion(env, path, {method: 'PATCH', body: JSON.stringify({children: [para('a')]})});
  await assert.rejects(d1Notion(env, path, {method: 'PATCH', body: JSON.stringify({children: [para('x')], after: 'f'.repeat(32)})}), /after block not found/);
  assert.deepEqual(texts(await d1Notion(env, path)), ['a']);
});

test('DELETE /blocks/:id: 子ごと消え、親の更新時刻が進む。無い id は失敗', async t => {
  const {env, sql, id} = await page(t);
  const path = '/blocks/' + id + '/children';
  await d1Notion(env, path, {method: 'PATCH', body: JSON.stringify({children: [para('a'), {type: 'toggle', toggle: {rich_text: [{text: {content: 't'}}], children: [para('kid')]}}, para('c')]})});
  const kids = await d1Notion(env, path);
  const toggle = kids.results[1];
  const before = sql.prepare('SELECT count(*) n FROM entity_children').get().n;
  const out = await d1Notion(env, '/blocks/' + toggle.id, {method: 'DELETE'});
  assert.equal(out.archived, true);
  assert.equal(sql.prepare('SELECT count(*) n FROM entity_children').get().n, before - 2);
  const left = await d1Notion(env, path);
  assert.deepEqual(left.results.map(b => b.type), ['paragraph', 'paragraph']);
  await assert.rejects(d1Notion(env, '/blocks/' + toggle.id, {method: 'DELETE'}), /block not found/);
});
