// 追加コレクション (daily・dreamtime・reference など) の本文のうち、まだ Notion から取っていない入れ子のブロック
// (表の行・入れ子の箇条書き) だけを取り込む口 (2026-11-01)。
//
// 2026-10-19 の追加コレクションの取り込みは上の段だけで、入れ子 (has_children のブロック) の中身を取っていなかった。
// capture-body は親の本文を消して取り直すので、切り替え後に Kairos で書いた日報を上書きしてしまう。ここは
//   - 親の本文 (持ち主のページの上の段) には触らない
//   - 取るのは「入れ子のブロック」で、まだ取り込み済みの印 (entity_bodies.complete=1) が無いものだけ
//   - 持ち主 (上へたどって最初に当たるページ) が追加コレクションの行のときだけ。中核6つ・知識文書の子ページ (pages) は通さない
// の3つを門にする。入れ子の取り込み前のブロックは Kairos から書けない (/blocks/:id/children が 502 で断る) ので、
// ここで書く中身が Kairos での編集を上書きすることはない。
//
//   GET  /api/storage/nested-pending[?coll=daily][&limit=N]   未取得の入れ子の一覧 (持ち主・コレクション付き)
//   POST /api/storage/capture-nested?id=<入れ子のブロック id>[&cursor=]
//        Notion の /blocks/:id/children を1ページ (100件) 取る。返す children をまた capture-nested すれば下まで埋まる
//   POST /api/storage/capture-asset?id=<添付のブロック id>   持ち主が追加コレクションで、まだ保存していない添付だけ (d1.js の門)
import { nget } from './lab.js';
import { cleanId, collectionVars } from './d1.js';

const OWN_PAGES = new Set(['pages', 'nested']);
const isExtraCollection = c => !!c && !(c in collectionVars) && !OWN_PAGES.has(c);

/** 入れ子のブロック (entities に無い) から上へたどり、持ち主のページの id とコレクションを返す。 */
export async function ownerOf(env, id) {
  const r = await env.DB.prepare(`WITH RECURSIVE up(id,d) AS (SELECT ?1,0 UNION ALL SELECT c.parent_id,up.d+1 FROM entity_children c JOIN up ON c.id=up.id WHERE up.d<32)
    SELECT e.id,e.collection FROM up JOIN entities e ON e.id=up.id ORDER BY up.d LIMIT 1`).bind(cleanId(id)).first();
  return r || null;
}

/** 追加コレクションが持ち主の、未取得の入れ子のブロック。持ち主は1本の再帰 SQL で引く (D1 の1回あたりのクエリ数の上限に掛けない)。 */
export async function pendingNested(env, { coll = null, limit = 5000 } = {}) {
  const rows = (await env.DB.prepare(`WITH RECURSIVE pend(id,type) AS (
        SELECT c.id,json_extract(c.payload,'$.type') FROM entity_children c LEFT JOIN entity_bodies b ON b.id=c.id
        WHERE json_extract(c.payload,'$.has_children')=1 AND json_extract(c.payload,'$.type') NOT IN ('child_page','child_database')
          AND COALESCE(b.complete,0)=0 AND c.id NOT IN (SELECT id FROM entities)),
      up(start,id,d) AS (SELECT id,id,0 FROM pend
        UNION ALL SELECT up.start,c.parent_id,up.d+1 FROM entity_children c JOIN up ON c.id=up.id WHERE up.d<32 AND up.id NOT IN (SELECT id FROM entities))
      SELECT p.id,p.type,e.id owner,e.collection FROM pend p JOIN up ON up.start=p.id JOIN entities e ON e.id=up.id ORDER BY e.collection,e.id,p.id`).all()).results || [];
  const out = [], seen = new Set();
  for (const r of rows) {
    if (seen.has(r.id) || !isExtraCollection(r.collection) || (coll && r.collection !== coll)) continue;
    seen.add(r.id); out.push({ id: r.id, type: r.type, owner: r.owner, collection: r.collection });
    if (out.length >= limit) break;
  }
  return out;
}

