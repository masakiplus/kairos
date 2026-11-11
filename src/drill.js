// ドリル SRS の D1 正本 (2026-11-12, docs/drill.md)。漢字 (kanji.js) 以外の紙ドリルの state ファイルを
// 「名前 → 最上位キーごとの行」で預かる共通の表。Mac の紙ドリルは drill_srs_sync.py 経由で読み書きする。
// 表は初回に CREATE TABLE IF NOT EXISTS。Kairos 本体の表とは独立で、書き込みで storage_control.rev を進めない。

// 名前 → テキストファイル名の許可リスト (SRS の JSON 本体は set/state で、テキストは files で預かる)
export const DRILLS = {
  saya_kokugo: [],        // kanji_drill/kokugo_state.json  読解:<型> / 語句:<語句>
  sansu_srs: [],          // sansu_drill/sansu_srs_state.json
  rika_review: [],        // rika_drill/rika_review_state.json
  shakai_review: [],      // shakai_drill/shakai_review_state.json
  yuzuki_hiragana: ['review.txt'], // hiragana_drill_yuzuki/review_state.json + review.txt
  hikizan_srs: [],        // hikizan_akito/hikizan_srs_state.json
  hikizan_tokei: [],      // hikizan_akito/hikizan_tokei_state.json
  tasshizan_srs: [],      // tasshizan_yuzuki/tasshizan_srs_state.json
  tasshizan_tokei: [],    // tasshizan_yuzuki/tasshizan_tokei_state.json
  yuzuki_kokugo: [],      // kokugo_yuzuki/kokugo_yuzuki_state.json
  saya_tokinaoshi: [],    // kokugo_drill/tokinaoshi_state.json (休止中)
};
const MAX_KEY = 200;
const MAX_VALUE = 200000;
const MAX_FILE = 200000;

const readyFor = new WeakMap();
function init(env) {
  let ready = readyFor.get(env.DB);
  if (ready) return ready;
  ready = env.DB.batch([
    env.DB.prepare('CREATE TABLE IF NOT EXISTS drill_state(name TEXT NOT NULL, key TEXT NOT NULL, data TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(name,key))'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS drill_files(name TEXT NOT NULL, file TEXT NOT NULL, content TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(name,file))'),
  ]).catch((e) => { readyFor.delete(env.DB); throw e; });
  readyFor.set(env.DB, ready);
  return ready;
}
const nowIso = () => new Date().toISOString();

async function readState(env, name) {
  const r = await env.DB.prepare('SELECT key, data FROM drill_state WHERE name=?').bind(name).all();
  const out = {};
  for (const x of r.results || []) { try { out[x.key] = JSON.parse(x.data); } catch (e) { /* 壊れた行は飛ばす */ } }
  return out;
}
async function readFiles(env, name) {
  const r = await env.DB.prepare('SELECT file, content FROM drill_files WHERE name=?').bind(name).all();
  const out = {};
  for (const x of r.results || []) out[x.file] = x.content;
  return out;
}

export async function drillState(env, name) {
  await init(env);
  const [state, files] = await Promise.all([readState(env, name), readFiles(env, name)]);
  return { name, state, files, at: nowIso() };
}

/** set: {key: 値|null} を upsert (null は削除。値は null 以外の任意の JSON)。files: {ファイル名: 全文}。
 *  replace=true なら state を全部入れ替える (移行・復元用)。 */
export async function drillPutState(env, name, body) {
  await init(env);
  const allowed = DRILLS[name] || [];
  const at = nowIso(), stmts = [];
  if (body.replace) stmts.push(env.DB.prepare('DELETE FROM drill_state WHERE name=?').bind(name));
  let n = 0, skipped = 0;
  for (const [k, v] of Object.entries(body.set || {})) {
    const key = String(k);
    if (!key || key.length > MAX_KEY) { skipped++; continue; }
    if (v === null) { stmts.push(env.DB.prepare('DELETE FROM drill_state WHERE name=? AND key=?').bind(name, key)); n++; continue; }
    const json = JSON.stringify(v);
    if (json === undefined || json.length > MAX_VALUE) { skipped++; continue; }
    stmts.push(env.DB.prepare('INSERT INTO drill_state(name,key,data,updated_at) VALUES(?,?,?,?) ON CONFLICT(name,key) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at').bind(name, key, json, at));
    n++;
  }
  const wroteFiles = [];
  for (const [file, content] of Object.entries(body.files || {})) {
    if (!allowed.includes(file) || typeof content !== 'string' || content.length > MAX_FILE) { skipped++; continue; }
    stmts.push(env.DB.prepare('INSERT INTO drill_files(name,file,content,updated_at) VALUES(?,?,?,?) ON CONFLICT(name,file) DO UPDATE SET content=excluded.content, updated_at=excluded.updated_at').bind(name, file, content, at));
    wroteFiles.push(file);
  }
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
  return { ok: true, name, set: n, skipped, files: wroteFiles };
}

/** 全ドリル分の state・ファイル (Mac の日次バックアップ用) */
export async function drillExport(env) {
  await init(env);
  const out = { at: nowIso(), names: {} };
  for (const name of Object.keys(DRILLS)) {
    const [state, files] = await Promise.all([readState(env, name), readFiles(env, name)]);
    out.names[name] = { state, files };
  }
  return out;
}

/** /api/drill/*。admin (Kairos の Cookie/APP_TOKEN) だけ。返り値 null = ここの担当ではない。 */
export async function drillRoute(req, env, url, { admin, json }) {
  const path = url.pathname;
  if (!path.startsWith('/api/drill/')) return null;
  if (!env.DB) return json({ error: 'no-db' }, 503);
  if (!admin) return json({ error: 'unauthorized' }, 401);
  const sub = path.slice('/api/drill/'.length);
  const name = url.searchParams.get('name') || '';
  const needName = () => Object.hasOwn(DRILLS, name);
  const body = async () => (req.method === 'GET' ? {} : await req.json().catch(() => ({})));
  if (sub === 'state' && req.method === 'GET') return needName() ? json(await drillState(env, name)) : json({ error: 'name' }, 400);
  if (sub === 'state' && req.method === 'PUT') return needName() ? json(await drillPutState(env, name, await body())) : json({ error: 'name' }, 400);
  if (sub === 'export' && req.method === 'GET') return json(await drillExport(env));
  if (sub === 'names' && req.method === 'GET') return json({ names: DRILLS });
  return json({ error: 'not found' }, 404);
}
