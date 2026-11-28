import {DatabaseSync} from 'node:sqlite';
import test from 'node:test';
import assert from 'node:assert/strict';
import {initD1, d1Notion, ensureMacJobs, MAC_JOBS_CONST} from '../src/d1.js';
const MAC_JOBS_DS = MAC_JOBS_CONST.DS;
// 🖥 Mac ジョブ (2026-11-28): 追加コレクション mac_jobs の受け口

function setup(t) {
  const sql = new DatabaseSync(':memory:'); t.after(() => sql.close());
  let writes = 0;
  const DB = {
    prepare(query) {
      let args = [];
      return { sel: /^\s*select/i.test(query),
        bind(...v) { args = v; return this; },
        async run() { writes++; return sql.prepare(query).run(...args); },
        async all() { return {results: sql.prepare(query).all(...args)}; },
        async first() { return sql.prepare(query).get(...args) ?? null; },
      };
    },
    async batch(stmts) { const out = []; for (const s of stmts) out.push(await (s.sel ? s.all() : s.run())); return out; },
  };
  const env = {DB, DATA_BACKEND: 'd1', TASKS_DATA_SOURCE_ID: 'd'.repeat(32), KAIROS_ORIGIN: 'https://kairos.test'};
  return {sql, env, writes: () => writes};
}
const txt = s => ({rich_text: [{text: {content: s}}]});

test('ensureMacJobs: 無いときだけ表を作り、2 回目は書かない', async t => {
  const {sql, env, writes} = setup(t);
  await initD1(env);
  assert.equal(await ensureMacJobs(env), 1);
  const before = writes();
  assert.equal(await ensureMacJobs(env), 0);
  assert.equal(writes(), before, '2 回目は書かない');
  assert.equal(sql.prepare('SELECT collection FROM entity_schemas WHERE id=?').get(MAC_JOBS_DS).collection, 'mac_jobs');
});

test('依頼を書き、待ちを引いて、結果を書き戻せる', async t => {
  const {env} = setup(t);
  await initD1(env); await ensureMacJobs(env);
  t.mock.method(globalThis, 'fetch', () => { throw new Error('Notion must not be called'); });
  const job = await d1Notion(env, '/pages', {method: 'POST', body: JSON.stringify({parent: {data_source_id: MAC_JOBS_DS}, properties: {
    名前: {title: [{text: {content: 'ping'}}]}, 引数: txt('{}'), 状態: {select: {name: '待ち'}}, 依頼元: txt('Duet テスト'),
  }})});
  await d1Notion(env, '/pages', {method: 'POST', body: JSON.stringify({parent: {data_source_id: MAC_JOBS_DS}, properties: {
    名前: {title: [{text: {content: 'vault_backup'}}]}, 状態: {select: {name: '完了'}},
  }})});
  const q = await d1Notion(env, '/data_sources/' + MAC_JOBS_DS + '/query', {method: 'POST', body: JSON.stringify({filter: {property: '状態', select: {equals: '待ち'}}})});
  assert.deepEqual(q.results.map(p => p.id), [job.id]);
  const out = await d1Notion(env, '/pages/' + job.id, {method: 'PATCH', body: JSON.stringify({properties: {
    状態: {select: {name: '完了'}}, 終了コード: {number: 0}, 開始: {date: {start: '2026-11-28T11:00:00+09:00'}},
    終了: {date: {start: '2026-11-28T11:00:05+09:00'}}, 結果: txt('pong'), 成果物: {url: 'https://drive.google.com/drive/folders/x'},
  }})});
  assert.equal(out.properties.状態.select.name, '完了');
  assert.equal(out.properties.終了コード.number, 0);
  assert.equal(out.properties.成果物.url, 'https://drive.google.com/drive/folders/x');
  assert.equal(out.properties.結果.rich_text.map(x => x.plain_text ?? x.text?.content).join(''), 'pong');
});
