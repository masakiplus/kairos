// ---- 🤖 の入口の切り分けと打刻 (2026-10-29、2026-11-17 に 2 択へ) ----
// 入口は 2 つ: cloud (Claude Code のクラウド, claude.ai/code)・cowork (claude.ai/new。Mac にはここからつなぐ)。
// 2026-11-17: 以前は mac を 3 つ目の入口にし、🤖 の飛び先は「実行環境にクラウドがあるか」だけで決めていた。そのため Mac 付きのコード改修が
// Cowork へ、クラウド付きの家計の判断が CC へ流れていた (直近 14 日の打刻 194 タスクで確認)。飛び先は中身 (種類・名前・説明・本文) で決め、
// 実行環境の「クラウド」は強い手がかりの 1 つに下げる。Mac・紙・郵送は入口ではなく Cowork の中の道具なので判定に使わない。
// 規則はここ 1 か所に置き、夜間の棚卸し (GET /api/entry/rules・POST /api/entry/fill)・🤖 の飛び先 (/api/tasks の entry)・打刻が同じものを読む。
export const ENTRY_RULES = {
  version: 3,
  // 1. Cowork の印: コードを書かない種類か、名前に Mac の状態・コネクタが本体の語 (Cowork から Mac・Gmail・freee などにつなぐ)。
  //    語は名前だけで見る (説明・本文はコードの仕事でも「採点」「freee」が出てくるため)
  cowork: { kinds: ["判断", "手続き", "購入", "連絡", "支払い"], words: [".env", "secret", "採点", "印刷", "スキャン", "box.com", "freee", "Gmail", "カレンダーに", "認証切れ"] },
  // 2. コード (リポジトリの仕事): 実行環境にクラウドがあるか、名前・説明・本文にコードの語がある。英字の語は語の境目で当てる。
  //    words はどこに出ても当てる。weak (Kairos・API など、仕組みの名前として普段の文にも出る語) はエリアが 自動化・システム か種類が 作業・調査 のときだけ。
  //    「コード」単体は QR コード・充電コードに当たるので使わない (2026-11-17 本番で発送・DIY のタスクが CC 行きになった)。
  //    「import」は 2026-11-24 の答え合わせで足した (「おとく研究所の自動投稿で部品の import が二重に入る原因を直す」が Cowork に飛んでいた)
  //    実行環境のクラウドは、エリアが 自動化・システム・Inbox・空 のときだけ数える (生活系のタスクに AI がクラウドを付けていた)
  cloud: { env: ["クラウド"], envAreas: ["自動化・システム", "Inbox", null], words: ["saito-tools", "saito-workers", "tasks-pwa", "tools/", "loopmania", "voice-input", "telegram-ask-claude", "PR", "GitHub", "push", "commit", "SKILL.md", ".py", ".js", ".sh", "スクリプト", "ソースコード", "実装", "リポジトリ", "プルリク"], weak: ["kairos", "カイロス", "Worker", "PWA", "MCP", "API", "D1", "launchd", "headless", "ai-drive", "import"], area: ["自動化・システム"], kinds: ["作業", "調査"], fill: "クラウド" },
  // 接続先 (app.html の cloudRepo と同じ。PR #33)
  repos: [{ re: "kairos|カイロス|tasks-pwa", repo: "masakiplus/kairos" }, { re: "saito-workers", repo: "masakiplus/saito-workers" }],
  defaultRepo: "masakiplus/saito-tools",
};

// クラウドセッションのクレジットが切れる時刻。これより前に始まった週はクラウドの消費が週間枠に乗らないので、比較から外す印を付ける
export const CREDIT_UNTIL = "2026-11-05T16:59:00+09:00";
// 朝夕の使用率の定点記録を置いているタスク (表の「日時(JST)」「週間%」列を読む)。vars の USAGE_LOG_TASK_ID で差し替えられる
export const USAGE_LOG_TASK_ID = "4ba0eb7a7b194be1b8565d9906cb894a";