/** capture-nested を通すか。理由つきで返す (断るときの 409 の文面に使う)。 */
export async function nestedCaptureGate(env, id, cursor) {
  if (!/^[a-f0-9]{32}$/.test(id || '')) return { ok: false, status: 400, error: 'Invalid id' };
  if (await env.DB.prepare('SELECT 1 FROM entities WHERE id=?').bind(id).first()) return { ok: false, status: 409, error: 'Pages are not nested blocks (use the page capture paths)' };
  const row = await env.DB.prepare('SELECT payload FROM entity_children WHERE id=? LIMIT 1').bind(id).first();
  if (!row) return { ok: false, status: 404, error: 'Unknown block' };
  const block = JSON.parse(row.payload);
  if (!block.has_children || ['child_page', 'child_database'].includes(block.type)) return { ok: false, status: 409, error: 'Block has no nested children' };
  const owner = await ownerOf(env, id);
  if (!owner || !isExtraCollection(owner.collection)) return { ok: false, status: 409, error: 'Owner is not an extra collection' };
  const body = await env.DB.prepare('SELECT complete FROM entity_bodies WHERE id=?').bind(id).first();
  if (body?.complete) return { ok: false, status: 409, error: 'Nested block is already captured' };
  if (cursor && !body) return { ok: false, status: 409, error: 'Start without cursor first' };
  return { ok: true, owner };
}

export async function nestedRoute(req, env, url, json) {
  const path = url.pathname;
  if (env.DATA_BACKEND !== 'd1') return json({ error: 'Nested capture needs the D1 backend' }, 409);
  if (path === '/api/storage/nested-pending') {
    if (req.method !== 'GET') return json({ error: 'GET required' }, 405);
    const coll = url.searchParams.get('coll') || null, limit = Math.max(1, Math.min(20000, Number(url.searchParams.get('limit')) || 5000));
    const items = await pendingNested(env, { coll, limit });
    const counts = {};
    for (const x of items) counts[x.collection] = (counts[x.collection] || 0) + 1;
    return json({ count: items.length, counts, owners: new Set(items.map(x => x.owner)).size, items });
  }
  if (path === '/api/storage/capture-nested') {
    if (req.method !== 'POST') return json({ error: 'POST required' }, 405);
    if (env.D1_READ_ONLY) return json({ error: 'D1 preview is read only' }, 409);
    const id = cleanId(url.searchParams.get('id')), cursor = url.searchParams.get('cursor');
    const gate = await nestedCaptureGate(env, id, cursor);
    if (!gate.ok) return json({ error: gate.error }, gate.status);
    // 最初の1ページの前に、途中で止まった前回の分 (未完了の印のまま入った子) だけ消す。取り込み済みの印が無いブロックの
    // 子は Kairos からは書けないので、ここにあるのは前回の capture-nested が入れたものだけである。
    if (!cursor) await env.DB.batch([env.DB.prepare('DELETE FROM entity_children WHERE parent_id=?').bind(id), env.DB.prepare('INSERT OR REPLACE INTO entity_bodies VALUES(?,0)').bind(id)]);
    const ctx = { calls: 0 };
    const prior = await env.DB.prepare('SELECT COUNT(*) n FROM entity_children WHERE parent_id=?').bind(id).first();
    const data = await nget(env, ctx, `/blocks/${id}/children?page_size=100${cursor ? '&start_cursor=' + encodeURIComponent(cursor) : ''}`);
    const results = data.results || [];
    const stmts = results.map((b, i) => env.DB.prepare('INSERT OR REPLACE INTO entity_children VALUES(?,?,?,?)').bind(id, cleanId(b.id), prior.n + i, JSON.stringify(b)));
    if (!data.has_more) stmts.push(env.DB.prepare('UPDATE entity_bodies SET complete=1 WHERE id=?').bind(id));
    for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
    return json({
      id, owner: gate.owner.id, collection: gate.owner.collection, n: results.length, next: data.has_more ? data.next_cursor : null,
      children: results.filter(b => b.has_children && !['child_page', 'child_database'].includes(b.type)).map(b => cleanId(b.id)),
      pages: results.filter(b => b.type === 'child_page').map(b => cleanId(b.id)),
      assets: results.filter(b => ['pdf', 'file', 'image', 'audio', 'video'].includes(b.type)).map(b => cleanId(b.id)),
    });
  }
  return json({ error: 'not found' }, 404);
}

/** capture-asset を、持ち主が追加コレクションでまだ保存していない添付に限って通すか (入れ子の中の画像・PDF のため)。 */
export async function extraAssetAllowed(env, id) {
  if (!/^[a-f0-9]{32}$/.test(id || '')) return false;
  const done = await env.DB.prepare('SELECT complete FROM entity_assets WHERE id=?').bind(id).first();
  if (done?.complete) return false;
  const owner = await ownerOf(env, id);
  return !!owner && isExtraCollection(owner.collection);
}
