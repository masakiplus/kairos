import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {initD1, d1Notion, ensureShopping, ensureSchemaOptions, saleWindowSeeds} from '../src/d1.js';
import {parsePools, poolFor, addMonths, shoppingModel, shopFields, windowFromPage, SALE_WINDOWS_DS, TEMP_BUY_LABEL} from '../src/shopping.js';
// 🛒 買い物画面 (2026-11-02)

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
  const tasksDs = 'd'.repeat(32);
  const env = {DB, DATA_BACKEND: 'd1', TASKS_DATA_SOURCE_ID: tasksDs, KAIROS_ORIGIN: 'https://kairos.test'};
  return {sql, env, tasksDs, writes: () => writes};
}
const taskSchema = {object: 'data_source', properties: {
  名前: {id: 'title', name: '名前', type: 'title', title: {}},
  ラベル: {id: 'l', name: 'ラベル', type: 'multi_select', multi_select: {options: [{id: '1', name: 'Home', color: 'red'}]}},
  金額: {id: 'm', name: '金額', type: 'number', number: {}},
}};

test('ensureShopping: 列・選択肢・セール窓マスターを無いときだけ足し、2 回目は何も書かない', async t => {
  const {sql, env, tasksDs, writes} = setup(t);
  await initD1(env);
  sql.prepare('INSERT INTO entity_schemas VALUES(?,?,?)').run(tasksDs, 'tasks', JSON.stringify(taskSchema));
  assert.ok(await ensureShopping(env) > 0);
  await ensureSchemaOptions(env);
  const before = writes();
  assert.equal(await ensureShopping(env), 0, '2 回目は書かない');
  assert.equal(writes(), before);
  const props = JSON.parse(sql.prepare('SELECT payload FROM entity_schemas WHERE id=?').get(tasksDs).payload).properties;
  assert.deepEqual(props.必要度.select.options.map(o => o.name), ['A 必需・期限あり', 'B 急がない必要品', 'C 欲しいだけ']);
  assert.equal(props.セール窓.relation.data_source_id.replace(/-/g, ''), SALE_WINDOWS_DS);
  assert.deepEqual(props.ラベル.multi_select.options.map(o => o.name), ['Home', TEMP_BUY_LABEL], '既存の選択肢は残して末尾に足す');
  assert.deepEqual(props.名前, taskSchema.properties.名前, 'ほかの列は変えない');
  assert.equal(sql.prepare("SELECT collection FROM entity_schemas WHERE id=?").get(SALE_WINDOWS_DS).collection, 'sale_windows');
  assert.equal(sql.prepare("SELECT COUNT(*) n FROM entities WHERE collection='sale_windows'").get().n, saleWindowSeeds.length);
});

test('タスクにセール窓・必要度・ラベルを書け、セール窓マスターを引ける', async t => {
  const {sql, env, tasksDs} = setup(t);
  await initD1(env);
  sql.prepare('INSERT INTO entity_schemas VALUES(?,?,?)').run(tasksDs, 'tasks', JSON.stringify(taskSchema));
  await ensureShopping(env); await ensureSchemaOptions(env);
  t.mock.method(globalThis, 'fetch', () => { throw new Error('Notion must not be called'); });
  const task = await d1Notion(env, '/pages', {method: 'POST', body: JSON.stringify({parent: {data_source_id: tasksDs}, properties: {名前: {title: [{text: {content: 'トナー'}}]}}})});
  const w = saleWindowSeeds[0].id;
  const out = await d1Notion(env, '/pages/' + task.id, {method: 'PATCH', body: JSON.stringify({properties: {
    セール窓: {relation: [{id: w}]}, 必要度: {select: {name: 'B 急がない必要品'}}, ラベル: {multi_select: [{name: TEMP_BUY_LABEL}]}, 金額: {number: 2799},
  }})});
  assert.deepEqual(out.properties.セール窓.relation.map(r => r.id.replace(/-/g, '')), [w]);
  assert.equal(out.properties.必要度.select.name, 'B 急がない必要品');
  const q = await d1Notion(env, '/data_sources/' + tasksDs + '/query', {method: 'POST', body: JSON.stringify({filter: {or: [{property: '種類', select: {equals: '購入'}}, {property: 'ラベル', multi_select: {contains: TEMP_BUY_LABEL}}]}})});
  assert.equal(q.results.length, 1, 'ラベルだけでも引ける');
  const ws = await d1Notion(env, '/data_sources/' + SALE_WINDOWS_DS + '/query', {method: 'POST', body: JSON.stringify({})});
  const names = ws.results.map(windowFromPage).map(x => x.name);
  assert.ok(names.includes('楽天お買い物マラソン 11月'));
  const m = windowFromPage(ws.results.find(p => p.id.replace(/-/g, '') === w));
  assert.deepEqual([m.start, m.end, m.certainty, m.shop], ['2026-11-04', '2026-11-11', '確定', '楽天']);
});

