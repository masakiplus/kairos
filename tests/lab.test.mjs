import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import assert from 'node:assert/strict';

// Worker の .js を ESM として読む。package 全体のモジュール形式は変えない。
const { labRoute } = await import(`data:text/javascript;base64,${Buffer.from(readFileSync(new URL('../src/lab.js', import.meta.url))).toString('base64')}`);
const id = 'a'.repeat(32), other = 'b'.repeat(32);
function fixture(t) {
  const sql = new DatabaseSync(':memory:');
  t.after(() => sql.close());
  const DB = {
    prepare(query) {
      const statement = sql.prepare(query);
      let params = [];
      return {
        bind(...values) { params = values; return this; },
        async run() { return statement.run(...params); },
        async all() { return { results: statement.all(...params) }; },
        async first() { return statement.get(...params) ?? null; },
      };
    },
    async batch(statements) {
      sql.exec('BEGIN');
      try { const result = []; for (const s of statements) result.push(await s.all()); sql.exec('COMMIT'); return result; }
      catch (e) { sql.exec('ROLLBACK'); throw e; }
    },
  };
  const route = async (path, body) => {
    const url = new URL(`https://kairos.test/api/lab/${path}`);
    const req = new Request(url, { method: body === undefined ? 'GET' : 'POST', ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return labRoute(req, { DB }, url, (body, status = 200) => ({ status, body }));
  };
  const seed = (rowId = id) => sql.prepare(`INSERT INTO docs (id, collection, title, props, body_md, created, updated, body_status, conv)
    VALUES (?, 'tasks', ?, ?, ?, '2026-10-17T00:00:00Z', '2026-10-17T00:00:00Z', 'done', ?)`)
    .run(rowId, '日本語: "題名"', '{"a":1,"z":{"x":true}}', '\n本文\n---\n```js\nconst x = 1;\n```\n', '{"missing":0,"lossy":{},"truncated":false}');
  return { sql, route, seed };
}
async function roundtrip(route) {
  const exported = await route('export');
  const imported = await route('import-md', { files: exported.body.files });
  assert.equal(imported.status, 200);
  return exported.body.files;
}

test('空の DB を合格にしない', async (t) => {
  const { route } = fixture(t); await route('init', {});
  const { body } = await route('compare');
  assert.equal(body.ok, false); assert.equal(body.roundtrip_ok, false);
});

test('日本語・先頭末尾改行・区切り・コード・全メタデータの往復', async (t) => {
  const { route, seed, sql } = fixture(t); await route('init', {}); seed();
  await roundtrip(route);
  const { body } = await route('compare');
  assert.equal(body.ok, true); assert.equal(body.roundtrip_ok, true); assert.deepEqual(body.examples, []);
  assert.equal(sql.prepare('SELECT body_md FROM docs_rt').get().body_md, sql.prepare('SELECT body_md FROM docs').get().body_md);
});

test('不足行・余分な行・タイトル/属性/本文/メタデータ差分を検出', async (t) => {
  const { route, seed, sql } = fixture(t); await route('init', {}); seed(); await roundtrip(route);
  const changes = [ ['title', '別名', 'title_diff'], ['props', '{}', 'props_diff'], ['body_md', '欠落', 'body_diff'],
    ['collection', 'roles', 'meta_diff'], ['parent_id', other, 'meta_diff'], ['created', null, 'meta_diff'],
    ['updated', '', 'meta_diff'], ['version', 2, 'meta_diff'] ];
  for (const [column, value, count] of changes) {
    await roundtrip(route);
    sql.prepare(`UPDATE docs_rt SET ${column} = ?`).run(value);
    const { body } = await route('compare');
    assert.equal(body[count], 1, column); assert.equal(body.ok, false); assert.deepEqual(body.examples, [id]);
  }
  sql.exec('DELETE FROM docs_rt');
  assert.equal((await route('compare')).body.missing_in_rt, 1);
  await roundtrip(route);
  sql.prepare('UPDATE docs_rt SET id = ?').run(other);
  const { body } = await route('compare');
  assert.equal(body.extra_in_rt, 1); assert.equal(body.missing_in_rt, 1); assert.deepEqual(body.examples, [id, other]);
});

test('内容が一致しても本文未取得・切断・変換欠落・部分属性は不合格', async (t) => {
  const { route, seed, sql } = fixture(t); await route('init', {}); seed();
  for (const status of ['pending', 'error', 'truncated']) {
    sql.prepare('UPDATE docs SET body_status = ?').run(status); await roundtrip(route);
    const { body } = await route('compare');
    assert.equal(body.roundtrip_ok, true); assert.equal(body.ok, false); assert.equal(body.incomplete_bodies, 1);
  }
  sql.exec("UPDATE docs SET body_status = 'done'");
  for (const conv of [null, 'broken', '{}', 'null', '{"missing":0}', '{"missing":1}', '{"truncated":true}', '{"lossy":{"image":1}}', '{"error":"failed"}']) {
    sql.prepare('UPDATE docs SET conv = ?').run(conv);
    assert.equal((await route('compare')).body.ok, false, conv);
  }
  sql.exec(`UPDATE docs SET conv = '{"missing":0}', props = '{"関連__more":true}'`); await roundtrip(route);
  assert.equal((await route('compare')).body.partial_props, 1);
});

test('不正な取込はバッチ全体を拒否し既存行を守る', async (t) => {
  const { route, seed, sql } = fixture(t); await route('init', {}); seed();
  const [file] = await roundtrip(route);
  const invalid = [null, {}, [], 'bad', file.text.replace(`id: ${id}`, 'id: ../bad'),
    file.text.replace('version: 1', 'version: 1x'), file.text.replace('version: 1', 'version: 0'),
    file.text.replace('props: {"a":1,"z":{"x":true}}', 'props: []'),
    file.text.replace(/^title: .*$/m, 'title: null'),
    file.text.replace('collection: tasks\n', ''), file.text.replace('version: 1', 'version: 1\nversion: 2')];
  for (const text of invalid) {
    const res = await route('import-md', { files: [{ text: file.text.replace(`id: ${id}`, `id: ${other}`) }, { text }] });
    assert.equal(res.status, 400, String(text)); assert.equal(res.body.n, 0);
    assert.equal(sql.prepare('SELECT COUNT(*) n FROM docs_rt').get().n, 1);
  }
  assert.equal((await route('import-md', { files: [file, file] })).status, 400);
  for (const body of [null, {}, { files: [] }, { files: 'bad' }, { files: Array(501).fill(file) }]) {
    assert.equal((await route('import-md', body)).status, 400);
  }
  assert.equal((await route('compare')).body.ok, true);
});

test('壊れた属性 JSON が両側で一致しても合格にしない', async (t) => {
  const { route, seed, sql } = fixture(t); await route('init', {}); seed(); await roundtrip(route);
  for (const props of ['broken', 'null', '[]']) {
    sql.prepare('UPDATE docs SET props = ?').run(props);
    sql.prepare('UPDATE docs_rt SET props = ?').run(props);
    const { body } = await route('compare');
    assert.equal(body.roundtrip_ok, true); assert.equal(body.invalid_props, 1); assert.equal(body.ok, false);
  }
});

test('未知の Notion ブロックは変換欠落として報告する', async (t) => {
  const { route, seed } = fixture(t); await route('init', {}); seed();
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => Response.json({ results: [{ id, type: 'future_block', future_block: {} }], has_more: false });
  const converted = await route(`body?id=${id}`, {});
  assert.deepEqual(converted.body.lossy, { future_block: 1 });
  await roundtrip(route);
  assert.equal((await route('compare')).body.conversion_issues, 1);
  assert.equal((await route('compare')).body.ok, false);
});
