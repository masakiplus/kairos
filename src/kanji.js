// ---- 漢字書き取り (iPad PWA) と紙ドリルの SRS 正本 (2026-11-07, docs/kanji.md) ----
// 紗綾 (saya)・明澄 (akito) の漢字ドリルの SRS を D1 に持つ。紙ドリル (saito-tools/kanji_drill*) は
// 起動時に state を GET してローカルへ書き出し、終わりに変わったキーだけ PUT / PATCH で戻す。
// iPad の PWA (/kanji/) は今日の出題を読み、結果を POST する。結果の stage 遷移はここで紙と同じ規則で行う。
//
// 表 (初回に CREATE TABLE IF NOT EXISTS。Kairos 本体の表とは独立。rev は進めない):
//   kanji_srs(child, key, data)       review_state.json の1キー = 1行。data は Python 側が書いた dict をそのまま JSON で
//   kanji_files(child, name, content) review.txt / review_retired.txt の中身をそのまま
//   kanji_results(id, child, key, …)  採点の履歴 (iPad・紙・スマホ)。id で重複を弾く
//   kanji_today(child, date, items)   その日の書き取りの出題。紙ドリルの生成が書く
//   kanji_glyph(ch, data)             KanjiVG の画 (path と番号位置) のキャッシュ

export const KANJI_CHILDREN = ["saya", "akito"];
export const KANJI_FILES = ["review.txt", "review_retired.txt"];

// 紙ドリルの srs_mark と同じ規則。saya = kanji_drill/daily_kanji_drill.py、akito = kanji_drill_akito/daily_kanji_drill_akito.py
export const KANJI_RULES = {
  saya: { intervals: [1, 3, 7, 14, 60], missBack: 2, norm: true, shown: true },
  akito: { intervals: [1, 3, 7, 14], missBack: Infinity, norm: false, shown: false },
};

const KANA_RE = /[ぁ-ゖァ-ヺーｰ・･\s　]/g;
export function kanjiNorm(child, key) {
  const k = String(key || "").trim();
  return KANJI_RULES[child]?.norm ? k.replace(KANA_RE, "").trim() : k;
}