// 英数字で始まり英数字で終わる語 (PR・API・D1・kairos) は前後が英数字でないときだけ当てる (PR が Prophet・price に当たらないように)
const esc = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const wordRe = (w) => new RegExp((/^[A-Za-z0-9]/.test(w) ? "(?<![A-Za-z0-9])" : "") + esc(w) + (/[A-Za-z0-9]$/.test(w) ? "(?![A-Za-z0-9])" : ""), "i");
const hasWord = (text, words) => { const s = String(text || ""); return words.find((w) => wordRe(w).test(s)) || null; };
export function cloudRepo(text) {
  for (const r of ENTRY_RULES.repos) if (new RegExp(r.re, "i").test(text || "")) return r.repo;
  return ENTRY_RULES.defaultRepo;
}
// t: {name, rawDesc, area, kind, env, project}。body は本文の素の文字列 (無ければ名前と説明だけで判定)。entry は cloud か cowork
// 説明の機械の行 (「完了 (2026-11-01, PWA): …」の括弧) と URL は判定に使わない (PWA の語や、Kairos のタスク URL の tasks-pwa で誤って当たる)
const MACHINE = /\(\d{4}-\d{2}-\d{2}[^)]*\)|https?:\/\/\S+/g;
export function classifyEntry(t, body = "") {
  const env = t.env || [], text = [t.name, t.rawDesc, body].join("\n").replace(MACHINE, "");
  const R = ENTRY_RULES;
  if (R.cowork.kinds.includes(t.kind)) return { entry: "cowork", why: "種類: " + t.kind };
  const cw = hasWord(t.name, R.cowork.words);
  if (cw) return { entry: "cowork", why: "語: " + cw };
  const repoText = (t.name || "") + " " + (t.project || "");
  if (env.some((x) => R.cloud.env.includes(x)) && R.cloud.envAreas.includes(t.area ?? null)) return { entry: "cloud", why: "実行環境: クラウド", repo: cloudRepo(repoText) };
  const w = hasWord(text, R.cloud.words) || ((R.cloud.area.includes(t.area) || R.cloud.kinds.includes(t.kind)) && hasWord(text, R.cloud.weak));
  if (w) return { entry: "cloud", why: "語: " + w, repo: cloudRepo(repoText + " " + w) };
  return { entry: "cowork", why: "" };
}
// 🤖 を押したときに実際に飛んだ先。provider が claude 以外は provider 名、前回のセッションを開き直すときはその URL の種類。
// それ以外は規則の判定どおり (app.html の isCloudTask は /api/tasks の entry を見る)
export function launchEntry(t, provider, resumeUrl) {
  if (provider && provider !== "claude") return String(provider).replace(/[^\w-]/g, "").slice(0, 20) || "other";
  if (resumeUrl) return /^https:\/\/claude\.ai\/code\//.test(resumeUrl) ? "cloud" : "cowork";
  return classifyEntry({ ...t, env: t.env || [] }).entry;
}
// ---- 打刻 (D1 の launch_log) ----
const jstDay = (ms) => new Date(ms + 9 * 3600000).toISOString().slice(0, 10);
let ready = null;
function init(env) {
  return (ready ||= env.DB.prepare("CREATE TABLE IF NOT EXISTS launch_log(ts TEXT NOT NULL, day TEXT NOT NULL, task_id TEXT NOT NULL, entry TEXT NOT NULL, repo TEXT, mode TEXT, resume INTEGER NOT NULL DEFAULT 0, device TEXT, rule TEXT)").run()
    // 2026-11-14: 開始の打刻 (受けた AI が AIセッション を書いた時刻) の列。既存の表にも足す。既にあれば失敗するだけなので握る
    .then(() => env.DB.prepare("ALTER TABLE launch_log ADD COLUMN session_at TEXT").run().catch(() => {}))
    .catch((e) => { ready = null; throw e; }));
}
export async function launchAdd(env, row) {
  if (!env.DB) return { ok: true, stored: 0 };
  await init(env);
  const now = row.now ?? Date.now();
  const clip = (v, n) => (v == null ? null : String(v).slice(0, n));
  await env.DB.prepare("INSERT INTO launch_log(ts,day,task_id,entry,repo,mode,resume,device,rule) VALUES(?,?,?,?,?,?,?,?,?)")
    .bind(new Date(now).toISOString(), jstDay(now), String(row.taskId).replace(/-/g, ""), clip(row.entry, 20), clip(row.repo, 80), clip(row.mode, 10), row.resume ? 1 : 0, clip(row.device, 10), clip(row.rule, 20)).run();
  return { ok: true, stored: 1 };
}

// 開始の打刻 (2026-11-14): 🤖 を押したあと、受けた AI が AIセッション を書いた時刻。
// 同じタスクの直近 (2 時間以内) の、まだ打刻の無い新規起動の行に 1 回だけ書く。前回の続き (resume) は AIセッション を書き直さないので対象外
export async function launchStamp(env, taskId, now = Date.now()) {
  if (!env.DB) return { ok: true, stamped: 0 };
  await init(env);
  const r = await env.DB.prepare("UPDATE launch_log SET session_at=?1 WHERE rowid=(SELECT rowid FROM launch_log WHERE task_id=?2 AND resume=0 AND session_at IS NULL AND ts>=?3 AND ts<=?1 ORDER BY ts DESC LIMIT 1)")
    .bind(new Date(now).toISOString(), String(taskId).replace(/-/g, ""), new Date(now - 2 * 3600000).toISOString()).run();
  return { ok: true, stamped: r?.meta?.changes ?? r?.changes ?? 0 };
}
// 開始所要時間 (秒): 押してから AIセッション が入るまで。打刻のある新規起動だけを、全体 (all) と端末別に
export function startStats(rows) {
  const by = {};
  for (const x of rows) {
    if (!x.session_at || x.resume) continue;
    const sec = (Date.parse(x.session_at) - Date.parse(x.ts)) / 1000;
    if (!(sec >= 0)) continue;
    for (const k of ["all", x.device || "other"]) (by[k] ||= []).push(sec);
  }
  const out = {};
  for (const [k, v] of Object.entries(by)) {
    v.sort((a, b) => a - b);
    const mid = v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2;
    out[k] = { n: v.length, median: Math.round(mid), p90: Math.round(v[Math.min(v.length - 1, Math.ceil(v.length * 0.9) - 1)]) };
  }
  return out;
}