test('parsePools: 月の見出しの下の discretionary_pool だけを拾う', () => {
  const text = [
    '# 各月: discretionary_pool=裁量枠', '2026-10:', '  monthly_target: 437612', '  discretionary_pool: 155000    # 437612 − …',
    '  necessary_reserve_breakdown:', '    コストコ: 90000', '2026-11:', '  # コメント', '  discretionary_pool: 150000',
    '## 2026-10 から適用する決定', 'discretionary_pool: 1',
  ].join('\n');
  assert.deepEqual(parsePools(text), {'2026-10': 155000, '2026-11': 150000});
  assert.deepEqual(poolFor({'2026-10': 155000, '2026-11': 150000}, '2026-12'), {amount: 150000, month: '2026-11', provisional: true});
  assert.equal(poolFor({}, '2026-12'), null);
  assert.equal(addMonths('2026-12', 1), '2027-01');
  assert.equal(addMonths('2027-01', -1), '2026-12');
});

const win = (id, name, start, end, certainty = '予想') => ({id, name, shop: '楽天', start, end, certainty});
const task = (o) => ({id: o.id, name: o.name ?? o.id, kind: '購入', done: false, labels: [], start: null, owner: null, amount: null, need: null, windowIds: [], created: '2026-11-01', doneAt: null, skipped: false, projectIds: [], ...o});

test('shoppingModel: 区分・並び・冷却・セール窓/引落し月/貯金の集計', () => {
  const windows = [win('bf', 'BF', '2026-11-20', '2026-11-30'), win('mar', 'マラソン', '2026-11-04', '2026-11-11', '確定'), win('ss', 'SS', '2026-12-04', '2026-12-11'), win('old', '終わった窓', '2026-10-01', '2026-10-05')];
  const tasks = [
    task({id: 'ams', kind: '判断', labels: [TEMP_BUY_LABEL], amount: 34800, need: 'C 欲しいだけ', windowIds: ['bf'], created: '2026-10-20'}),
    task({id: 'toner', labels: [TEMP_BUY_LABEL], amount: 2799, need: 'B 急がない必要品', windowIds: ['mar']}),
    task({id: 'tag', amount: 5010, start: '2026-11-11'}),
    task({id: 'nowin', amount: null}),
    task({id: 'xmas', labels: [TEMP_BUY_LABEL], amount: 10000, windowIds: ['ss'], owner: '真実'}),
    task({id: 'notbuy', kind: '作業', amount: 999}),
    task({id: 'bought', done: true, labels: [TEMP_BUY_LABEL], amount: 7000, doneAt: '2026-11-01'}),
    task({id: 'gaveup1', done: true, skipped: true, labels: [TEMP_BUY_LABEL], amount: 3000, doneAt: '2026-09-15'}),
    task({id: 'gaveup2', done: true, skipped: true, labels: [TEMP_BUY_LABEL], amount: 5000, doneAt: '2026-11-02'}),
    task({id: 'skipNoLabel', done: true, skipped: true, amount: 9000, doneAt: '2026-11-02'}),
  ];
  const pools = {'2026-10': 155000, '2026-11': 150000};
  const m = shoppingModel({tasks, windows, pools, today: '2026-11-02'});
  assert.deepEqual(m.items.map(x => x.id), ['toner', 'ams', 'xmas', 'tag', 'nowin'], '窓の開始日順・窓なしは末尾 (開始日順)');
  assert.deepEqual(m.items.filter(x => x.tempBuy).map(x => x.id), ['toner', 'ams', 'xmas']);
  assert.equal(m.items.find(x => x.id === 'ams').cooling, 17, 'C は起票 10/20 から 30 日 → 残り 17 日');
  assert.equal(m.items.find(x => x.id === 'toner').cooling, null, 'B は冷却しない');
  assert.deepEqual(m.windows.map(w => [w.name, w.total, w.count, w.unpriced]), [['マラソン', 2799, 1, 0], ['BF', 34800, 1, 0], ['SS', 10000, 1, 0], ['窓なし', 5010, 2, 1]], '終わった空の窓は出さない');
  assert.deepEqual(m.debit.map(d => [d.month, d.total, d.pool, d.left]), [['2026-12', 2799 + 34800 + 5010, 150000, 150000 - 42609], ['2027-01', 10000, 150000, 140000]]);
  assert.equal(m.debit[0].date, '2026-12-27');
  assert.equal(m.debit[1].poolProvisional, true, '12月の枠は未登録なので 11月の値を暫定で');
  assert.deepEqual(m.savings.map(s => [s.month, s.amount, s.cum]), [['2026-09', 3000, 3000], ['2026-10', 0, 3000], ['2026-11', 5000, 8000]]);
  assert.equal(m.totals.savedAmount, 8000);
  assert.deepEqual([m.totals.count, m.totals.amount, m.totals.unpriced], [5, 52609, 1]);
});