export function jstDate(ms = Date.now()) {
  return new Date(ms + 9 * 3600000).toISOString().slice(0, 10);
}
function addDays(day, n) {
  const d = new Date(day + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** 1キーへの採点の反映。st は今の dict (無ければ null)。新しい dict を返す。
 *  grade: ok (= 紙の correct) / ng (= miss) / hint (iPad でヒントを使って書けた: stage 据え置き・翌日もう一度) */
export function applyGrade(child, st, grade, today) {
  const r = KANJI_RULES[child];
  const grad = r.intervals.length;
  const s = { ...(st || (r.shown ? { stage: 0, due: today, shown: 0 } : { stage: 0, due: today })) };
  const stage = Number(s.stage) || 0;
  if (grade === "ok") s.stage = Math.min(stage + 1, grad);
  else if (grade === "ng") {
    s.stage = Math.max(0, stage - r.missBack);
    s.last_miss = today;
  } else s.stage = stage;
  if (r.shown) s.shown = 0;
  if (grade === "hint") s.due = addDays(today, 1);
  else s.due = s.stage >= grad ? null : addDays(today, r.intervals[s.stage]);
  return s;
}

/** review.txt に、まだ無いキーを足す (紙の srs_mark が母集合へ追記するのと同じ)。 */
export function reviewAdd(text, keys) {
  const lines = String(text || "").split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  const have = new Set(lines.map((l) => l.trim()).filter((l) => l && !l.startsWith("#")));
  let changed = false;
  for (const k of keys) if (k && !have.has(k)) { lines.push(k); have.add(k); changed = true; }
  return { text: lines.join("\n") + "\n", changed };
}

/** review.txt の差分適用。remove は strip した中身が一致する行を消す。add は無ければ末尾に足す。行の順は保つ。 */
export function linesPatch(text, add = [], remove = []) {
  const rm = new Set(remove.map((l) => String(l).trim()).filter(Boolean));
  const lines = String(text || "").split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  const kept = lines.filter((l) => !rm.has(l.trim()));
  const have = new Set(kept.map((l) => l.trim()));
  for (const a of add) { const t = String(a).trim(); if (t && !have.has(t)) { kept.push(String(a)); have.add(t); } }
  return kept.length ? kept.join("\n") + "\n" : "";
}

// ---- D1 ----
const readyFor = new WeakMap(); // DB ごとに1回だけ表を作る
function init(env) {
  let ready = readyFor.get(env.DB);
  if (ready) return ready;
  ready = env.DB.batch([
    env.DB.prepare("CREATE TABLE IF NOT EXISTS kanji_srs(child TEXT NOT NULL, key TEXT NOT NULL, data TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(child,key))"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS kanji_files(child TEXT NOT NULL, name TEXT NOT NULL, content TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(child,name))"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS kanji_results(id TEXT PRIMARY KEY, child TEXT NOT NULL, key TEXT NOT NULL, source TEXT NOT NULL, grade TEXT NOT NULL, detail TEXT, answered_at TEXT, received_at TEXT NOT NULL, applied INTEGER NOT NULL DEFAULT 0)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS kanji_today(child TEXT NOT NULL, date TEXT NOT NULL, items TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(child,date))"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS kanji_glyph(ch TEXT PRIMARY KEY, data TEXT NOT NULL)"),
  ]).catch((e) => { readyFor.delete(env.DB); throw e; });
  readyFor.set(env.DB, ready);
  return ready;
}

const nowIso = () => new Date().toISOString();

async function readSrs(env, child) {
  const r = await env.DB.prepare("SELECT key, data FROM kanji_srs WHERE child=?").bind(child).all();
  const out = {};
  for (const x of r.results || []) { try { out[x.key] = JSON.parse(x.data); } catch (e) { /* 壊れた行は飛ばす */ } }
  return out;
}
async function readFiles(env, child) {
  const r = await env.DB.prepare("SELECT name, content FROM kanji_files WHERE child=?").bind(child).all();
  const out = {};
  for (const x of r.results || []) out[x.name] = x.content;
  return out;
}

export async function kanjiState(env, child) {
  await init(env);
  const [srs, files] = await Promise.all([readSrs(env, child), readFiles(env, child)]);
  return { child, srs, files, at: nowIso() };
}

/** srs: {key: dict|null} を upsert (null は削除)。files: {name: 全文}。replace=true なら srs を全部入れ替える (移行・復元用)。 */
export async function kanjiPutState(env, child, body) {
  await init(env);
  const at = nowIso(), stmts = [];
  if (body.replace) stmts.push(env.DB.prepare("DELETE FROM kanji_srs WHERE child=?").bind(child));
  let n = 0;
  for (const [k, v] of Object.entries(body.srs || {})) {
    const key = String(k);
    if (!key || key.length > 40) continue;
    if (v === null) stmts.push(env.DB.prepare("DELETE FROM kanji_srs WHERE child=? AND key=?").bind(child, key));
    else if (v && typeof v === "object") stmts.push(env.DB.prepare("INSERT INTO kanji_srs(child,key,data,updated_at) VALUES(?,?,?,?) ON CONFLICT(child,key) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at").bind(child, key, JSON.stringify(v), at));
    else continue;
    n++;
  }
  for (const [name, content] of Object.entries(body.files || {})) {
    if (!KANJI_FILES.includes(name) || typeof content !== "string" || content.length > 200000) continue;
    stmts.push(env.DB.prepare("INSERT INTO kanji_files(child,name,content,updated_at) VALUES(?,?,?,?) ON CONFLICT(child,name) DO UPDATE SET content=excluded.content, updated_at=excluded.updated_at").bind(child, name, content, at));
  }
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
  return { ok: true, srs: n, files: Object.keys(body.files || {}).filter((n) => KANJI_FILES.includes(n)) };
}

export async function kanjiPatchFile(env, child, body) {
  await init(env);
  const name = String(body.name || "");
  if (!KANJI_FILES.includes(name)) return { error: "name" };
  const cur = (await readFiles(env, child))[name] || "";
  const next = linesPatch(cur, body.add || [], body.remove || []);
  if (next !== cur) await env.DB.prepare("INSERT INTO kanji_files(child,name,content,updated_at) VALUES(?,?,?,?) ON CONFLICT(child,name) DO UPDATE SET content=excluded.content, updated_at=excluded.updated_at").bind(child, name, next, nowIso()).run();
  return { ok: true, changed: next !== cur };
}

/** 採点の取り込み。results: [{id, key, grade, source?, retry?, …}]。id が新しく、retry でない ok/hint/ng だけ stage を動かす。 */
export async function kanjiResults(env, child, results, { source = "ipad", today = jstDate() } = {}) {
  await init(env);
  const list = (Array.isArray(results) ? results : []).slice(0, 200);
  const at = nowIso();
  const srs = await readSrs(env, child);
  const files = await readFiles(env, child);
  const touched = {}, addKeys = [];
  let accepted = 0, applied = 0;
  for (const x of list) {
    const id = String(x && x.id || "").slice(0, 80);
    const grade = x && x.grade;
    const key = kanjiNorm(child, x && x.key);
    if (!id || !key || key.length > 40 || !["ok", "hint", "ng"].includes(grade)) continue;
    const src = String(x.source || source).slice(0, 20);
    const apply = !x.retry;
    const detail = JSON.stringify({ hint: x.hint ?? null, auto: x.auto ?? null, kind: x.kind ?? null, score: x.score ?? null, override: !!x.override, retry: !!x.retry, strokes: Array.isArray(x.strokes) ? x.strokes.slice(0, 40) : null });
    const ins = await env.DB.prepare("INSERT OR IGNORE INTO kanji_results(id,child,key,source,grade,detail,answered_at,received_at,applied) VALUES(?,?,?,?,?,?,?,?,?)")
      .bind(id, child, key, src, grade, detail.slice(0, 60000), String(x.answered_at || "").slice(0, 40) || null, at, apply ? 1 : 0).run();
    if (!(ins.meta?.changes ?? ins.changes ?? 1)) continue; // 再送 = 取り込み済み
    accepted++;
    if (!apply) continue;
    const next = applyGrade(child, touched[key] || srs[key] || null, grade, today);
    touched[key] = next;
    addKeys.push(key);
    applied++;
  }
  if (applied) await kanjiPutState(env, child, { srs: touched });
  if (addKeys.length) {
    const r = reviewAdd(files["review.txt"] || "", addKeys);
    if (r.changed) await kanjiPutState(env, child, { files: { "review.txt": r.text } });
  }
  return { ok: true, accepted, applied, srs: touched };
}

export async function kanjiPutToday(env, child, date, items) {
  await init(env);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { error: "date" };
  const clean = (Array.isArray(items) ? items : []).slice(0, 40).map((it) => ({
    key: String(it.key || it.ans || "").slice(0, 20),
    ans: String(it.ans || it.key || "").slice(0, 8),
    sentence: String(it.sentence || "").slice(0, 120),
    reading: String(it.reading || "").slice(0, 30),
    emoji: it.emoji ? String(it.emoji).slice(0, 8) : undefined,
  })).filter((it) => it.ans && it.sentence.includes("□"));
  await env.DB.prepare("INSERT INTO kanji_today(child,date,items,updated_at) VALUES(?,?,?,?) ON CONFLICT(child,date) DO UPDATE SET items=excluded.items, updated_at=excluded.updated_at")
    .bind(child, date, JSON.stringify(clean), nowIso()).run();
  return { ok: true, items: clean.length };
}

/** 今日 (JST) の出題。今日の分がまだ無ければ (深夜の生成前)、直近の日の分を返す。 */
export async function kanjiToday(env, child, today = jstDate()) {
  await init(env);
  const row = await env.DB.prepare("SELECT date, items FROM kanji_today WHERE child=? AND date<=? ORDER BY date DESC LIMIT 1").bind(child, today).first();
  if (!row) return { child, date: null, items: [] };
  const items = JSON.parse(row.items || "[]");
  const srs = await readSrs(env, child);
  return {
    child, date: row.date,
    items: items.map((it, i) => ({ id: `${child}:${row.date}:${i + 1}`, ...it, stage: srs[kanjiNorm(child, it.key)]?.stage ?? null })),
  };
}

export async function kanjiExport(env, days = 120) {
  await init(env);
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const out = { at: nowIso(), children: {} };
  for (const c of KANJI_CHILDREN) {
    const [srs, files, res] = await Promise.all([
      readSrs(env, c), readFiles(env, c),
      env.DB.prepare("SELECT id,key,source,grade,detail,answered_at,received_at,applied FROM kanji_results WHERE child=? AND received_at>=? ORDER BY received_at").bind(c, since).all(),
    ]);
    out.children[c] = { srs, files, results: res.results || [] };
  }
  return out;
}

// ---- KanjiVG (© Ulrich Apel, CC BY-SA 3.0) ----
export function parseKanjiVG(svg) {
  const paths = [...svg.matchAll(/<path id="kvg:[0-9a-f]+-s(\d+)"[^>]*?\sd="([^"]+)"/g)].map((m) => [+m[1], m[2]]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
  const nums = [...svg.matchAll(/<text transform="matrix\(1 0 0 1 ([\d.]+) ([\d.]+)\)">(\d+)<\/text>/g)].map((m) => [+m[3], +m[1], +m[2]]).sort((a, b) => a[0] - b[0]).map((x) => [x[1], x[2]]);
  return { d: paths, n: nums };
}

export async function kanjiGlyphs(env, chars, fetcher = fetch) {
  await init(env);
  const list = [...new Set([...String(chars || "")].filter((c) => /[぀-ヿ㐀-鿿]/.test(c)))].slice(0, 60);
  const out = {};
  if (!list.length) return out;
  const ph = list.map(() => "?").join(",");
  const r = await env.DB.prepare(`SELECT ch, data FROM kanji_glyph WHERE ch IN (${ph})`).bind(...list).all();
  for (const x of r.results || []) out[x.ch] = JSON.parse(x.data);
  const miss = list.filter((c) => !out[c]);
  await Promise.all(miss.map(async (c) => {
    const hex = c.codePointAt(0).toString(16).padStart(5, "0");
    try {
      const res = await fetcher(`https://raw.githubusercontent.com/KanjiVG/kanjivg/master/kanji/${hex}.svg`);
      if (!res.ok) return;
      const g = parseKanjiVG(await res.text());
      if (!g.d.length) return;
      out[c] = g;
      await env.DB.prepare("INSERT OR REPLACE INTO kanji_glyph(ch,data) VALUES(?,?)").bind(c, JSON.stringify(g)).run();
    } catch (e) { /* 取れない字はお手本なし (PWA は自動判定を飛ばして自己採点にする) */ }
  }));
  return out;
}

// ---- 認証: PWA 用の合鍵。APP_TOKEN から導く (新しい秘密は増やさない) ----
export async function kanjiKey(env) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.APP_TOKEN || ""), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode("kanji-pwa/v1")));
  return [...sig.slice(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** /kanji/* と /api/kanji/*。admin = Kairos の Cookie/APP_TOKEN で入れているか。PWA は X-Kanji-Key。
 *  返り値 null = ここの担当ではない (Kairos 本体の処理へ進む)。 */
export async function kanjiRoute(req, env, url, { admin, json, assets }) {
  const path = url.pathname;
  if (path === "/kanji") return Response.redirect(url.origin + "/kanji/", 302);
  if (path === "/kanji/" || path === "/kanji/index.html")
    return new Response(assets.html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" } });
  if (path === "/kanji/sw.js")
    return new Response(assets.sw, { headers: { "Content-Type": "text/javascript", "Cache-Control": "no-cache", "Service-Worker-Allowed": "/kanji/" } });
  if (path === "/kanji/manifest.webmanifest")
    return new Response(assets.manifest, { headers: { "Content-Type": "application/manifest+json", "Cache-Control": "no-cache" } });
  if (path === "/kanji/icon-180.png" || path === "/kanji/icon-512.png") {
    const b64 = path.includes("180") ? assets.icon180 : assets.icon512;
    return new Response(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)), { headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" } });
  }
  if (!path.startsWith("/api/kanji/")) return null;

  if (!env.DB) return json({ error: "no-db" }, 503);
  const key = req.headers.get("X-Kanji-Key") || "";
  const pwa = !!key && key === (await kanjiKey(env));
  if (!admin && !pwa) return json({ error: "unauthorized" }, 401);
  const child = url.searchParams.get("child") || "";
  const needChild = () => KANJI_CHILDREN.includes(child);
  const body = async () => (req.method === "GET" ? {} : await req.json().catch(() => ({})));
  const sub = path.slice("/api/kanji/".length);

  // PWA と admin の両方
  if (sub === "today" && req.method === "GET") return needChild() ? json(await kanjiToday(env, child)) : json({ error: "child" }, 400);
  if (sub === "results" && req.method === "POST") {
    const b = await body();
    const c = b.child || child;
    if (!KANJI_CHILDREN.includes(c)) return json({ error: "child" }, 400);
    return json(await kanjiResults(env, c, b.results, { source: pwa && !admin ? "ipad" : (b.source || "api") }));
  }
  if (sub === "glyph" && req.method === "GET") return json(await kanjiGlyphs(env, url.searchParams.get("ch") || ""));

  if (!admin) return json({ error: "forbidden" }, 403);
  // admin (紙ドリル・バックアップ・配布リンク)
  if (sub === "state" && req.method === "GET") return needChild() ? json(await kanjiState(env, child)) : json({ error: "child" }, 400);
  if (sub === "state" && req.method === "PUT") return needChild() ? json(await kanjiPutState(env, child, await body())) : json({ error: "child" }, 400);
  if (sub === "files" && req.method === "PATCH") return needChild() ? json(await kanjiPatchFile(env, child, await body())) : json({ error: "child" }, 400);
  if (sub === "today" && req.method === "PUT") return needChild() ? json(await kanjiPutToday(env, child, url.searchParams.get("date") || jstDate(), (await body()).items)) : json({ error: "child" }, 400);
  if (sub === "export" && req.method === "GET") return json(await kanjiExport(env, Number(url.searchParams.get("days")) || 120));
  if (sub === "link" && req.method === "GET") return json({ url: url.origin + "/kanji/#key=" + (await kanjiKey(env)) });
  return json({ error: "not found" }, 404);
}
