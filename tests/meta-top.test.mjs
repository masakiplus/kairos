import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const html = await readFile(new URL('../src/app.html', import.meta.url), 'utf8');

// 2026-11-14 利用者「まとめて棚卸しするボタンは各タブの一番上におく」。metaHtml は一覧の先頭に置き、末尾には足さない。
test('画面: まとめてボタン (metaHtml) は各タブの一番上に置く', () => {
  const heads = html.match(/list\.innerHTML = metaHtml\((?:view|"roles"|"review")\) \+/g) || [];
  assert.equal(heads.length, 4); // 一覧タブ・役割・決める (問いなし／問いあり)
  assert.doesNotMatch(html, /\+ metaHtml\([^)]*\);/); // 末尾に連結していない
  assert.match(html, /<div class="meta top">/);
  assert.match(html, /\.meta\.top\{margin-top:0\}/);
});

// 2026-11-15 位置づけの決め直し (docs/rules.md §9-2)。metaHtml とその部品だけを切り出して、タブごとのラベルと依頼文を見張る
function harness({ provider = 'claude', filtered = false, quiet = false, roles = null } = {}) {
  const pick = (from, to) => html.slice(html.indexOf(from), html.indexOf(to, html.indexOf(from)));
  const src = pick('  const META_TAIL = ', '  // ---- いまの状況') + pick('  function metaList(v, ts) {', '  // 📁 PJ を選んだときの 2 ボタン') +
    '\n  function taskLines(ts, n = 12) { const a = ts.slice(0, n).map((t, i) => `${i + 1}. ${t.name}（${t.url}）`); return a.join("、") + (ts.length > n ? `、…ほか ${ts.length - n} 件` : ""); }';
  const tasks = Array.from({ length: 23 }, (_, i) => ({ name: 'タスク' + (i + 1), url: 'https://k.test/?page=' + i, done: false, env: i === 0 ? ['早朝'] : [], blocked: false }));
  const context = {
    tasks, aiProvider: provider, filt: {}, filterOn: () => filtered, aiName: () => 'Claude', aiIcon: () => '🤖', claudeLink: (q) => 'Q:' + encodeURIComponent(q),
    currentSit: () => ({ quiet, place: '自宅', tools: ['スマホ'], morning: quiet }), TOOL_LABEL: { 'スマホ': 'スマホ' },
    projInfo: [{ label: 'PJ1', url: 'https://k.test/p1', goal: 'g', closable: false }], rolesData: roles,
    reviewAll: () => [], REVIEW_POLICY: ['調べる'], OPT_FORMAT: '[案]', numbered: (a) => a.join('\n'), reviewItems: () => '',
  };
  runInNewContext(src + '\nglobalThis.metaHtml = metaHtml;', context);
  const out = (v) => { const h = context.metaHtml(v); const m = h.match(/href="Q:([^"]*)"[^>]*data-meta="([^"]*)">🤖 ([^<]*)<\/a>/); return m ? { q: decodeURIComponent(m[1]), key: m[2], label: m[3], html: h } : null; };
  return { out };
}

test('今日やる＝実行するボタン。一覧は貼らずコネクタで読ませ、順番は聞かせない', () => {
  const b = harness().out('today');
  assert.equal(b.label, 'Claude とまとめて進める'); assert.equal(b.key, 'today');
  assert.match(b.q, /上から順に実際に進めてください/);
  assert.match(b.q, /kairos_list_tasks（view=today）/); assert.match(b.q, /いま 23 件/);
  assert.doesNotMatch(b.q, /タスク13/); assert.doesNotMatch(b.q, /…ほか/); // 12 件で切れる貼り付けをしない
  assert.match(b.q, /人対応 にする/); assert.doesNotMatch(b.q, /判断は一問一答で 1 件ずつ聞いてください/);
});

test('今日できる＝選んでから実行するボタン', () => {
  const b = harness().out('can');
  assert.equal(b.label, 'Claude と選んで進める'); assert.equal(b.key, 'can');
  assert.match(b.q, /今やるべきものを決めて、実際に進めてください/); assert.match(b.q, /開始日 を今日にする/);
});

test('着手中・委任＝まとめて片付ける (先に調べ、割れるものだけ聞く)', () => {
  const h = harness();
  for (const v of ['doing', 'delegated']) { const b = h.out(v); assert.equal(b.label, 'Claude とまとめて片付ける'); assert.equal(b.key, v); assert.match(b.q, /本人にしか決められないものだけ/); }
  assert.match(h.out('doing').q, /実は終わっているものは完了処理する/);
});

test('スキルがあるタブは手順を書かずスキルを呼ぶ。スキルの無い AI アプリには手順を渡す', () => {
  const c = harness();
  assert.match(c.out('project').q, /^projects-qa-review スキルで/); assert.doesNotMatch(c.out('project').q, /進め方\n/);
  assert.match(c.out('roles').q, /^weekly-role-review スキルで/);
  assert.match(c.out('review').q, /^decisions-qa-review スキルで/);
  const g = harness({ provider: 'chatgpt' });
  assert.doesNotMatch(g.out('project').q, /スキル/); assert.match(g.out('project').q, /対応ゴールは妥当か/);
  assert.doesNotMatch(g.out('roles').q, /スキル/); assert.doesNotMatch(g.out('review').q, /スキル/);
});

test('役割: 全役割に石があり未達成が残る週は「進み具合を見る」に切り替わる', () => {
  const set = { roles: [{ stone: { state: 'doing' } }, { stone: { state: 'todo' } }], summary: { total: 2, done: 0 } };
  const b = harness({ roles: set }).out('roles');
  assert.equal(b.key, 'roles-progress'); assert.match(b.label, /今週の石の進み具合を見る/); assert.match(b.q, /石は決め直さず/);
  const gap = { roles: [{ stone: { state: 'doing' } }, { stone: null }], summary: { total: 1, done: 0 } };
  assert.equal(harness({ roles: gap }).out('roles').key, 'roles');
  const alldone = { roles: [{ stone: { state: 'done' } }], summary: { total: 1, done: 1 } };
  assert.equal(harness({ roles: alldone }).out('roles').key, 'roles');
});

test('絞り込み中と Claude 以外には一覧を貼る。早朝の窓は「早朝の 1 本を進める」', () => {
  assert.match(harness({ filtered: true }).out('today').q, /対象 23 件: 1\. タスク1（/);
  assert.match(harness({ provider: 'chatgpt' }).out('doing').q, /対象 23 件: 1\. タスク1（/);
  const m = harness({ quiet: true }).out('today');
  assert.equal(m.key, 'morning'); assert.equal(m.label, 'Claude と早朝の 1 本を進める'); assert.match(m.q, /実際に進めてください/);
});

test('タップ計測: まとめてボタンを meta:<タブ> で数える', () => {
  assert.match(html, /if \(b\.dataset\.meta\) return "meta:" \+ b\.dataset\.meta;/);
  assert.match(html, /closest\("button, a\[data-ai\], a\[data-meta\]"\)/);
  assert.match(html, /data-ext data-meta="prep"/);
});
