// 知識文書 (PRJ・archive・ref) を Notion から Kairos (D1) へ寄せ切る移行スクリプト (2026-10-29)。設計は docs/knowledge.md。
//
//   node --env-file=.dev.vars scripts/knowledge-migrate.mjs <非公開の出力先> audit [--only=PRJ|archive|ref]
//   node --env-file=.dev.vars scripts/knowledge-migrate.mjs <非公開の出力先> apply --confirm [--accept=<id>,<id>] [--only=…] [--limit=N]
//
// 知識文書は 10/18 の移行で D1 に入っている。ここでやるのは、取り込み後に Notion 側で動いた文書の照合と早送りだけ。
// - Notion へは読み取りだけ (GET と data_sources の query)。書き込みの要求は組み立てた時点で例外にする。
// - Kairos で書いた文書は上書きしない (Worker の knowledge-begin が断る)。ページの時刻だけ動いた文書は、人が中身を見て --accept に並べたものだけ。
// - apply の前に `wrangler d1 export kairos --remote --output <file>` で D1 の控えを取る。取り直す文書の Kairos 側の本文は <出力先>/before/ にも残す。
// 必要な環境変数: APP_TOKEN (Kairos), NOTION_TOKEN (読み取りに使うだけ)。データソース ID は Kairos の /api/storage/sources から引く。
import { mkdir, writeFile, open, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';

export const ORIGIN = 'https://tasks-pwa.masaki-saito.workers.dev';
const clean = id => String(id || '').replace(/-/g, '').toLowerCase();
const plain = a => (a || []).map(x => x.plain_text ?? x.text?.content ?? '').join('');
const later = (a, b) => !!a && (!b || a > b);

/** Notion の読み取り専用クライアント。書き込みになる呼び出しは送る前に断る。 */
export function notionReader(token, { fetchImpl = fetch, delay = () => pause(350) } = {}) {
  return async (method, path, body) => {
    const readOnly = method === 'GET' || (method === 'POST' && /^\/data_sources\/[0-9a-f-]{32,36}\/query$/.test(path));
    if (!readOnly) throw new Error('Notion への書き込みは禁止: ' + method + ' ' + path.split('?')[0]);
    for (let attempt = 0; attempt < 5; attempt++) {
      await delay();
      const r = await fetchImpl('https://api.notion.com/v1' + path, { method, redirect: 'error', signal: AbortSignal.timeout(90000),
        headers: { Authorization: 'Bearer ' + token, 'Notion-Version': '2025-09-03', 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
      if (r.status === 429 || r.status >= 500) { await pause(Math.min(60000, 2000 * (attempt + 1) * (Number(r.headers.get('Retry-After')) || 1))); continue; }
      // 応答本文は出さない (Notion の私的な文面を含みうる)
      if (!r.ok) throw new Error('Notion ' + method + ' ' + path.split('?')[0] + ': HTTP ' + r.status);
      return r.json();
    }
    throw new Error('Notion ' + path.split('?')[0] + ': 再試行を使い切った');
  };
}

async function notionAll(notion, ds) {
  const out = []; let cursor;
  do {
    const r = await notion('POST', '/data_sources/' + ds + '/query', { page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) });
    out.push(...r.results); cursor = r.has_more ? r.next_cursor : null;
  } while (cursor);
  return out;
}
async function notionChildren(notion, id) {
  const out = []; let cursor;
  do {
    const r = await notion('GET', '/blocks/' + id + '/children?page_size=100' + (cursor ? '&start_cursor=' + encodeURIComponent(cursor) : ''));
    out.push(...r.results); cursor = r.has_more ? r.next_cursor : null;
  } while (cursor);
  return out;
}
/** 本文の上の段 (子ページを除く) の件数と最後の更新時刻。saito-tools の notion_knowledge.body_edited() と同じ見方。 */
export function bodyStamp(blocks) {
  const own = blocks.filter(b => b.type !== 'child_page' && !b.archived && !b.in_trash);
  return { top: own.length, edited: own.reduce((m, b) => (later(b.last_edited_time, m) ? b.last_edited_time : m), null) };
}

/**
 * Notion 側の文書と Kairos の一覧を突き合わせて分ける。
 *   same          取り込み後に Notion で本文が動いていない (Kairos で書いていても Kairos が新しいだけ)
 *   fast-forward  Notion で動き、Kairos では書いていない → 取り直す
 *   review        Notion で動き、Kairos ではページの時刻だけ動いている (属性の編集か、入れ子の削除か分からない) → 人が見て --accept
 *   conflict      両方で書いた → 人が突き合わせる (自動では触らない)
 *   new-sub       Notion にだけある子ページ → 親の README を取り直すときに一緒に入る (親が conflict なら残る)
 *   new-ref       Notion にだけある ref 行 → 1行ずつ入れる
 *   new-project   Notion にだけある PRJ/archive 行 → projects は中核コレクションなので自動では足さない
 *   kairos-only   Kairos にだけある (切り替え後に Kairos で作った文書。正常)
 * inspect(id) は Kairos の /api/knowledge/inspect。Notion で動いた文書の分だけ呼ぶ。
 */
export async function classify(notionDocs, kairosDocs, inspect) {
  const byPath = new Map(kairosDocs.map(d => [d.path, d])), seen = new Set(), out = [];
  for (const n of notionDocs) {
    seen.add(n.path);
    const k = byPath.get(n.path);
    if (!k || k.missing) { out.push({ ...n, kairosId: null, class: n.kind === 'sub' ? 'new-sub' : n.kind === 'reference' ? 'new-ref' : 'new-project' }); continue; }
    const moved = later(n.edited, k.captured) || (n.kind !== 'sub' && n.top != null && n.top !== k.topBlocks && later(n.pageEdited, k.captured));
    if (!moved) { out.push({ ...n, kairosId: k.id, class: 'same', kairosEdited: k.kairosEdited }); continue; }
    const state = await inspect(k.id);
    out.push({ ...n, kairosId: k.id, captured: k.captured, inspect: state, class: state.touched ? 'conflict' : state.ambiguous ? 'review' : 'fast-forward' });
  }
  for (const k of kairosDocs) if (!seen.has(k.path)) out.push({ path: k.path, kind: k.kind, kairosId: k.id, class: 'kairos-only' });
  return out;
}

/** Notion の Projects・Reference から知識文書を並べる (読み取りだけ)。 */
export async function notionDocs(notion, sources, only, progress = () => {}) {
  const docs = [];
  const want = p => (!only || p.startsWith(only + '/')) && ['PRJ/', 'archive/', 'ref/'].some(r => p.startsWith(r));
  const projects = (await notionAll(notion, sources.projects)).filter(p => !p.in_trash && !p.archived);
  for (const p of projects) {
    const row = plain(p.properties?.['移行元']?.rich_text).trim();
    if (!want(row) || row.startsWith('ref/')) continue;
    const kids = await notionChildren(notion, p.id), stamp = bodyStamp(kids);
    docs.push({ path: row + '/README.md', kind: 'readme', notionId: clean(p.id), pageEdited: p.last_edited_time, edited: stamp.edited, top: stamp.top });
    for (const c of kids) if (c.type === 'child_page' && !c.archived && !c.in_trash)
      docs.push({ path: row + '/' + c.child_page.title, kind: 'sub', notionId: clean(c.id), parentNotionId: clean(p.id), pageEdited: c.last_edited_time, edited: c.last_edited_time, top: null });
    progress('notion projects: ' + docs.length);
  }
  for (const p of (await notionAll(notion, sources.reference)).filter(p => !p.in_trash && !p.archived)) {
    const path = plain(p.properties?.['移行元']?.rich_text).trim();
    if (!want(path) || !path.startsWith('ref/')) continue;
    docs.push({ path, kind: 'reference', notionId: clean(p.id), pageEdited: p.last_edited_time, edited: null, top: null });
  }
  return docs;
}
/** ref 行は一覧の時刻で足りないときだけ本文を見に行く (500行を超えるので全件は引かない)。 */
async function fillReferenceStamps(notion, docs, kairosByPath) {
  for (const d of docs) if (d.kind === 'reference') {
    const k = kairosByPath.get(d.path);
    if (k && !later(d.pageEdited, k.captured)) { d.edited = null; continue; }
    const stamp = bodyStamp(await notionChildren(notion, d.notionId));
    d.edited = stamp.edited; d.top = stamp.top;
  }
}

export function summarize(rows) {
  const counts = {};
  for (const r of rows) counts[r.class] = (counts[r.class] || 0) + 1;
  const lines = ['# 知識文書の照合 (' + new Date().toISOString() + ')', '', '| 区分 | 件数 |', '|---|---|', ...Object.entries(counts).sort().map(([k, v]) => `| ${k} | ${v} |`), ''];
  for (const cls of ['fast-forward', 'review', 'conflict', 'new-sub', 'new-ref', 'new-project']) {
    const list = rows.filter(r => r.class === cls);
    if (!list.length) continue;
    lines.push('## ' + cls, '');
    for (const r of list) lines.push(`- ${r.path} — Kairos ${r.kairosId || '(無し)'} / Notion ${r.notionId} / Notion本文 ${r.edited || '-'} / 取り込み ${r.captured || '-'}` + (r.inspect ? ` / Kairos編集 ${r.inspect.kairosEdited || '-'} ・ページ ${r.inspect.pageEdited}` : ''));
    lines.push('');
  }
  return { counts, markdown: lines.join('\n') };
}

/** Kairos のクライアント。秘密は Authorization ヘッダーにだけ載せる。 */
export function kairosClient(token, { fetchImpl = fetch, origin = ORIGIN } = {}) {
  return async (method, path) => {
    for (let attempt = 0; attempt < 4; attempt++) {
      const r = await fetchImpl(origin + path, { method, redirect: 'error', signal: AbortSignal.timeout(180000), headers: { Authorization: 'Bearer ' + token } });
      if (r.ok) return r.json();
      const text = await r.text();
      const transient = (r.status === 429 || r.status >= 500) && method === 'GET';
      if (!transient || attempt === 3) { const e = new Error(method + ' ' + path.split('?')[0] + ': HTTP ' + r.status); e.status = r.status; e.body = text.slice(0, 2000); throw e; }
      await pause(2000 * (attempt + 1));
    }
  };
}

/** 1文書を取り直す。Kairos 側の本文を控えてから門を通り、本文・入れ子・新しい子ページ・添付を取り、最後に取り込み時刻を Notion の時刻にする。 */
export async function refreshOne(kairos, row, { session, accept, notionTimes, knownIds, save, delay = () => pause(300), log = () => {} }) {
  const id = row.kairosId || row.notionId, created = [];
  if (row.kairosId) await save('before/' + id + '.json', await dumpBody(kairos, id));
  const qs = new URLSearchParams({ id, session, ...(accept ? { accept: '1' } : {}), ...(row.kairosId ? {} : { new: '1' }) });
  await kairos('POST', '/api/storage/knowledge-begin?' + qs);
  if (!row.kairosId) { await kairos('POST', '/api/storage/capture-page?id=' + id); knownIds.add(id); }
  const queue = [id], assets = [];
  while (queue.length) {
    const target = queue.shift(); let cursor = null;
    do {
      const r = await kairos('POST', '/api/storage/capture-body?' + new URLSearchParams({ id: target, ...(cursor ? { cursor } : {}) }));
      queue.push(...(r.children || []).map(clean));
      for (const page of (r.pages || []).map(clean)) if (!knownIds.has(page)) {
        await kairos('POST', '/api/storage/capture-page?id=' + page);
        knownIds.add(page); created.push(page); queue.push(page);
      }
      assets.push(...(r.assets || []).map(clean));
      cursor = r.next; await delay();
    } while (cursor);
  }
  for (const a of assets) { try { await kairos('POST', '/api/storage/capture-asset?id=' + a); } catch (e) { log('asset ' + a + ' ' + e.message); } }
  for (const page of created) await kairos('POST', '/api/storage/knowledge-end?' + new URLSearchParams({ id: page, session, notion_edited: notionTimes.get(page) || row.edited || row.pageEdited }));
  return kairos('POST', '/api/storage/knowledge-end?' + new URLSearchParams({ id, session, notion_edited: row.edited && later(row.edited, row.pageEdited) ? row.edited : row.pageEdited }));
}
async function dumpBody(kairos, id, depth = 0) {
  const out = []; let cursor;
  do {
    const r = await kairos('GET', '/api/data/blocks/' + id + '/children?page_size=100' + (cursor ? '&start_cursor=' + cursor : ''));
    for (const b of r.results) { if (b.has_children && b.type !== 'child_page' && b.type !== 'child_database' && depth < 8) b._children = await dumpBody(kairos, clean(b.id), depth + 1); out.push(b); }
    cursor = r.has_more ? r.next_cursor : null;
  } while (cursor);
  return out;
}

/** apply で取り直す順: 早送り・人が accept したもの・新しい子ページの親・新しい ref 行。重複は1回に。 */
export function plan(rows, accepted) {
  const pick = new Map();
  const add = (r, accept) => { const key = r.kairosId || r.notionId; if (!pick.has(key)) pick.set(key, { row: r, accept }); };
  for (const r of rows) if (r.class === 'fast-forward') add(r, false);
  for (const r of rows) if ((r.class === 'review' || r.class === 'conflict') && accepted.has(r.kairosId)) add(r, true);
  const readme = new Map(rows.filter(r => r.kind === 'readme').map(r => [r.notionId, r]));
  for (const r of rows) if (r.class === 'new-sub') {
    const parent = readme.get(r.parentNotionId);
    if (parent?.kairosId && (parent.class === 'same' || parent.class === 'fast-forward')) add({ ...parent, edited: parent.edited || parent.pageEdited }, false);
    else if (parent?.kairosId && accepted.has(parent.kairosId)) add(parent, true);
  }
  for (const r of rows) if (r.class === 'new-ref') add(r, false);
  return [...pick.values()];
}

async function main() {
  const [outDir, phase, ...flags] = process.argv.slice(2);
  const opt = Object.fromEntries(flags.map(f => f.replace(/^--/, '').split('=')).map(([k, v]) => [k, v ?? true]));
  if (!outDir || !['audit', 'apply'].includes(phase) || !process.env.APP_TOKEN || !process.env.NOTION_TOKEN)
    throw new Error('Usage: node --env-file=.dev.vars scripts/knowledge-migrate.mjs <private-output-dir> audit|apply [--only=PRJ|archive|ref] [--confirm] [--accept=id,…] [--limit=N] (APP_TOKEN と NOTION_TOKEN が要る)');
  if (opt.only && !['PRJ', 'archive', 'ref'].includes(opt.only)) throw new Error('--only は PRJ / archive / ref');
  if (phase === 'apply' && !opt.confirm) throw new Error('apply は D1 の控え (wrangler d1 export kairos --remote) を取ってから --confirm を付けて動かす');
  const dir = resolve(outDir); await mkdir(join(dir, 'before'), { recursive: true, mode: 0o700 });
  const lock = await open(join(dir, '.knowledge.lock'), 'wx', 0o600);
  const save = (name, value) => writeFile(join(dir, name), typeof value === 'string' ? value : JSON.stringify(value, null, 2), { mode: 0o600 });
  try {
    const kairos = kairosClient(process.env.APP_TOKEN), notion = notionReader(process.env.NOTION_TOKEN);
    const src = (await kairos('GET', '/api/storage/sources')).sources;
    const sources = { projects: clean(src.find(s => s.collection === 'projects')?.id), reference: clean(src.find(s => s.collection === 'reference')?.id) };
    if (!sources.projects || !sources.reference) throw new Error('Kairos に projects / reference のデータソースが無い');
    const kairosDocs = (await kairos('GET', '/api/knowledge/index')).docs.filter(d => !opt.only || d.path.startsWith(opt.only + '/'));
    const nDocs = await notionDocs(notion, sources, opt.only, m => console.log(m));
    await fillReferenceStamps(notion, nDocs, new Map(kairosDocs.map(d => [d.path, d])));
    const rows = await classify(nDocs, kairosDocs, id => kairos('GET', '/api/knowledge/inspect?id=' + id));
    const { counts, markdown } = summarize(rows);
    await save('audit.json', rows); await save('audit.md', markdown);
    console.log('照合:', JSON.stringify(counts), '→', join(dir, 'audit.md'));
    if (phase !== 'apply') return;
    const accepted = new Set(String(opt.accept || '').split(',').map(clean).filter(Boolean));
    const todo = plan(rows, accepted).slice(0, opt.limit ? Number(opt.limit) : undefined);
    const session = 'km-' + randomBytes(6).toString('hex');
    const knownIds = new Set((await kairos('GET', '/api/storage/status?manifest=1')).ids.map(clean));
    const notionTimes = new Map(nDocs.map(d => [d.notionId, d.edited || d.pageEdited]));
    const result = { session, started: new Date().toISOString(), done: [], failed: [] };
    for (const { row, accept } of todo) {
      try {
        const r = await refreshOne(kairos, row, { session, accept, notionTimes, knownIds, save, log: m => console.log(m) });
        result.done.push({ path: row.path, id: r.id, captured: r.captured, openMarks: r.openMarks });
        console.log('取り直した:', row.path);
      } catch (e) {
        result.failed.push({ path: row.path, id: row.kairosId || row.notionId, error: e.message, detail: e.body });
        console.log('失敗:', row.path, e.message);
      }
      await save('apply.json', result);
    }
    result.finished = new Date().toISOString(); await save('apply.json', result);
    console.log(`apply: ${result.done.length} 件取り直し、${result.failed.length} 件失敗 → ${join(dir, 'apply.json')}`);
    if (result.failed.length) process.exitCode = 2;
  } finally { await lock.close(); await rm(join(dir, '.knowledge.lock')); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(e => { console.error(e.message); process.exitCode = 1; });
}
