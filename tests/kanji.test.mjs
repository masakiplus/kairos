import {DatabaseSync} from 'node:sqlite';
import test from 'node:test';
import assert from 'node:assert/strict';
import {applyGrade, kanjiNorm, reviewAdd, linesPatch, kanjiPutState, kanjiState, kanjiResults, kanjiPutToday, kanjiToday, kanjiPatchFile, parseKanjiVG, kanjiGlyphs, kanjiRoute, kanjiKey} from '../src/kanji.js';

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

test('漢字 SRS: 紗綾の規則 (紙の srs_mark と同じ)', () => {
  const T = '2026-11-07';
  assert.deepEqual(applyGrade('saya', null, 'ok', T), {stage: 1, due: '2026-11-10', shown: 0});
  assert.deepEqual(applyGrade('saya', {stage: 3, due: '2026-11-01', shown: 4}, 'ng', T), {stage: 1, due: '2026-11-10', shown: 0, last_miss: T});
  assert.deepEqual(applyGrade('saya', {stage: 4, due: T, shown: 0}, 'ok', T), {stage: 5, due: null, shown: 0});
  assert.deepEqual(applyGrade('saya', {stage: 2, due: T, shown: 2}, 'hint', T), {stage: 2, due: '2026-11-08', shown: 0});
  assert.equal(kanjiNorm('saya', '決める'), '決');
  assert.equal(kanjiNorm('akito', 'ア'), 'ア');
});

test('漢字 SRS: 明澄の規則 (まちがいは stage0、stage4 で卒業、shown なし)', () => {
  const T = '2026-11-07';
  assert.deepEqual(applyGrade('akito', {stage: 3, due: T}, 'ng', T), {stage: 0, due: '2026-11-08', last_miss: T});
  assert.deepEqual(applyGrade('akito', {stage: 3, due: T}, 'ok', T), {stage: 4, due: null});
});

test('review.txt: 追記と差分適用 (コメント・順序を保つ)', () => {
  assert.deepEqual(reviewAdd('# 見出し\n学\n校\n', ['校', '字']), {text: '# 見出し\n学\n校\n字\n', changed: true});
  assert.equal(reviewAdd('学\n', ['学']).changed, false);
  assert.equal(linesPatch('# c\n学\n校\n字\n', ['六'], ['校']), '# c\n学\n字\n六\n');
});

test('state: 移行 (replace) → 読み出しで同じ dict が返る', async t => {
  const e = env(t);
  const srs = {歌: {stage: 5, due: null, shown: 0}, 声: {stage: 1, due: '2026-11-12', shown: 3, last_miss: '2026-11-01'}};
  await kanjiPutState(e, 'saya', {replace: true, srs, files: {'review.txt': '# x\n歌\n声\n', 'bad.txt': 'x'}});
  const s = await kanjiState(e, 'saya');
  assert.deepEqual(s.srs, srs);
  assert.deepEqual(s.files, {'review.txt': '# x\n歌\n声\n'});
  await kanjiPutState(e, 'saya', {srs: {歌: null}});
  assert.deepEqual(Object.keys((await kanjiState(e, 'saya')).srs), ['声']);
  await kanjiPatchFile(e, 'saya', {name: 'review.txt', add: ['池'], remove: ['歌']});
  assert.equal((await kanjiState(e, 'saya')).files['review.txt'], '# x\n声\n池\n');
});

test('results: 規則で stage を動かし、再送は二重に効かず、retry は記録だけ', async t => {
  const e = env(t);
  await kanjiPutState(e, 'akito', {replace: true, srs: {雨: {stage: 1, due: '2026-11-07'}}, files: {'review.txt': '雨\n'}});
  const T = {today: '2026-11-07'};
  const r1 = await kanjiResults(e, 'akito', [{id: 'a1', key: '雨', grade: 'ok'}, {id: 'a2', key: '空', grade: 'ng'}, {id: 'a3', key: '空', grade: 'ok', retry: true}, {id: 'bad', key: '', grade: 'ok'}], T);
  assert.equal(r1.accepted, 3); assert.equal(r1.applied, 2);
  const s = await kanjiState(e, 'akito');
  assert.deepEqual(s.srs['雨'], {stage: 2, due: '2026-11-14'});
  assert.deepEqual(s.srs['空'], {stage: 0, due: '2026-11-08', last_miss: '2026-11-07'});
  assert.equal(s.files['review.txt'], '雨\n空\n');
  const r2 = await kanjiResults(e, 'akito', [{id: 'a1', key: '雨', grade: 'ok'}], T);
  assert.equal(r2.accepted, 0);
  assert.deepEqual((await kanjiState(e, 'akito')).srs['雨'], {stage: 2, due: '2026-11-14'});
});

