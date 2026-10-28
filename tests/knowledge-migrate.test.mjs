import test from 'node:test';
import assert from 'node:assert/strict';
import {notionReader, bodyStamp, classify, plan, refreshOne, summarize} from '../scripts/knowledge-migrate.mjs';

const T0 = '2026-10-18T00:00:00.000Z', T1 = '2026-10-22T00:00:00.000Z', T2 = '2026-10-25T00:00:00.000Z';

test('Notion へは読み取りだけ: 書き込みになる要求は送る前に断る', async () => {
  const sent = [];
  const notion = notionReader('tok', {delay: async () => {}, fetchImpl: async (u, init) => {sent.push(init.method + ' ' + u); return new Response('{"results":[]}');}});
  await notion('GET', '/blocks/' + 'a'.repeat(32) + '/children');
  await notion('POST', '/data_sources/' + 'b'.repeat(32) + '/query', {page_size: 100});
  for (const [m, p] of [['PATCH', '/pages/x'], ['POST', '/pages'], ['DELETE', '/blocks/x'], ['PATCH', '/blocks/x/children'], ['POST', '/search']])
    await assert.rejects(notion(m, p, {}), /書き込みは禁止/);
  assert.equal(sent.length, 2);
});

test('本文の時刻は子ページを除いた上の段で見る', () => {
  assert.deepEqual(bodyStamp([{type: 'paragraph', last_edited_time: T1}, {type: 'child_page', last_edited_time: T2}, {type: 'callout', last_edited_time: T0}]), {top: 2, edited: T1});
});

test('照合: 動いていない・早送り・要確認・衝突・Notion だけ・Kairos だけを分ける', async () => {
  const notion = [
    {path: 'PRJ/A/README.md', kind: 'readme', notionId: 'n1', pageEdited: T1, edited: T0, top: 3},
    {path: 'PRJ/B/README.md', kind: 'readme', notionId: 'n2', pageEdited: T1, edited: T1, top: 3},
    {path: 'PRJ/C/README.md', kind: 'readme', notionId: 'n3', pageEdited: T1, edited: T1, top: 3},
    {path: 'PRJ/D/README.md', kind: 'readme', notionId: 'n4', pageEdited: T1, edited: T1, top: 3},
    {path: 'PRJ/A/新規.md', kind: 'sub', notionId: 'n5', parentNotionId: 'n1', pageEdited: T1, edited: T1},
    {path: 'ref/新規.md', kind: 'reference', notionId: 'n6', pageEdited: T1, edited: T1},
    {path: 'PRJ/E/README.md', kind: 'readme', notionId: 'n7', pageEdited: T1, edited: T0, top: 4},
  ];
  const k = (path, id, extra = {}) => ({path, id, kind: 'readme', captured: T0, topBlocks: 3, ...extra});
  const kairos = [k('PRJ/A/README.md', 'k1', {kairosEdited: T2}), k('PRJ/B/README.md', 'k2'), k('PRJ/C/README.md', 'k3'), k('PRJ/D/README.md', 'k4'), k('PRJ/E/README.md', 'k7'), k('PRJ/Z/README.md', 'k9')];
  const states = {k2: {touched: false, ambiguous: false}, k3: {touched: true, ambiguous: false}, k4: {touched: false, ambiguous: true}, k7: {touched: false, ambiguous: false}};
  const asked = [];
  const rows = await classify(notion, kairos, async id => {asked.push(id); return states[id];});
  const cls = Object.fromEntries(rows.map(r => [r.path, r.class]));
  assert.deepEqual(cls, {'PRJ/A/README.md': 'same', 'PRJ/B/README.md': 'fast-forward', 'PRJ/C/README.md': 'conflict', 'PRJ/D/README.md': 'review', 'PRJ/A/新規.md': 'new-sub', 'ref/新規.md': 'new-ref', 'PRJ/E/README.md': 'fast-forward', 'PRJ/Z/README.md': 'kairos-only'});
  assert.deepEqual(asked.sort(), ['k2', 'k3', 'k4', 'k7'], '動いたものだけ Kairos に問い合わせる');
  const todo = plan(rows, new Set(['k4']));
  assert.deepEqual(todo.map(t => [t.row.path, t.accept]), [['PRJ/B/README.md', false], ['PRJ/E/README.md', false], ['PRJ/D/README.md', true], ['PRJ/A/README.md', false], ['ref/新規.md', false]]);
  assert.match(summarize(rows).markdown, /\| conflict \| 1 \|/);
});

test('取り直し: 控え→門→本文と入れ子→新しい子ページ→終わり の順に呼ぶ', async () => {
  const calls = [], saved = [];
  const kairos = async (method, path) => {
    calls.push(method + ' ' + path.replace(/session=[^&]+/, 'session=S'));
    if (path.startsWith('/api/data/blocks/')) return {results: [{id: 'b1', type: 'paragraph', has_children: false}], has_more: false};
    if (path.startsWith('/api/storage/capture-body?id=k1')) return {n: 2, next: null, children: ['nest'], pages: ['oldsub', 'newsub'], assets: ['file1']};
    if (path.startsWith('/api/storage/capture-body')) return {n: 1, next: null, children: [], pages: [], assets: []};
    if (path.startsWith('/api/storage/knowledge-end')) return {id: 'k1', captured: T1, openMarks: []};
    return {};
  };
  const row = {path: 'PRJ/A/README.md', kairosId: 'k1', notionId: 'k1', pageEdited: T1, edited: T0};
  await refreshOne(kairos, row, {session: 'S', accept: false, notionTimes: new Map([['newsub', T2]]), knownIds: new Set(['oldsub']), save: async n => saved.push(n), delay: async () => {}});
  assert.deepEqual(saved, ['before/k1.json']);
  assert.deepEqual(calls, [
    'GET /api/data/blocks/k1/children?page_size=100',
    'POST /api/storage/knowledge-begin?id=k1&session=S',
    'POST /api/storage/capture-body?id=k1',
    'POST /api/storage/capture-page?id=newsub',
    'POST /api/storage/capture-body?id=nest',
    'POST /api/storage/capture-body?id=newsub',
    'POST /api/storage/capture-asset?id=file1',
    'POST /api/storage/knowledge-end?id=newsub&session=S&notion_edited=2026-10-25T00%3A00%3A00.000Z',
    'POST /api/storage/knowledge-end?id=k1&session=S&notion_edited=2026-10-22T00%3A00%3A00.000Z',
  ]);
});
