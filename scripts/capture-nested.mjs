// 追加コレクション (daily・dreamtime・reference など) の未取得の入れ子 (表の行・入れ子の箇条書き) を Notion から D1 へ埋める (2026-11-01)。
// Worker の /api/storage/capture-nested を、返る children がなくなるまで下へ呼ぶだけ。Notion を読むのは Worker 側の NOTION_TOKEN。
// 親の本文は消さないので、切り替え後に Kairos で書いた日報はそのまま残る (設計は src/nested.js の冒頭)。
//
//   node --env-file=.dev.vars scripts/capture-nested.mjs <非公開の出力先> list [--coll=daily]
//   node --env-file=.dev.vars scripts/capture-nested.mjs <非公開の出力先> apply --confirm [--coll=daily] [--limit=N]
//
// apply の前に `npx wrangler d1 export kairos --remote --output <file>` で D1 の控えを取る。
// 必要な環境変数: APP_TOKEN (Kairos)。
import { mkdir, writeFile, open, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';
import { kairosClient } from './knowledge-migrate.mjs';

const clean = id => String(id || '').replace(/-/g, '').toLowerCase();

/** 1つの入れ子を、その下の入れ子・添付まで含めて取り込む。 */
export async function fillOne(kairos, id, { delay = () => pause(250), log = () => {} } = {}) {
  const queue = [clean(id)], assets = [], pages = [];
  let blocks = 0, nested = 0;
  while (queue.length) {
    const target = queue.shift(); let cursor = null;
    do {
      const r = await kairos('POST', '/api/storage/capture-nested?' + new URLSearchParams({ id: target, ...(cursor ? { cursor } : {}) }));
      blocks += r.n || 0;
      queue.push(...(r.children || []).map(clean));
      assets.push(...(r.assets || []).map(clean));
      pages.push(...(r.pages || []).map(clean));
      cursor = r.next; await delay();
    } while (cursor);
    nested++;
  }
  const assetErrors = [];
  for (const a of assets) {
    try { await kairos('POST', '/api/storage/capture-asset?id=' + a); }
    catch (e) { assetErrors.push({ id: a, error: e.message }); log('添付を取れなかった: ' + a + ' ' + e.message); }
  }
  // 入れ子の中の子ページは別の文書なので、ここでは取らずに件数だけ返す
  return { blocks, nested, assets: assets.length, assetErrors, pages };
}

export function parseArgs(argv) {
  const [dir, phase, ...rest] = argv, opt = {};
  for (const a of rest) { const m = a.match(/^--([a-z]+)(?:=(.*))?$/); if (m) opt[m[1]] = m[2] ?? true; }
  return { dir, phase, opt };
}

export async function main(argv = process.argv.slice(2)) {
  const { dir: out, phase, opt } = parseArgs(argv);
  if (!out || !['list', 'apply'].includes(phase)) throw new Error('使い方: capture-nested.mjs <出力先> list|apply [--confirm] [--coll=] [--limit=N]');
  if (phase === 'apply' && !opt.confirm) throw new Error('apply には --confirm が要る (先に D1 の控えを取る)');
  if (!process.env.APP_TOKEN) throw new Error('APP_TOKEN が無い');
  const dir = resolve(out); await mkdir(dir, { recursive: true, mode: 0o700 });
  const lock = await open(join(dir, '.nested.lock'), 'wx', 0o600);
  const save = (name, value) => writeFile(join(dir, name), JSON.stringify(value, null, 2), { mode: 0o600 });
  try {
    const kairos = kairosClient(process.env.APP_TOKEN);
    const qs = new URLSearchParams({ ...(opt.coll ? { coll: opt.coll } : {}) });
    const before = await kairos('GET', '/api/storage/nested-pending?' + qs);
    await save(phase === 'apply' ? 'pending-before.json' : 'pending.json', before);
    console.log(`未取得の入れ子: ${before.count} (持ち主 ${before.owners} 行) ${JSON.stringify(before.counts)}`);
    if (phase !== 'apply') return;
    // 一覧に出るのは、親が取り込み済みの入れ子だけ (未取得の入れ子の下の段はまだ D1 に行が無い)。下の段は fillOne が続けて取る
    const ids = new Set(before.items.map(x => x.id));
    const todo = before.items.slice(0, opt.limit ? Number(opt.limit) : undefined);
    const result = { started: new Date().toISOString(), done: [], skipped: [], failed: [] };
    for (const item of todo) {
      try {
        const r = await fillOne(kairos, item.id, { log: m => console.log(m) });
        result.done.push({ ...item, ...r });
        console.log(`取った: ${item.collection} ${item.owner} ${item.type} ${item.id} (${r.blocks} ブロック、入れ子 ${r.nested})`);
      } catch (e) {
        // 別の回が先に埋めた (409 already captured) のは失敗にしない
        if (e.status === 409 && /already captured/.test(e.body || '')) { result.skipped.push(item.id); continue; }
        result.failed.push({ ...item, error: e.message, detail: e.body });
        console.log('失敗:', item.id, e.message);
      }
      await save('apply.json', result);
    }
    const after = await kairos('GET', '/api/storage/nested-pending?' + qs);
    await save('pending-after.json', after);
    result.finished = new Date().toISOString(); result.left = { count: after.count, counts: after.counts, known: after.items.filter(x => ids.has(x.id)).length };
    await save('apply.json', result);
    console.log(`apply: ${result.done.length} 件取り込み、${result.skipped.length} 件は取り込み済み、${result.failed.length} 件失敗。残り ${after.count} ${JSON.stringify(after.counts)} → ${join(dir, 'apply.json')}`);
    if (result.failed.length || after.count) process.exitCode = 2;
  } finally { await lock.close(); await rm(join(dir, '.nested.lock')); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(e => { console.error(e.message); process.exitCode = 1; });
}
