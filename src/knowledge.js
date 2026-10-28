// 知識文書 (PRJ・archive・ref) を Kairos (D1) の正本として引く窓口 (2026-10-29)。
//
// 知識文書は 10/18 の移行で既に D1 に入っている。新しい表は作らず、今の置き場をそのまま「文書」として読む:
//   PRJ/<名前>/README.md, archive/<名前>/README.md → projects の行の本文 (移行元 = "PRJ/<名前>" など)
//   PRJ/<名前>/<子>.md                             → その行の子ページ (child_page の題名 = "<子>.md")
//   ref/<…>.md                                     → reference の行の本文 (移行元 = "ref/<…>.md")
// パスの解決規則は saito-tools の notion_knowledge.locate() と同じ (深く当たった行が勝つ)。
//
// 取り込み後に Notion 側で動いた本文を取り直す「早送り」も、ここで守る:
//   Kairos で一度でも書いた文書 (entity_body_edits に行がある、または Kairos で足したブロックがある) は上書きしない。
//   ページの時刻だけが取り込み時からずれている文書 (属性だけの編集か、入れ子ブロックの削除か区別できない) は
//   人が確かめて accept を付けたときだけ取り直す。詳細は docs/knowledge.md。
import { cleanId } from './d1.js';

export const KNOWLEDGE_ROOTS = ['PRJ', 'archive', 'ref'];
const plainText = a => (a || []).map(x => x.plain_text ?? x.text?.content ?? '').join('');
const isKnowledgePath = p => KNOWLEDGE_ROOTS.some(r => p.startsWith(r + '/'));

/** 知識文書の一覧。1件 = 1文書 (ボルトの1ファイル)。 */
export async function knowledgeIndex(env) {
  const [rows, subs] = await env.DB.batch([
    env.DB.prepare(`SELECT e.id, e.collection, json_extract(e.payload,'$.properties."移行元".rich_text') src,
        json_extract(e.payload,'$.last_edited_time') page_edited, COALESCE(json_extract(e.payload,'$.archived'),0) archived,
        COALESCE(json_extract(e.payload,'$.in_trash'),0) trashed, b.complete, v.updated captured, k.edited kairos_edited,
        (SELECT COUNT(*) FROM entity_children c WHERE c.parent_id=e.id AND json_extract(c.payload,'$.type')!='child_page') top
      FROM entities e LEFT JOIN entity_bodies b ON b.id=e.id LEFT JOIN entity_body_versions v ON v.id=e.id LEFT JOIN entity_body_edits k ON k.id=e.id
      WHERE e.collection IN ('projects','reference')`),
    env.DB.prepare(`SELECT c.parent_id root, c.id, json_extract(c.payload,'$.child_page.title') title,
        json_extract(e.payload,'$.last_edited_time') page_edited, b.complete, v.updated captured, k.edited kairos_edited,
        (SELECT COUNT(*) FROM entity_children x WHERE x.parent_id=c.id AND json_extract(x.payload,'$.type')!='child_page') top
      FROM entity_children c JOIN entities p ON p.id=c.parent_id AND p.collection='projects'
      LEFT JOIN entities e ON e.id=c.id LEFT JOIN entity_bodies b ON b.id=c.id LEFT JOIN entity_body_versions v ON v.id=c.id LEFT JOIN entity_body_edits k ON k.id=c.id
      WHERE json_extract(c.payload,'$.type')='child_page'`),
  ]);
  const docs = [], rootPath = new Map();
  for (const r of rows.results || []) {
    const src = plainText(JSON.parse(r.src || '[]')).trim();
    if (!isKnowledgePath(src) || r.trashed) continue;
    const reference = r.collection === 'reference';
    if (!reference) rootPath.set(r.id, src);
    docs.push(docRow(r, reference ? src : src + '/README.md', reference ? 'reference' : 'readme', { row: src }));
  }
  for (const r of subs.results || []) {
    const row = rootPath.get(r.root);
    if (!row || !r.title) continue;
    docs.push(docRow(r, row + '/' + r.title, 'sub', { row, parent: r.root, missing: r.page_edited == null }));
  }
  docs.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)); // 符号位置順 (ロケールに依らず同じ並び)
  return docs;
}
function docRow(r, path, kind, extra) {
  return { path, id: r.id, kind, ...extra, archived: !!r.archived, complete: !!r.complete, captured: r.captured || null,
    pageEdited: r.page_edited || null, kairosEdited: r.kairos_edited || null, topBlocks: r.top ?? 0 };
}