test('shopFields: 金額・必要度・セール窓・見送り・完了日を読む', () => {
  const f = shopFields({created_time: '2026-10-31T16:00:00.000Z', last_edited_time: '2026-11-01T00:00:00.000Z', properties: {
    金額: {type: 'number', number: 2799}, 必要度: {type: 'select', select: {name: 'B 急がない必要品'}},
    セール窓: {type: 'relation', relation: [{id: '5a1ec0de-0000-4b1d-8000-000000001101'}]},
    説明: {type: 'rich_text', rich_text: [{plain_text: '見送り (2026-11-02, PWA)\nなぜ: …'}]}, 完了: {type: 'checkbox', checkbox: true}, 完了日: {type: 'date', date: {start: '2026-11-02'}},
  }});
  assert.deepEqual(f, {amount: 2799, need: 'B 急がない必要品', windowIds: ['5a1ec0de00004b1d8000000000001101'], created: '2026-11-01', doneAt: '2026-11-02', skipped: true});
});

test('画面: 買い物タブ・/api/shopping・描画関数がある', () => {
  const html = readFileSync(new URL('../src/app.html', import.meta.url), 'utf8');
  const idx = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  assert.match(html, /data-v="shop"/);
  assert.match(html, /api\("\/api\/shopping"\)/);
  assert.match(html, /function renderShop\(/);
  assert.match(idx, /path === "\/api\/shopping"/);
});

test('実 Worker: /api/shopping が D1 だけで一覧・窓・引落し月・裁量枠を返し、Notion を呼ばない', async () => {
  const {Miniflare, convertV4MiniflareOptions} = await import('miniflare');
  const src = name => readFileSync(new URL('../src/' + name, import.meta.url), 'utf8');
  const strip = (s) => s.replace(/^import [\s\S]*?;$/gm, '').replace(/^export /gm, '');
  const source = src('lab.js') + '\n' + src('d1.js').replace(/^import .*;$/gm, '') + '\nconst {TEMP_BUY_LABEL,CF_PARAM_PAGE_ID,shopFields,windowFromPage,parsePools,shoppingModel}=(()=>{' + strip(src('shopping.js')).replace(/^const \{ SALE_WINDOWS_DS, TEMP_BUY_LABEL, NEED_OPTIONS \} = SHOP_CONST;$/m, 'const { TEMP_BUY_LABEL } = SHOP_CONST;') + '\nreturn {TEMP_BUY_LABEL,CF_PARAM_PAGE_ID,shopFields,windowFromPage,parsePools,shoppingModel};})();\n' + src('knowledge.js').replace(/^import .*;$/gm, '').replace(/^export /gm, '') + '\n' + src('icons.js').replaceAll('export const ', 'const ') + '\n' + ['APP_HTML', 'SW_JS', 'MANIFEST'].map((name, i) => 'const ' + name + '=' + JSON.stringify(src(['app.html', 'sw.txt', 'manifest.webmanifest'][i])) + ';').join('\n') + '\nconst {isMcpPath,mcpRoute}=(()=>{' + src('mcp.js').replace(/^export /gm, '') + '\nreturn {isMcpPath,mcpRoute};})();\n' + src('index.js').replace(/^import .*\n/gm, '');
  let outbound = 0;
  const mf = new Miniflare(convertV4MiniflareOptions({modules: true, compatibilityDate: '2026-09-01', d1Databases: ['DB'], bindings: {APP_TOKEN: 'test-only-token', DATA_BACKEND: 'd1'}, outboundService: () => { outbound++; return new Response('blocked', {status: 500}); }, script: source}));
  try {
    const db = await mf.getD1Database('DB'); await initD1({DB: db});
    const ds = 'd'.repeat(32), param = '3ea0cdbff88a815b9169ec7d2763f017', today = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
    await db.prepare('INSERT INTO entity_schemas VALUES(?,?,?)').bind(ds, 'tasks', JSON.stringify(taskSchema)).run();
    const t = (id, name, extra) => ({id, created_time: new Date().toISOString(), properties: {名前: {type: 'title', title: [{plain_text: name}]}, 完了: {type: 'checkbox', checkbox: false}, 種類: {type: 'select', select: {name: '購入'}}, ...extra}});
    for (const p of [t('a'.repeat(32), 'トナー', {金額: {type: 'number', number: 2799}}), t('b'.repeat(32), '作業', {種類: {type: 'select', select: {name: '作業'}}})])
      await db.prepare('INSERT INTO entities(id,ds,collection,payload) VALUES(?,?,?,?)').bind(p.id, ds, 'tasks', JSON.stringify(p)).run();
    await db.prepare('INSERT INTO entities(id,ds,collection,payload) VALUES(?,?,?,?)').bind(param, '', 'pages', JSON.stringify({id: param, properties: {}})).run();
    await db.prepare('INSERT INTO entity_bodies VALUES(?,1)').bind(param).run();
    const month = today.slice(0, 7);
    await db.prepare('INSERT INTO entity_children VALUES(?,?,?,?)').bind(param, 'c'.repeat(32), 0, JSON.stringify({id: 'c'.repeat(32), type: 'code', code: {rich_text: [{plain_text: `${month}:\n  discretionary_pool: 150000\n`}]}})).run();
    const api = async (path, body) => { const r = await mf.dispatchFetch('https://kairos.test' + path, {method: body ? 'PATCH' : 'GET', headers: {Authorization: 'Bearer test-only-token', 'Content-Type': 'application/json'}, ...(body ? {body: JSON.stringify(body)} : {})}); return {status: r.status, data: await r.json()}; };
    const first = await api('/api/shopping');
    assert.equal(first.status, 200, JSON.stringify(first.data));
    assert.deepEqual(first.data.items.map(x => x.name), ['トナー']);
    assert.equal(first.data.poolsOk, true);
    assert.equal(first.data.debit[0].pool, 150000);
    assert.ok(first.data.windows.some(w => w.name === '楽天お買い物マラソン 11月' || w.name === '窓なし'));
    // 起動時の移行で足した列に書ける (MCP の kairos_update と同じ口)
    const w = '5a1ec0de00004b1d8000000000001102';
    const upd = await api('/api/data/pages/' + 'a'.repeat(32), {properties: {セール窓: {relation: [{id: w}]}, 必要度: {select: {name: 'B 急がない必要品'}}, ラベル: {multi_select: [{name: '買ったつもり'}]}}});
    assert.equal(upd.status, 200, JSON.stringify(upd.data));
    const after = await api('/api/shopping');
    const item = after.data.items[0];
    assert.equal(item.tempBuy, true);
    assert.equal(item.window.name, 'Amazon ブラックフライデー 2026');
    assert.equal(after.data.totals.tempAmount, 2799);
    assert.equal(outbound, 0);
  } finally { await mf.dispose(); }
});
