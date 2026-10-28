// ---- 🤖 の入口の切り分けと打刻 (2026-10-29) ----
// 入口は 3 つ: cloud (Claude Code のクラウド, claude.ai/code)・mac (Mac を接続して開く claude.ai/new)・cowork (それ以外の claude.ai/new)。
// 規則はここ 1 か所に置き、夜間の棚卸し (GET /api/entry/rules・POST /api/entry/fill) と 🤖 の打刻が同じものを読む。
// 本人が手で付けた実行環境は常に勝つ。自動判定は実行環境が空のときに埋めるだけで、上書きしない。
export const ENTRY_RULES = {
  version: 1,
  // 1. Mac の印: 実行環境に Mac・紙・郵送がある、または名前・説明・本文にこの語がある
  mac: { env: ["Mac", "紙・郵送"], words: [".env", "launchd", "SRS", "印刷", "スキャン", "box.com"], fill: "Mac" },
  // 2. リポジトリの仕事: エリア・種類が合い、名前・説明・本文にツール名・パス・リポジトリ名がある
  cloud: { env: ["クラウド"], area: ["自動化・システム"], kinds: ["作業", "調査"], words: ["saito-tools", "saito-workers", "kairos", "tasks-pwa", "tools/"], fill: "クラウド" },
  // 3. それ以外は Cowork (実行環境は空のまま)
  cowork: {},
  // 接続先 (app.html の cloudRepo と同じ。PR #33)
  repos: [{ re: "kairos|tasks-pwa", repo: "masakiplus/kairos" }, { re: "saito-workers", repo: "masakiplus/saito-workers" }],
  defaultRepo: "masakiplus/saito-tools",
};
// クラウドセッションのクレジットが切れる時刻。これより前に始まった週はクラウドの消費が週間枠に乗らないので、比較から外す印を付ける
export const CREDIT_UNTIL = "2026-11-05T16:59:00+09:00";
// 朝夕の使用率の定点記録を置いているタスク (表の「日時(JST)」「週間%」列を読む)。vars の USAGE_LOG_TASK_ID で差し替えられる
export const USAGE_LOG_TASK_ID = "4ba0eb7a7b194be1b8565d9906cb894a";

const hasWord = (text, words) => { const s = String(text || "").toLowerCase(); return words.find((w) => s.includes(w.toLowerCase())) || null; };
export function cloudRepo(text) {
  for (const r of ENTRY_RULES.repos) if (new RegExp(r.re, "i").test(text || "")) return r.repo;
  return ENTRY_RULES.defaultRepo;
}
// t: {name, rawDesc, area, kind, env, project}。body は本文の素の文字列 (無ければ名前と説明だけで判定)
export function classifyEntry(t, body = "") {
  const env = t.env || [], text = [t.name, t.rawDesc, body].join("\n");
  const R = ENTRY_RULES;
  const macEnv = env.find((x) => R.mac.env.includes(x));
  if (macEnv) return { entry: "mac", why: "実行環境: " + macEnv };
  const macWord = hasWord(text, R.mac.words);
  if (macWord) return { entry: "mac", why: "語: " + macWord };
  if (env.includes("クラウド")) return { entry: "cloud", why: "実行環境: クラウド", repo: cloudRepo((t.name || "") + " " + (t.project || "")) };
  if (R.cloud.area.includes(t.area) && R.cloud.kinds.includes(t.kind)) {
    const w = hasWord(text, R.cloud.words);
    if (w) return { entry: "cloud", why: "語: " + w, repo: cloudRepo((t.name || "") + " " + (t.project || "") + " " + w) };
  }
  return { entry: "cowork", why: "" };
}
// 🤖 を押したときに実際に飛んだ先。provider が claude 以外は provider 名、前回のセッションを開き直すときはその URL の種類
export function launchEntry(t, provider, resumeUrl) {
  if (provider && provider !== "claude") return String(provider).replace(/[^\w-]/g, "").slice(0, 20) || "other";
  if (resumeUrl) return /^https:\/\/claude\.ai\/code\//.test(resumeUrl) ? "cloud" : classifyEntry({ ...t, env: (t.env || []).filter((x) => x !== "クラウド") }).entry;
  if ((t.env || []).includes("クラウド")) return "cloud"; // app.html の isCloudTask と同じ。実行環境にクラウドがあるときだけ claude.ai/code へ飛ぶ
  return classifyEntry({ ...t, env: t.env || [] }).entry === "mac" ? "mac" : "cowork";
}

// ---- 打刻 (D1 の launch_log) ----
const jstDay = (ms) => new Date(ms + 9 * 3600000).toISOString().slice(0, 10);
let ready = null;
function init(env) {
  return (ready ||= env.DB.prepare("CREATE TABLE IF NOT EXISTS launch_log(ts TEXT NOT NULL, day TEXT NOT NULL, task_id TEXT NOT NULL, entry TEXT NOT NULL, repo TEXT, mode TEXT, resume INTEGER NOT NULL DEFAULT 0, device TEXT, rule TEXT)").run().catch((e) => { ready = null; throw e; }));
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
    out.push({ start: new Date(s + 9 * 3600000).toISOString().slice(0, 16).replace("T", " ") + " JST", credit: s < credit, launches: total, cloudShare: L.length ? Math.round(((total.cloud || 0) / L.length) * 100) : null, lastUsagePct: last ? last.pct : null, lastUsageAt: last ? last.at : null, days });
  }
  return { creditUntil: CREDIT_UNTIL, note: "credit=true の週はクラウドセッションのクレジット期間で、クラウドの消費が週間枠に乗らないので比較に使わない", weeks: out };
}
export async function launchRows(env, sinceMs) {
  if (!env.DB) return [];
  await init(env);
  const r = await env.DB.prepare("SELECT ts, day, task_id, entry, repo, mode, resume, device, rule FROM launch_log WHERE ts>=? ORDER BY ts").bind(new Date(sinceMs).toISOString()).all();
  return r.results || [];
}