// ---- 使用率ログの表 ----
// rows: 表の行ごとのセル文字列の配列。「2026-10-20 08:16 | 火 | 8 | …」の 1 列目 (日時) と 3 列目 (週間%) を拾う。取得不可・時刻なしの行は捨てる
export function parseUsageRows(rows) {
  const out = [];
  for (const cells of rows) {
    const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}):(\d{2})/.exec(String(cells[0] || "").trim());
    const p = /^(\d+(?:\.\d+)?)/.exec(String(cells[2] || "").trim());
    if (!m || !p) continue;
    out.push({ at: `${m[1]}T${m[2]}:${m[3]}:00+09:00`, pct: Number(p[1]) });
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

// 週は月曜 16:00 (JST) の週間枠リセットで区切る
const RESET_MS = 16 * 3600000;
export function weekStart(ms) {
  const j = new Date(ms + 9 * 3600000 - RESET_MS); // JST にずらし、さらに 16 時間戻すと「リセットからの日付」になる
  const back = (j.getUTCDay() + 6) % 7; // 月曜=0
  const d = Date.UTC(j.getUTCFullYear(), j.getUTCMonth(), j.getUTCDate() - back);
  return d + RESET_MS - 9 * 3600000; // その月曜 16:00 JST の UTC ms
}
const DOW = ["日", "月", "火", "水", "木", "金", "土"];
// 入口別の本数と使用率を週ごとに並べる。launches: [{ts, entry}]、usage: parseUsageRows の結果
export function weeklyReport(launches, usage, weeks, now = Date.now()) {
  const n = Math.max(1, Math.min(26, weeks | 0 || 4));
  const credit = Date.parse(CREDIT_UNTIL);
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const s = weekStart(now) - i * 7 * 86400000, e = s + 7 * 86400000;
    const inW = (iso) => { const t = Date.parse(iso); return t >= s && t < e; };
    const L = launches.filter((x) => inW(x.ts)), U = usage.filter((x) => inW(x.at));
    const total = {};
    for (const x of L) total[x.entry] = (total[x.entry] || 0) + 1;
    const days = [];
    for (let k = 0; k < 7; k++) {
      const ds = s + k * 86400000, de = ds + 86400000; // 月16:00→火16:00 のように枠の 1 日で切る
      const dl = L.filter((x) => { const t = Date.parse(x.ts); return t >= ds && t < de; });
      const du = U.filter((x) => { const t = Date.parse(x.at); return t >= ds && t < de; });
      const by = {};
      for (const x of dl) by[x.entry] = (by[x.entry] || 0) + 1;
      const label = jstDay(ds);
      days.push({ from: label, dow: DOW[new Date(Date.parse(label + "T00:00:00Z")).getUTCDay()], launches: by, usagePct: du.length ? du[du.length - 1].pct : null, usageAt: du.length ? du[du.length - 1].at : null });
    }
    const last = U.length ? U[U.length - 1] : null;
    out.push({ start: new Date(s + 9 * 3600000).toISOString().slice(0, 16).replace("T", " ") + " JST", credit: s < credit, launches: total, cloudShare: L.length ? Math.round(((total.cloud || 0) / L.length) * 100) : null, lastUsagePct: last ? last.pct : null, lastUsageAt: last ? last.at : null, startSec: startStats(L), days });
  }
  return { creditUntil: CREDIT_UNTIL, note: "credit=true の週はクラウドセッションのクレジット期間で、クラウドの消費が週間枠に乗らないので比較に使わない", weeks: out };
}
export async function launchRows(env, sinceMs) {
  if (!env.DB) return [];
  await init(env);
  const r = await env.DB.prepare("SELECT ts, day, task_id, entry, repo, mode, resume, device, rule, session_at FROM launch_log WHERE ts>=? AND entry!='meta' ORDER BY ts").bind(new Date(sinceMs).toISOString()).all();
  return r.results || [];
}

// まとめてボタンの指紋 (2026-11-27): タブ先頭のまとめてボタンを押したとき、その一覧の指紋を launch_log に entry=meta で 1 行残す。
// 画面は直近の指紋と今の一覧を比べ、同じなら「前回から変化なし」を出して押す前に確かめる（同じ候補で空振り・重ね開きしたセッションが週約11件あったため）。
// 入口の集計 (launchRows・weeklyReport) には混ぜない
export async function metaFps(env, now = Date.now()) {
  if (!env.DB) return {};
  await init(env);
  const r = await env.DB.prepare("SELECT task_id, rule, ts FROM launch_log WHERE entry='meta' AND ts>=? ORDER BY ts DESC LIMIT 300").bind(new Date(now - 14 * 86400000).toISOString()).all();
  const out = {};
  for (const x of r.results || []) {
    const k = String(x.task_id).replace(/^meta:/, "");
    if (!out[k] && x.rule) out[k] = { fp: String(x.rule).replace(/^fp:/, ""), ts: x.ts };
  }
  return out;
}