test('today: 書き込み・直近日の読み出し・stage の添付', async t => {
  const e = env(t);
  await kanjiPutState(e, 'saya', {srs: {池: {stage: 2, due: '2026-11-09', shown: 0}}});
  await kanjiPutToday(e, 'saya', '2026-11-06', [{key: '池', ans: '池', sentence: '金魚が □に いる。', reading: 'いけ'}, {ans: 'x', sentence: '□のない文'.replace('□', '')}]);
  const r = await kanjiToday(e, 'saya', '2026-11-07');
  assert.equal(r.date, '2026-11-06');
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].stage, 2);
  assert.equal(r.items[0].id, 'saya:2026-11-06:1');
  assert.deepEqual(await kanjiToday(e, 'akito', '2026-11-07'), {child: 'akito', date: null, items: []});
});

test('KanjiVG: 画と番号を順に取り出し、キャッシュする', async t => {
  const svg = '<g><path id="kvg:06c60-s2" kvg:type="x" d="M2,2"/><path id="kvg:06c60-s1" d="M1,1"/></g><text transform="matrix(1 0 0 1 9.5 20)">2</text><text transform="matrix(1 0 0 1 3 4)">1</text>';
  assert.deepEqual(parseKanjiVG(svg), {d: ['M1,1', 'M2,2'], n: [[3, 4], [9.5, 20]]});
  const e = env(t); let calls = 0;
  const fetcher = async (u) => { calls++; return {ok: u.endsWith('06c60.svg'), text: async () => svg}; };
  const g = await kanjiGlyphs(e, '池abc池', fetcher);
  assert.deepEqual(Object.keys(g), ['池']);
  await kanjiGlyphs(e, '池', fetcher);
  assert.equal(calls, 1);
});

test('route: 合鍵は today/results/glyph だけ、state は admin だけ', async t => {
  const e = env(t);
  const json = (o, status = 200) => new Response(JSON.stringify(o), {status, headers: {'content-type': 'application/json'}});
  const assets = {html: '<p>k</p>', sw: '//', manifest: '{}', icon180: '', icon512: ''};
  const call = async (method, p, {admin = false, key = null, body} = {}) => {
    const req = new Request('https://x.test' + p, {method, headers: key ? {'X-Kanji-Key': key} : {}, ...(body ? {body: JSON.stringify(body)} : {})});
    const res = await kanjiRoute(req, e, new URL(req.url), {admin, json, assets});
    return res && {status: res.status, body: res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text()};
  };
  const k = await kanjiKey(e);
  assert.equal(k.length, 32);
  assert.equal((await call('GET', '/kanji/')).body, '<p>k</p>');
  assert.equal(await call('GET', '/api/tasks'), null);
  assert.equal((await call('GET', '/api/kanji/today?child=saya')).status, 401);
  assert.equal((await call('GET', '/api/kanji/today?child=saya', {key: 'wrong'})).status, 401);
  assert.equal((await call('GET', '/api/kanji/today?child=saya', {key: k})).status, 200);
  assert.equal((await call('GET', '/api/kanji/state?child=saya', {key: k})).status, 403);
  assert.equal((await call('GET', '/api/kanji/state?child=saya', {admin: true})).status, 200);
  assert.equal((await call('GET', '/api/kanji/today?child=yuzuki', {key: k})).status, 400);
  const r = await call('POST', '/api/kanji/results', {key: k, body: {child: 'saya', results: [{id: 'z1', key: '池', grade: 'ok'}]}});
  assert.equal(r.body.applied, 1);
  assert.match((await call('GET', '/api/kanji/link', {admin: true})).body.url, /\/kanji\/#key=[0-9a-f]{32}$/);
});