/** ボルトの相対パス → 文書。notion_knowledge.locate() と同じ規則。見つからなければ null、子ページが未作成なら id:null。 */
export function resolvePath(docs, rel) {
  rel = String(rel || '').replace(/\\/g, '/').replace(/^\.?\//, '');
  if (rel.startsWith('ref/')) return docs.find(d => d.kind === 'reference' && d.path === rel) || null;
  let best = null;
  for (const d of docs) if (d.kind === 'readme' && (rel === d.row || rel.startsWith(d.row + '/')) && (!best || d.row.length > best.row.length)) best = d;
  if (!best) return null;
  const tail = rel.slice(best.row.length).replace(/^\//, '');
  if (!tail || tail.toLowerCase() === 'readme.md') return best;
  return docs.find(d => d.kind === 'sub' && d.parent === best.id && d.path === best.row + '/' + tail)
    || { path: best.row + '/' + tail, id: null, kind: 'sub', row: best.row, parent: best.id };
}

/** 本文の木 (子ページの中は数えない) を見て、取り込み後に Kairos で書かれたかを判定する。 */
export async function inspectBody(env, id) {
  id = cleanId(id);
  const [page, edits, blocks] = await env.DB.batch([
    env.DB.prepare(`SELECT json_extract(e.payload,'$.last_edited_time') page_edited, v.updated captured, b.complete FROM entities e
      LEFT JOIN entity_body_versions v ON v.id=e.id LEFT JOIN entity_bodies b ON b.id=e.id WHERE e.id=?`).bind(id),
    env.DB.prepare('SELECT edited FROM entity_body_edits WHERE id=?').bind(id),
    env.DB.prepare(`WITH RECURSIVE d(id) AS (SELECT c.id FROM entity_children c WHERE c.parent_id=?1
        UNION SELECT c.id FROM entity_children c JOIN d ON c.parent_id=d.id WHERE d.id NOT IN (SELECT id FROM entities))
      SELECT COUNT(*) n, SUM(json_extract(c.payload,'$.created_time') IS NULL) bare, MAX(json_extract(c.payload,'$.last_edited_time')) latest
      FROM entity_children c WHERE c.id IN (SELECT id FROM d)`).bind(id),
  ]);
  const p = page.results?.[0];
  if (!p) return null;
  const b = blocks.results?.[0] || {}, captured = p.captured || null, latest = b.latest || null;
  const kairosEdited = edits.results?.[0]?.edited || null;
  // 取り込み後に Kairos で書いた証拠: 印がある / 時刻の無いブロック (この変更より前に Kairos で足したもの) / 取り込みより新しいブロック
  const touched = !!kairosEdited || (b.bare || 0) > 0 || (!!captured && !!latest && latest > captured);
  // 証拠は無いがページの時刻が動いている: 属性だけの編集なら取り直してよいが、入れ子ブロックの削除なら消える。人が確かめる
  // (早送りのあとは取り込み時刻 = Notion の本文時刻になり、ページの時刻はそれ以前のままなので「後」だけを見る)
  const ambiguous = !touched && !!captured && !!p.page_edited && p.page_edited > captured;
  return { id, captured, pageEdited: p.page_edited || null, kairosEdited, complete: !!p.complete, blocks: b.n || 0, bareBlocks: b.bare || 0, latestBlock: latest, touched, ambiguous };
}

// ---- 早送り (Notion → Kairos、知識文書だけ・Kairos で未編集のものだけ) --------------------------------
const MARK = 'kref:';
/** id から上へたどり、最初に当たったページ (entities の行) を返す。id 自身がページならそれ。id がまだ無い新しい子ページなら親側のページ。 */
async function nearestEntity(env, id) {
  const r = await env.DB.prepare(`WITH RECURSIVE up(id,d) AS (SELECT ?1,0 UNION ALL SELECT c.parent_id,up.d+1 FROM entity_children c JOIN up ON c.id=up.id WHERE up.d<32)
    SELECT up.id FROM up WHERE up.id IN (SELECT id FROM entities) ORDER BY up.d LIMIT 1`).bind(cleanId(id)).first();
  return r?.id || null;
}
async function markOf(env, id) {
  const r = await env.DB.prepare('SELECT value FROM storage_control WHERE key=?').bind(MARK + cleanId(id)).first();
  return r ? JSON.parse(r.value) : null;
}
/**
 * 切り替え後の取り込み API (capture-body / capture-page / capture-asset) を、早送り中の知識文書の中に限って通すか。
 * capture-page は「まだ Kairos に無いページ」(新しい子ページ・新しい ref 行) だけ。既にあるページの属性は上書きしない。
 */
export async function knowledgeCaptureAllowed(env, path, id) {
  if (!/^[a-f0-9]{32}$/.test(id || '')) return false;
  if (path === '/api/storage/capture-page') {
    if (await env.DB.prepare('SELECT 1 FROM entities WHERE id=?').bind(id).first()) return false;
    if (await markOf(env, id)) return true; // knowledge-begin で予約した新しい ref 行
    const owner = await nearestEntity(env, id);
    return !!owner && !!(await markOf(env, owner));
  }
  if (path === '/api/storage/capture-body') {
    if (await markOf(env, id)) return true;
    if (await env.DB.prepare('SELECT 1 FROM entities WHERE id=?').bind(id).first()) return false; // 他の文書 (子ページ) の本文は別に扱う
    const owner = await nearestEntity(env, id);
    return !!owner && !!(await markOf(env, owner));
  }
  if (path === '/api/storage/capture-asset') {
    const owner = await nearestEntity(env, id);
    return !!owner && !!(await markOf(env, owner));
  }
  return false;
}
/** capture-page で新しい子ページ・ref 行を入れたあと、その本文の取り込みも通すために同じ回の印を付ける。 */
export async function knowledgeAfterCapturePage(env, id, collection, referenceDs) {
  const own = await markOf(env, id), parent = own ? null : await nearestEntity(env, (await env.DB.prepare('SELECT parent_id FROM entity_children WHERE id=?').bind(id).first())?.parent_id || '');
  const session = own?.session || (parent && (await markOf(env, parent)))?.session;
  if (!session) return;
  if (own && collection !== 'reference') {
    // 予約は ref 行として受けた。別の DB のページだったら入れたものを戻す
    await env.DB.batch([env.DB.prepare('DELETE FROM entities WHERE id=?').bind(id), env.DB.prepare('DELETE FROM entity_links WHERE from_id=?').bind(id), env.DB.prepare('DELETE FROM storage_control WHERE key=?').bind(MARK + id)]);
    throw new Error('Reserved page is not a Reference row');
  }
  await env.DB.prepare('INSERT OR REPLACE INTO storage_control(key,value) VALUES(?,?)').bind(MARK + id, JSON.stringify({ session, at: new Date().toISOString(), created: true })).run();
}

export async function knowledgeRoute(req, env, url, json) {
  const path = url.pathname;
  if (path === '/api/knowledge/index' && req.method === 'GET') {
    const docs = await knowledgeIndex(env);
    return json({ count: docs.length, docs });
  }
  if (path === '/api/knowledge/resolve' && req.method === 'GET') {
    const hit = resolvePath(await knowledgeIndex(env), url.searchParams.get('path'));
    return hit ? json(hit) : json({ error: 'not a knowledge document' }, 404);
  }
  if (path === '/api/knowledge/inspect' && req.method === 'GET') {
    const r = await inspectBody(env, url.searchParams.get('id'));
    return r ? json(r) : json({ error: 'not found' }, 404);
  }
  return json({ error: 'not found' }, 404);
}

/**
 * POST /api/storage/knowledge-begin?id=&session=[&accept=1][&new=1]
 * 1文書の本文を Notion から取り直す前の門。通れば本文を空 (未取得) にして印を付ける。子ページの本文は消さない。
 * POST /api/storage/knowledge-end?id=&session=&notion_edited=
 * 取り直しが終わったら、取り込み時刻を Notion の更新時刻にし、Kairos 編集の印と、この回の印を外す。
 */
export async function knowledgeRefreshRoute(req, env, url, json) {
  if (req.method !== 'POST') return json({ error: 'POST required' }, 405);
  if (env.D1_READ_ONLY) return json({ error: 'D1 preview is read only' }, 409);
  const id = cleanId(url.searchParams.get('id')), session = url.searchParams.get('session') || '';
  if (!/^[a-f0-9]{32}$/.test(id) || !/^[A-Za-z0-9_-]{8,64}$/.test(session)) return json({ error: 'id and session required' }, 400);
  if (url.pathname === '/api/storage/knowledge-begin') {
    const exists = await env.DB.prepare('SELECT collection FROM entities WHERE id=?').bind(id).first();
    if (!exists) {
      // まだ Kairos に無い ref 行。capture-page が Reference の行であることを確かめてから入れる
      if (url.searchParams.get('new') !== '1') return json({ error: 'not found' }, 404);
      await env.DB.prepare('INSERT OR REPLACE INTO storage_control(key,value) VALUES(?,?)').bind(MARK + id, JSON.stringify({ session, at: new Date().toISOString(), created: true })).run();
      return json({ id, new: true });
    }
    const docs = await knowledgeIndex(env);
    if (!docs.some(d => d.id === id)) return json({ error: 'not a knowledge document' }, 409);
    const state = await inspectBody(env, id);
    const accepted = url.searchParams.get('accept') === '1';
    if ((state.touched || state.ambiguous) && !accepted) return json({ error: state.touched ? 'Edited in Kairos after capture' : 'Page changed after capture; review and accept', inspect: state }, 409);
    // 子ページ (別の文書) には降りない。入れ子のブロックと、その「取得済み」の印だけ消す
    const nested = `WITH RECURSIVE d(id) AS (SELECT c.id FROM entity_children c WHERE c.parent_id=?1 UNION SELECT c.id FROM entity_children c JOIN d ON c.parent_id=d.id WHERE d.id NOT IN (SELECT id FROM entities)) `;
    await env.DB.batch([
      env.DB.prepare('INSERT OR REPLACE INTO storage_control(key,value) VALUES(?,?)').bind(MARK + id, JSON.stringify({ session, at: new Date().toISOString(), accepted })),
      env.DB.prepare(nested + 'DELETE FROM entity_bodies WHERE id IN (SELECT id FROM d WHERE id NOT IN (SELECT id FROM entities))').bind(id),
      env.DB.prepare(nested + 'DELETE FROM entity_children WHERE parent_id IN (SELECT id FROM d WHERE id NOT IN (SELECT id FROM entities))').bind(id),
      env.DB.prepare('DELETE FROM entity_children WHERE parent_id=?').bind(id),
      env.DB.prepare('INSERT OR REPLACE INTO entity_bodies VALUES(?,0)').bind(id),
    ]);
    return json({ id, inspect: state });
  }
  if (url.pathname === '/api/storage/knowledge-end') {
    const mark = await markOf(env, id);
    if (!mark || mark.session !== session) return json({ error: 'not refreshing in this session' }, 409);
    const edited = url.searchParams.get('notion_edited') || '';
    if (!/^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(edited)) return json({ error: 'notion_edited (ISO, UTC) required' }, 400);
    const pending = await env.DB.prepare(`WITH RECURSIVE d(id) AS (SELECT ?1 UNION SELECT c.id FROM entity_children c JOIN d ON c.parent_id=d.id
        WHERE json_extract(c.payload,'$.has_children')=1 AND json_extract(c.payload,'$.type') NOT IN ('child_page','child_database'))
      SELECT COUNT(*) n FROM d LEFT JOIN entity_bodies b ON b.id=d.id WHERE COALESCE(b.complete,0)=0`).bind(id).first();
    if (pending?.n) return json({ error: 'Body is not complete', pending: pending.n }, 409);
    const marks = (await env.DB.prepare(`SELECT key FROM storage_control WHERE key LIKE 'kref:%' AND json_extract(value,'$.session')=?`).bind(session).all()).results || [];
    // 同じ回で新しく入れた子ページは、それ自身の本文が揃っていれば取り込み済みにする
    const done = [env.DB.prepare('INSERT OR REPLACE INTO entity_body_versions VALUES(?,?)').bind(id, edited), env.DB.prepare('DELETE FROM entity_body_edits WHERE id=?').bind(id), env.DB.prepare('DELETE FROM storage_control WHERE key=?').bind(MARK + id)];
    const left = marks.map(m => m.key.slice(MARK.length)).filter(k => k !== id);
    return env.DB.batch(done).then(() => json({ id, captured: edited, openMarks: left }));
  }
  return json({ error: 'not found' }, 404);
}
