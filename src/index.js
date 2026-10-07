/**
 * Kairos (tasks-pwa) — Notion ✅ Tasks の薄いモバイル層 (Cloudflare Worker)。2026-09-27
 * 名前は 2026-09-29 に Kairos (ギリシャ語で「機が熟した時」) に決定。執務PC 側の Obsidian 運用は Chronos と対
 *
 * 役割分担:
 *   人      … 一覧を見て「完了 / 明日へ / 週末に / 来週に / 待ち / 追加」をその場で押す
 *   Claude  … 思考が要るもの (時間調整・実行・タスク内容の更新) は「🤖 Claudeへ」で投げる
 *   Notion  … 正本。ここは読み書きするだけで、規約 (完了3点セット・アイコン必須) は Worker に一本化する
 *
 * URL:
 *   GET  /                       PWA 本体 (app.html)。初回は ?t=<APP_TOKEN> を付けて開くと Cookie が入る
 *   GET  /manifest.webmanifest, /sw.js, /icon-192.png, /icon-512.png
 *   GET  /api/tasks?view=today|can|phone   一覧。Notion の 📱ビュー3本と同じフィルタ
 *   POST /api/tasks              {name} タイトルだけで起票 (残りは 04:45 の棚卸しが補完)
 *   GET  /api/tasks/:id/detail   概要 (説明プロパティ + 本文の先頭 40 ブロック)。メニューを開いたときだけ (2026-09-30)
 *   POST /api/tasks/:id/ai?mode=run|update  🤖 に渡した印 (AI処理開始=今, AI処理種別=実行/更新)。ai-clear で外す (2026-09-30, 種別 2026-10-03)
 *   POST /api/tasks/:id/done     完了チェック + 完了日=今日 + ステータス=完了 (Notion Tasks 操作規約 §4-1)
 *   POST /api/tasks/:id/reopen   done の取り消し (誤スワイプ用)
 *   POST /api/tasks/:id/skip     見送りで完了。done と同じ3点セット + 説明欄の先頭に「見送り (日付, PWA)」を残す
 *   done / skip / dup はどれも ?note=<1行> を受け、あれば根拠行に「: メモ」を続ける (done はメモがあるときだけ「完了 (日付, PWA): メモ」を先頭に) (2026-10-06)
 *   POST /api/tasks/:id/delegate?to=<担当>  家族へ委任 (2026-10-01)。担当 (select) を立てる。to= 空で自分に戻す。委任中は今日系タブから消え「委任」タブに出る
 *   POST /api/tasks/:id/restore  取り消し (2026-10-02)。body {due,startRaw,status,owner,desc,done} のうち渡された列だけ元に戻す (null=空にする)。Kairos の ↩ が使う
 *   POST /api/tasks/:id/dup      重複で完了 (2026-10-01)。done と同じ3点セット + 説明欄の先頭に「重複のため完了 (日付, PWA[, 相手: ?with])」
 *   GET  /api/tasks/:id/chain    未完了の先行タスクを順に (順送り実行用)。{chain:[…], cycle, truncated}
 *     done / skip の応答には pendingPreds (残っていた先行) と unblocked (着手可になった後続) が付く
 *   POST /api/tasks/:id/defer?days=1|7   開始日を今日から N 日後へ (土日に落ちたら次の月曜)。期日は期限切れのときだけ揃える
 *   POST /api/tasks/:id/wait     ステータス=待ち
 *   POST /api/tasks/:id/human    ステータス=人対応 (Claude が止めて本人の手番, 2026-10-03)
 *   POST /api/tasks/:id/start?date=YYYY-MM-DD   開始日を指定日に (期日がそれより前なら期日も同じ日へ)
 *   POST /api/tasks/:id/evening  今夜に送る (開始日=今日 18:00 の日時。一覧の「今夜」節に移る)
 *   POST /api/tasks/:id/daytime  今夜を解除して今日に戻す (開始日=今日、日付のみ)
 *   GET  /health                 認証なし。Worker が生きているかだけ返す
 *
 * 認証: Cookie `tp` か `Authorization: Bearer <APP_TOKEN>`。トークン1本の個人用なので凝らない。
 */
import APP_HTML from "./app.html";
import SW_JS from "./sw.txt";
import MANIFEST from "./manifest.webmanifest";
import { ICON_192_B64, ICON_512_B64 } from "./icons.js";

const NOTION_VERSION = "2025-09-03";
const COOKIE = "tp";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365; // 1年

// ---------- Notion ----------

async function notion(env, path, init = {}) {
  const res = await fetch(`https://api.notion.com/v1${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.NOTION_TOKEN}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Notion ${init.method ?? "GET"} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : undefined;
}

/** JST の今日 (YYYY-MM-DD)。JST は UTC+9 固定で DST 無し */
function todayJst() {
  return new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10);
}

/** 今日から days 日後。土日に落ちたら次の月曜 (棚卸しの「休暇中は平日へ倒す」方針と同じ) */
function deferDate(days) {
  const d = new Date(`${todayJst()}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  const dow = d.getUTCDay(); // 0=日 6=土
  if (dow === 6) d.setUTCDate(d.getUTCDate() + 2);
  else if (dow === 0) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** 週末実施 = 次の土曜 (今日が土なら明日=日、日なら来週の土)。来週実施 = 今日より後の月曜 */
function deferTo(to) {
  const d = new Date(`${todayJst()}T00:00:00Z`);
  const dow = d.getUTCDay(); // 0=日 6=土
  if (to === "weekend") {
    d.setUTCDate(d.getUTCDate() + (dow === 6 ? 1 : (6 - dow + 7) % 7 || 7));
  } else {
    d.setUTCDate(d.getUTCDate() + ((8 - dow) % 7 || 7));
  }
  return d.toISOString().slice(0, 10);
}

// Notion 側に同じフィルタのビューを 3 本置いて突き合わせられるようにしてある。式プロパティは文字列一致で引く。
const NOT_DONE = { property: "完了", checkbox: { equals: false } };
const NOT_WAITING = { property: "ステータス", status: { does_not_equal: "待ち" } };
const STARTABLE = { property: "着手可否", formula: { string: { equals: "着手可" } } };
const VIEWS = {
  today: {
    filter: {
      and: [
        NOT_DONE,
        // 着手可 に加えて 先行待ち も引く (期日が今日以前なら薄く出すため。passesView で絞る)
        { or: [STARTABLE, { property: "着手可否", formula: { string: { equals: "先行待ち" } } }] },
        {
          or: [
            { property: "期限区分", formula: { string: { equals: "①期限切れ" } } },
            { property: "期限区分", formula: { string: { equals: "②今日" } } },
          ],
        },
      ],
    },
    sorts: [{ property: "優先度", direction: "ascending" }],
  },
  // 着手中 (2026-10-08 利用者の指示): 進行中・人対応 の未完了。WIP の中身を一覧で見る。委任中は除く (passesView)
  doing: {
    filter: { and: [NOT_DONE, { or: [{ property: "ステータス", status: { equals: "進行中" } }, { property: "ステータス", status: { equals: "人対応" } }] }] },
    sorts: [{ property: "期日", direction: "ascending" }],
  },
  can: {
    filter: {
      and: [NOT_DONE, NOT_WAITING, { property: "前倒し候補", formula: { string: { equals: "候補" } } }],
    },
    sorts: [
      { property: "期日", direction: "ascending" },
      { property: "優先度", direction: "ascending" },
    ],
  },
  // プロジェクト別: 未完了でプロジェクトに紐づくもの全部 (開始日が先でも出す)。画面側でプロジェクトごとにまとめる
  project: {
    filter: { and: [NOT_DONE, { property: "関連プロジェクト", relation: { is_not_empty: true } }] },
    sorts: [
      { property: "期日", direction: "ascending" },
      { property: "優先度", direction: "ascending" },
    ],
  },
  // 委任中 (2026-10-01): 担当 が入っている未完了を全部。画面側で担当ごとにまとめる
  delegated: {
    filter: { and: [NOT_DONE, { property: "担当", select: { is_not_empty: true } }] },
    sorts: [
      { property: "担当", direction: "ascending" },
      { property: "期日", direction: "ascending" },
    ],
  },
  phone: {
    filter: {
      and: [
        NOT_DONE,
        NOT_WAITING,
        STARTABLE,
        {
          or: [
            { property: "実行環境", multi_select: { contains: "iPhone" } },
            { property: "実行環境", multi_select: { contains: "電話" } },
          ],
        },
      ],
    },
    sorts: [
      { property: "期日", direction: "ascending" },
      { property: "優先度", direction: "ascending" },
    ],
  },
};

// 担当 (select) の選択肢 ＝ 委任できる相手。Notion のスキーマから読む (ハードコードしない。公開リポジトリ化 2026-10-08)
let delegatesCache = { at: 0, list: [] };
async function delegates(env) {
  if (Date.now() - delegatesCache.at < 10 * 60_000 && delegatesCache.list.length) return delegatesCache.list;
  try {
    const ds = await notion(env, `/data_sources/${env.TASKS_DATA_SOURCE_ID}`);
    const list = (ds.properties?.["担当"]?.select?.options ?? []).map((o) => o.name).filter(Boolean);
    delegatesCache = { at: Date.now(), list };
  } catch (e) { /* 読めなければ前回の値 (無ければ空) */ }
  return delegatesCache.list;
}
const AI_ACTIVE_MS = 2 * 60 * 60 * 1000; // 🤖 処理中とみなす上限 (2026-09-30 決定: 2時間)

function pageToTask(page) {
  const p = page.properties ?? {};
  return {
    id: page.id,
    name: (p["名前"]?.title ?? []).map((t) => t.plain_text).join("") || "(無題)",
    due: (p["期日"]?.date?.start ?? "").slice(0, 10) || null,
    start: (p["開始日"]?.date?.start ?? "").slice(0, 10) || null,
    startRaw: p["開始日"]?.date?.start ?? null, // 時刻付き (🌙 今夜) をそのまま。取り消しの復元用 (2026-10-02)
    // 「今夜」= 開始日が日時で 17:00 以降 (Things の This Evening 相当。列は増やさない, 2026-09-28)
    // 翌日以降は「今夜」ではなく普通の「今日」に戻す (2026-09-30): 判定は 開始日 が JST の今日のときだけ
    evening: /T(1[7-9]|2[0-3]):/.test(p["開始日"]?.date?.start ?? "") && (p["開始日"]?.date?.start ?? "").slice(0, 10) === todayJst(),
    priority: p["優先度"]?.select?.name ?? null,
    status: p["ステータス"]?.status?.name ?? null,
    done: p["完了"]?.checkbox === true,
    area: p["エリア"]?.select?.name ?? null,
    env: (p["実行環境"]?.multi_select ?? []).map((o) => o.name),
    owner: p["担当"]?.select?.name ?? null, // 委任先 (2026-10-01)。空＝自分
    icon: page.icon?.type === "emoji" ? page.icon.emoji : null,
    url: page.url,
    projectIds: (p["関連プロジェクト"]?.relation ?? []).map((r) => r.id),
    project: null, // listTasks で名前を埋める
    // 先行タスク (2026-09-29)。blocked = 先行に未完了がある (着手可否=先行待ち)
    predIds: (p["先行タスク"]?.relation ?? []).map((r) => r.id),
    succIds: (p["後続タスク"]?.relation ?? []).map((r) => r.id),
    blocked: (p["先行未完了数"]?.rollup?.number ?? 0) > 0,
    blockedCount: p["先行未完了数"]?.rollup?.number ?? 0,
    // Claude に渡した時刻 (2026-09-30)。2時間以内なら「🤖 処理中」。Claude 側が終了時に空にする規約 (操作規約 §11)。
    // 外し忘れは 2時間で表示だけ元に戻り、04:45 の棚卸しが 24時間超を空にする
    aiSince: p["AI処理開始"]?.date?.start ?? null,
    aiMode: p["AI処理種別"]?.select?.name ?? null, // 実行 / 更新 (2026-10-03)。AI処理開始 と同時に立てる
    aiSession: p["AIセッション"]?.url ?? null, // 受けた Claude が開始時に書く自分のチャット URL (§11-5, 2026-10-03)。Kairos の「セッションを開く」
    aiActive: (() => { const t = Date.parse(p["AI処理開始"]?.date?.start ?? ""); return !!t && (Date.now() - t) < AI_ACTIVE_MS && p["完了"]?.checkbox !== true; })(),
    rawDesc: (p["説明"]?.rich_text ?? []).map((t) => t.plain_text).join(""),
    // ⭐ 今日の3つ (MIT, 2026-10-06): 当日の日付が入っていれば真。翌日には自然に外れる
    mit: (p["今日の3つ"]?.date?.start ?? "").slice(0, 10) === todayJst(),
    // 待ちの相手 (GTD の Waiting For, 2026-10-06): 説明欄の先頭行「待ち (日付, PWA): 相手」から拾う
    waitFor: (() => { const m = ((p["説明"]?.rich_text ?? []).map((t) => t.plain_text).join("")).match(/^待ち \([^)]*\): (.+)$/m); return m ? m[1].trim().slice(0, 60) : null; })(),
    // 繰越回数 (Bullet Journal の Migration, 2026-10-06): 棚卸しが書く「[棚卸し滞留 繰越N回 …]」から
    carry: (() => { const m = ((p["説明"]?.rich_text ?? []).map((t) => t.plain_text).join("")).match(/\[棚卸し滞留 繰越(\d+)回/); return m ? +m[1] : 0; })(),
  };
}

async function getTask(env, id) {
  return pageToTask(await notion(env, `/pages/${id}`));
}

/**
 * 順送り実行のチェーン: id の未完了の先行タスクを再帰的に辿り、先行が先になる順 (トポロジカル順) で返す。
 * 完了済みの先行は飛ばす。深さ上限 10、循環は cycle=true で知らせる。設計: Notion「⏭️ 先行タスク（依存）の設計」§3-3
 */
async function resolveChain(env, id) {
  const order = [], seen = new Set(), stack = new Set();
  let cycle = false, truncated = false;
  async function visit(tid, depth) {
    if (seen.has(tid)) return;
    if (stack.has(tid)) { cycle = true; return; }
    if (depth > 10) { truncated = true; return; }
    stack.add(tid);
    const t = await getTask(env, tid);
    if (!t.done) {
      // 並列の先行は 期日→優先度 の順 (作成順は API から取れないので名前で安定化)
      const preds = await Promise.all(t.predIds.map((pid) => getTask(env, pid)));
      preds.sort((a, b) => (a.due ?? "9999") < (b.due ?? "9999") ? -1 : (a.due ?? "9999") > (b.due ?? "9999") ? 1 : (a.priority ?? "p9") < (b.priority ?? "p9") ? -1 : 0);
      for (const p of preds) if (!p.done) await visit(p.id, depth + 1);
      if (tid !== id) order.push(t);
    }
    stack.delete(tid); seen.add(tid);
  }
  await visit(id, 0);
  return { chain: order, cycle, truncated };
}

// 📁 Projects の id→名前。一覧のたびに引かないよう isolate 内で 5 分キャッシュする
// 各 DB のデータソース ID は wrangler.toml の [vars] (PROJECTS_DATA_SOURCE_ID / ROLES_DATA_SOURCE_ID / DECISIONS_DATA_SOURCE_ID / HABITS_DATA_SOURCE_ID / HABIT_LOG_DATA_SOURCE_ID)
const PROJECT_CLOSED = ["完了", "アーカイブ"];
const RT_TEXT = (p) => (p?.rich_text ?? []).map((t) => t.plain_text).join("");
let projectCache = { at: 0, map: new Map(), rows: [] };
// Phase B (2026-10-06): 名前だけでなく 対応ゴール／完了条件／ステータス／役割 も一緒に持つ。Kairos が書き換えるのは ステータス だけ (設計ページ §3)
async function projectsAll(env) {
  if (Date.now() - projectCache.at < 5 * 60_000 && projectCache.map.size) return projectCache;
  const map = new Map(), rows = [];
  let cursor;
  do {
    const r = await notion(env, `/data_sources/${env.PROJECTS_DATA_SOURCE_ID}/query`, {
      method: "POST",
      body: JSON.stringify({ page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) }),
    });
    for (const pg of r.results ?? []) {
      const p = pg.properties ?? {};
      const name = (p["名前"]?.title ?? []).map((t) => t.plain_text).join("");
      const icon = pg.icon?.type === "emoji" ? pg.icon.emoji + " " : "";
      map.set(pg.id, icon + name);
      rows.push({
        id: pg.id, name, label: icon + name, url: pg.url,
        status: p["ステータス"]?.status?.name ?? null,
        goal: RT_TEXT(p["対応ゴール"]).trim() || null,
        cond: RT_TEXT(p["完了条件"]).trim() || null,
        roleIds: (p["役割"]?.relation ?? []).map((r) => r.id),
        theme: p["テーマ"]?.select?.name ?? null,
      });
    }
    cursor = r.has_more ? r.next_cursor : undefined;
  } while (cursor);
  projectCache = { at: Date.now(), map, rows };
  return projectCache;
}
async function projectNames(env) { return (await projectsAll(env)).map; }

// 📁 PJ別の見出し用 (Phase B-7/8): 進行中の PJ ごとに 完了／未完了 の件数、最後に完了したタスク、クローズ候補かどうか。
// クローズ候補 ＝ 未完了 0 件 かつ 完了 1 件以上 (完了条件の充足は人が見る)。止まっている ＝ 未完了 0 件 かつ 完了 0 件、または 対応ゴール 未記入
let projStatCache = { at: 0, data: null };
async function projectsInfo(env) {
  if (Date.now() - projStatCache.at < 2 * 60_000 && projStatCache.data) return projStatCache.data;
  const { rows } = await projectsAll(env);
  const active = rows.filter((p) => !PROJECT_CLOSED.includes(p.status));
  const stat = new Map(active.map((p) => [p.id, { done: 0, open: 0, linked: 0, lastDone: null, lastDoneAt: "" }]));
  async function scan(filter, onPage) {
    let cursor, pages = 0;
    do {
      const r = await notion(env, `/data_sources/${env.TASKS_DATA_SOURCE_ID}/query`, {
        method: "POST",
        body: JSON.stringify({ filter, page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) }),
      });
      for (const pg of r.results ?? []) onPage(pg);
      cursor = r.has_more ? r.next_cursor : undefined;
    } while (cursor && ++pages < 12);
  }
  const HAS_PJ = { property: "関連プロジェクト", relation: { is_not_empty: true } };
  await Promise.all([
    scan({ and: [NOT_DONE, HAS_PJ] }, (pg) => {
      // linked = 先行か後続が付いている未完了の数 (2026-10-07: 依存の洗い出し漏れを PJ 見出しで見せる)
      const hasDep = (pg.properties?.["先行タスク"]?.relation ?? []).length > 0 || (pg.properties?.["後続タスク"]?.relation ?? []).length > 0;
      for (const r of pg.properties?.["関連プロジェクト"]?.relation ?? []) { const s = stat.get(r.id); if (s) { s.open++; if (hasDep) s.linked++; } }
    }),
    scan({ and: [{ property: "完了", checkbox: { equals: true } }, HAS_PJ] }, (pg) => {
      const at = pg.properties?.["完了日"]?.date?.start ?? pg.last_edited_time ?? "";
      const name = (pg.properties?.["名前"]?.title ?? []).map((t) => t.plain_text).join("");
      for (const r of pg.properties?.["関連プロジェクト"]?.relation ?? []) { const s = stat.get(r.id); if (!s) continue; s.done++; if (at > s.lastDoneAt) { s.lastDoneAt = at; s.lastDone = name; } }
    }),
  ]);
  const roleNames = await rolesNames(env).catch(() => new Map());
  const data = active.map((p) => {
    const s = stat.get(p.id);
    return {
      ...p, done: s.done, open: s.open, lastDone: s.lastDone, lastDoneAt: s.lastDoneAt.slice(0, 10) || null,
      roles: p.roleIds.map((id) => roleNames.get(id)).filter(Boolean),
      closable: s.open === 0 && s.done > 0,
      stalled: s.open === 0 && s.done === 0,
      linked: s.linked,
      unordered: s.open >= 3 && s.linked === 0, // 未完了 3 件以上なのに依存が 1 本も無い ＝ 順番が整理されていない (2026-10-07)
    };
  });
  projStatCache = { at: Date.now(), data };
  return data;
}

// 🧭 Roles (Phase B-6): id→名前 と、役割ごとの ミッション／Q2／今週の目標。小さい DB なので毎回引く (キャッシュ 2 分)
let rolesCache = { at: 0, rows: [] };
async function rolesAll(env) {
  if (Date.now() - rolesCache.at < 2 * 60_000 && rolesCache.rows.length) return rolesCache.rows;
  const r = await notion(env, `/data_sources/${env.ROLES_DATA_SOURCE_ID}/query`, { method: "POST", body: JSON.stringify({ page_size: 50 }) });
  const rows = (r.results ?? []).map((pg) => {
    const p = pg.properties ?? {};
    return {
      id: pg.id, url: pg.url,
      name: (p["名前"]?.title ?? []).map((t) => t.plain_text).join(""),
      icon: pg.icon?.type === "emoji" ? pg.icon.emoji : null,
      mission: RT_TEXT(p["ミッション"]).trim() || null,
      q2: RT_TEXT(p["Q2テーマ"]).trim() || null,
      yearGoal: RT_TEXT(p["今年のゴール"]).trim() || null,
      weekGoalRaw: RT_TEXT(p["今週の目標"]).trim() || null,
      projectIds: (p["プロジェクト"]?.relation ?? []).map((r) => r.id),
    };
  });
  rolesCache = { at: Date.now(), rows };
  return rows;
}
async function rolesNames(env) { return new Map((await rolesAll(env)).map((r) => [r.id, r.name])); }
// 今週の目標 の書式 (週次レビュー規約):「〜M/D：<タスク名> → Tasks <page_id>」。Kairos はこの書式で書き、この書式だけ読む
// 実際の列は「〜10/11：<名> → Tasks <id>。（週次レビューの補足…）」と続くので、id までを拾って補足は無視する
const WEEK_GOAL_RE = /(?:〜|~|～)?\s*(\d{1,2}\/\d{1,2})?\s*[：:]?\s*(.+?)\s*→\s*Tasks\s+([0-9a-f]{32}|[0-9a-f-]{36})/;
function weekEndJst() { // 今週の日曜 (JST)。日曜なら今日
  const d = new Date(Date.now() + 9 * 3600_000); const dow = d.getUTCDay();
  d.setUTCDate(d.getUTCDate() + ((7 - dow) % 7));
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
}
async function rolesInfo(env) {
  const [roles, projects, todays, opens] = await Promise.all([rolesAll(env), projectsInfo(env), listTasks(env, "today").catch(() => []), listTasks(env, "project").catch(() => [])]);
  const today = todayJst();
  const byRole = new Map(roles.map((r) => [r.id, { pj: 0, today: 0, candidates: [] }]));
  const roleOfProject = new Map();
  for (const p of projects) { for (const rid of p.roleIds) { roleOfProject.set(p.id, rid); const b = byRole.get(rid); if (b) b.pj++; } }
  const rolesOf = (t) => new Set(t.projectIds.map((pid) => roleOfProject.get(pid)).filter(Boolean));
  for (const t of todays) for (const rid of rolesOf(t)) { const b = byRole.get(rid); if (b) b.today++; }
  // 今週の石の候補: その役割の PJ に属する未完了を 期日順 に 10 件まで (選ぶ画面用)
  opens.sort((a, b) => (a.due ?? "9999") < (b.due ?? "9999") ? -1 : 1);
  for (const t of opens) if (!t.done && !t.aiForeign && !t.mitForeign) for (const rid of rolesOf(t)) { const b = byRole.get(rid); if (b && b.candidates.length < 10) b.candidates.push({ id: t.id, name: t.name, due: t.due, icon: t.icon, project: t.project }); }
  const out = await Promise.all(roles.map(async (r) => {
    const b = byRole.get(r.id);
    let stone = null;
    const m = r.weekGoalRaw ? r.weekGoalRaw.match(WEEK_GOAL_RE) : null;
    if (m) {
      stone = { until: m[1] || null, name: m[2], taskId: m[3], state: "unknown" };
      try { const t = await getTask(env, m[3]); stone.name = t.name; stone.url = t.url; stone.state = t.done ? "done" : t.status === "進行中" || t.status === "人対応" ? "doing" : "todo"; stone.due = t.due; stone.icon = t.icon; } catch (e) { /* 消えたタスク */ }
    } else if (r.weekGoalRaw) stone = { name: r.weekGoalRaw.slice(0, 80), taskId: null, state: "text" }; // 書式外の自由文はそのまま見せる
    // 役割→PJ のツリー (C-11c, 2026-10-06): 進行中 PJ の一覧と件数。タップで PJ のつながりへ
    const pjs = projects.filter((p) => p.roleIds.includes(r.id)).map((p) => ({ id: p.id, label: p.label, status: p.status, open: p.open, done: p.done, closable: p.closable, stalled: p.stalled }))
      .sort((a, b) => (b.open - a.open) || a.label.localeCompare(b.label));
    return { id: r.id, url: r.url, name: r.name, icon: r.icon, mission: r.mission, q2: r.q2, yearGoal: r.yearGoal, stone, pj: b.pj, today: b.today, candidates: b.candidates, projects: pjs };
  }));
  const stones = out.filter((r) => r.stone && r.stone.taskId);
  const summary = { total: stones.length, done: stones.filter((r) => r.stone.state === "done").length, doing: stones.filter((r) => r.stone.state === "doing").length, todo: stones.filter((r) => r.stone.state === "todo").length };
  return { today, weekEnd: weekEndJst(), roles: out, summary, dsUrl: `collection://${env.ROLES_DATA_SOURCE_ID}` };
}
// 今週の石を置く／外す。Kairos が Roles に書く唯一の列 (設計 §3)
async function setRoleGoal(env, roleId, taskId) {
  let text = "";
  if (taskId) {
    const t = await getTask(env, taskId);
    // 前の石を補足として残す (週次レビューの書き方に合わせる)。長い補足は 80 字で切る
    const prev = (await rolesAll(env)).find((r) => r.id === roleId || r.id.replace(/-/g, "") === roleId.replace(/-/g, ""))?.weekGoalRaw;
    const pm = prev ? prev.match(WEEK_GOAL_RE) : null;
    text = `〜${weekEndJst()}：${t.name} → Tasks ${t.id}。（${todayJst()} Kairos で指名${pm ? `。前の石「${pm[2].slice(0, 40)}」${pm[3]}` : ""}）`;
  }
  const pg = await notion(env, `/pages/${roleId}`, { method: "PATCH", body: JSON.stringify({ properties: { "今週の目標": { rich_text: text ? [{ text: { content: text.slice(0, 1900) } }] : [] } } }) });
  rolesCache.at = 0;
  return { id: pg.id, weekGoalRaw: text || null };
}
// 🔗 1 タスク中心の 3 列 (C-11a, 2026-10-06): 先行 → 本タスク → 後続。完了済みも薄く出す
async function taskGraph(env, id) {
  const t = await getTask(env, id);
  const [preds, succs] = await Promise.all([
    Promise.all(t.predIds.slice(0, 12).map((pid) => getTask(env, pid).catch(() => null))),
    Promise.all(t.succIds.slice(0, 12).map((sid) => getTask(env, sid).catch(() => null))),
  ]);
  const names = await projectNames(env).catch(() => new Map());
  const fill = (x) => { x.project = x.projectIds.map((pid) => names.get(pid)).filter(Boolean).join(" / ") || null; return x; };
  fill(t); preds.filter(Boolean).forEach(fill); succs.filter(Boolean).forEach(fill);
  const roleNames = await rolesNames(env).catch(() => new Map());
  const { rows } = await projectsAll(env).catch(() => ({ rows: [] }));
  const pj = rows.find((p) => t.projectIds.map((x) => x.replace(/-/g, "")).includes(p.id.replace(/-/g, "")));
  return { today: todayJst(), task: t, preds: preds.filter(Boolean), succs: succs.filter(Boolean),
    project: pj ? { id: pj.id, label: pj.label } : null, roles: pj ? pj.roleIds.map((r) => roleNames.get(r)).filter(Boolean) : [] };
}

// 🔁 Habits の手動申告 (C-9 の残り, 2026-10-06): 計測方法が 手動／半自動 で 状態が 有効／定着済み の習慣のうち、まだ今日 (週N は今週) の記録が無いもの
function weekStartJst() { const d = new Date(Date.now() + 9 * 3600_000); const dow = (d.getUTCDay() + 6) % 7; d.setUTCDate(d.getUTCDate() - dow); return d.toISOString().slice(0, 10); }
async function habitsDue(env) {
  const today = todayJst(), sunday = new Date(Date.now() + 9 * 3600_000).getUTCDay() === 0;
  const r = await notion(env, `/data_sources/${env.HABITS_DATA_SOURCE_ID}/query`, { method: "POST", body: JSON.stringify({
    filter: { and: [{ or: [{ property: "計測方法", select: { equals: "手動" } }, { property: "計測方法", select: { equals: "半自動" } }] }, { or: [{ property: "状態", select: { equals: "有効" } }, { property: "状態", select: { equals: "定着済み" } }] }] }, page_size: 50 }) });
  const habits = (r.results ?? []).map((pg) => { const p = pg.properties ?? {}; return { id: pg.id, url: pg.url, name: (p["名前"]?.title ?? []).map((t) => t.plain_text).join(""), freq: p["頻度"]?.select?.name ?? "毎日", rule: RT_TEXT(p["判定ルール"]).slice(0, 120), roleIds: (p["役割"]?.relation ?? []).map((x) => x.id) }; });
  if (!habits.length) return [];
  const logs = await notion(env, `/data_sources/${env.HABIT_LOG_DATA_SOURCE_ID}/query`, { method: "POST", body: JSON.stringify({ filter: { property: "日付", date: { on_or_after: weekStartJst() } }, page_size: 100 }) }).catch(() => ({ results: [] }));
  const logged = new Map(); // habitId → [dates]
  for (const pg of logs.results ?? []) { const d = (pg.properties?.["日付"]?.date?.start ?? "").slice(0, 10); for (const h of pg.properties?.["習慣"]?.relation ?? []) { const k = h.id.replace(/-/g, ""); (logged.get(k) || logged.set(k, []).get(k)).push(d); } }
  const roleNames = await rolesNames(env).catch(() => new Map());
  return habits.filter((h) => {
    const ds = logged.get(h.id.replace(/-/g, "")) || [];
    if (h.freq === "毎日") return !ds.includes(today);
    return sunday && ds.length === 0; // 週N・毎週日曜 は日曜にまとめて聞く
  }).map((h) => ({ ...h, roles: h.roleIds.map((r) => roleNames.get(r)).filter(Boolean) }));
}
async function habitLog(env, habitId, done, note) {
  const today = todayJst();
  const h = await notion(env, `/pages/${habitId}`);
  const name = (h.properties?.["名前"]?.title ?? []).map((t) => t.plain_text).join("");
  const page = await notion(env, "/pages", { method: "POST", body: JSON.stringify({
    parent: { type: "data_source_id", data_source_id: env.HABIT_LOG_DATA_SOURCE_ID },
    properties: { "名前": { title: [{ text: { content: `${today} ${name}` } }] }, "日付": { date: { start: today } }, "習慣": { relation: [{ id: habitId }] },
      "達成": { checkbox: !!done }, "取得元": { select: { name: "manual" } }, ...(note ? { "メモ": { rich_text: [{ text: { content: note.slice(0, 300) } }] } } : {}) } }) });
  return { id: page.id, name, done: !!done };
}

// 🧭 象限 (C-10, 2026-10-06): コヴィー／アイゼンハワーの 重要×緊急。緊急＝期日が 3 日以内 (期限切れ含む)。重要＝⭐今日の3つ・今週の石・優先度 p1/p2
async function quadrant(env) {
  const today = todayJst();
  const [opens, roles] = await Promise.all([listTasks(env, "project").catch(() => []), rolesAll(env).catch(() => [])]);
  // PJ に属さない未完了も拾う (「project」ビューは PJ ありだけ)
  const extra = await notion(env, `/data_sources/${env.TASKS_DATA_SOURCE_ID}/query`, { method: "POST", body: JSON.stringify({
    filter: { and: [NOT_DONE, { property: "関連プロジェクト", relation: { is_empty: true } }] }, page_size: 100 }) }).catch(() => ({ results: [] }));
  const names = await projectNames(env).catch(() => new Map());
  const all = opens.concat((extra.results ?? []).map(pageToTask).map((t) => { t.project = null; return t; }));
  const stones = new Set(roles.map((r) => (r.weekGoalRaw || "").match(WEEK_GOAL_RE)?.[3]).filter(Boolean).map((x) => x.replace(/-/g, "")));
  const lim = (() => { const d = new Date(today + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + 3); return d.toISOString().slice(0, 10); })();
  const q = { q1: [], q2: [], q3: [], q4: [] };
  for (const t of all) {
    if (t.owner || t.done || t.status === "待ち") continue;
    if (t.start && t.start > today) continue; // 待機中は象限に出さない
    const urgent = !!t.due && t.due <= lim;
    const stone = stones.has(t.id.replace(/-/g, ""));
    const important = t.mit || stone || t.priority === "p1" || t.priority === "p2";
    if (!urgent && !important && !t.due) continue; // 日付なし・印なしは Q4 でもなく「未整理」。数だけ返す
    t.stone = stone;
    (urgent ? (important ? q.q1 : q.q3) : (important ? q.q2 : q.q4)).push(t);
  }
  const byDue = (a, b) => ((a.due ?? "9999") + a.name).localeCompare((b.due ?? "9999") + b.name);
  for (const k of Object.keys(q)) q[k].sort(byDue);
  const unsorted = all.filter((t) => !t.owner && !t.done && t.status !== "待ち" && !(t.start && t.start > today) && !t.due && !t.mit && !stones.has(t.id.replace(/-/g, "")) && t.priority !== "p1" && t.priority !== "p2").length;
  return { today, limit: lim, ...q, unsorted, rule: "緊急＝期日 3 日以内（期限切れ含む）／重要＝⭐今日の3つ・今週の石・p1/p2" };
}

// 🔗 PJ の依存 (Phase C-11, 2026-10-06): PJ のタスクを先行→後続の順 (トポロジカル順) に並べ、辺と日付の矛盾を返す。
// 画面側が幅で ガント (700px 以上) / 依存順タイムライン (未満) に描き分ける。矛盾 = 後続の期日 < 先行の期日
async function projectDeps(env, projectId) {
  const { rows } = await projectsAll(env);
  const p = rows.find((r) => r.id.replace(/-/g, "") === projectId.replace(/-/g, ""));
  if (!p) throw new Error("project not found");
  const out = [];
  let cursor;
  do {
    const r = await notion(env, `/data_sources/${env.TASKS_DATA_SOURCE_ID}/query`, {
      method: "POST",
      body: JSON.stringify({ filter: { property: "関連プロジェクト", relation: { contains: p.id } }, sorts: [{ property: "期日", direction: "ascending" }], page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) }),
    });
    for (const pg of r.results ?? []) out.push(pageToTask(pg));
    cursor = r.has_more ? r.next_cursor : undefined;
  } while (cursor && out.length < 200);
  const byId = new Map(out.map((t) => [t.id.replace(/-/g, ""), t]));
  const key = (id) => id.replace(/-/g, "");
  // 辺: PJ 内の先行→後続だけ。PJ 外の先行は件数だけ持つ
  const edges = [];
  for (const t of out) {
    t.predsIn = []; t.predsOut = 0;
    for (const pid of t.predIds) { const pr = byId.get(key(pid)); if (pr) { t.predsIn.push(pr.id); edges.push({ from: pr.id, to: t.id, bad: !!(pr.due && t.due && t.due < pr.due), predDone: pr.done }); } else t.predsOut++; }
  }
  // トポロジカル順 (Kahn)。同順位は 期日→開始日→名前。循環は残りをそのまま末尾に
  const indeg = new Map(out.map((t) => [t.id, t.predsIn.length]));
  const succs = new Map(out.map((t) => [t.id, []]));
  for (const e of edges) succs.get(e.from).push(e.to);
  const cmp = (a, b) => ((a.due ?? "9999") + (a.start ?? "9999") + a.name).localeCompare((b.due ?? "9999") + (b.start ?? "9999") + b.name);
  let ready = out.filter((t) => indeg.get(t.id) === 0).sort(cmp);
  const order = [], seen = new Set();
  while (ready.length) {
    const t = ready.shift(); order.push(t); seen.add(t.id);
    const next = [];
    for (const sid of succs.get(t.id)) { indeg.set(sid, indeg.get(sid) - 1); if (indeg.get(sid) === 0) next.push(byId.get(key(sid))); }
    ready = ready.concat(next).sort(cmp);
  }
  const cycle = out.filter((t) => !seen.has(t.id));
  const tasks = order.concat(cycle.sort(cmp)).map((t) => ({
    id: t.id, name: t.name, icon: t.icon, url: t.url, done: t.done, status: t.status, due: t.due, start: t.start, startRaw: t.startRaw, priority: t.priority,
    env: t.env, owner: t.owner, blocked: t.blocked, blockedCount: t.blockedCount, predIds: t.predsIn, predsOut: t.predsOut, aiActive: t.aiActive, rawDesc: t.rawDesc, projectIds: t.projectIds, project: p.label,
  }));
  const conflicts = edges.filter((e) => e.bad && !byId.get(key(e.to)).done).map((e) => {
    const a = byId.get(key(e.from)), b = byId.get(key(e.to));
    return { pred: { id: a.id, name: a.name, due: a.due }, succ: { id: b.id, name: b.name, due: b.due } };
  });
  const noPj = 0; // (孤立タスクの件数は一覧側で持つ)
  return { today: todayJst(), project: { id: p.id, name: p.name, label: p.label, goal: p.goal, roles: p.roleIds, url: p.url }, tasks, edges, conflicts, cycle: cycle.length > 0, noPj };
}

// 🗂 見直し (Phase C-9, 2026-10-06): 機械的に作れる問いだけをカードにする。判断理由が要るものは Claude へ逃がす。
// 出す問い: (1) Decisions の未決 (状態≠決着・開始日が来ている)、(2) PJ のクローズ候補、(3) 繰越 3 回以上のタスク、(4) Decisions の検証待ち
const DEC_RT = (p) => (p?.rich_text ?? []).map((t) => t.plain_text).join("");
// 依存案の行 (種別=依存案) の機械行: 結論 に「[deps pred=<id> succ=<id>]」、問い に理由、名前 に「「先」→「後」」。棚卸しの finalize.py が書く書式
function parseDepsRow(p) {
  const s = DEC_RT(p["結論"]);
  const m = s.match(/\[deps pred=([0-9a-f-]{32,36}) succ=([0-9a-f-]{32,36})([^\]]*)\]/);
  if (!m) return null;
  const kv = Object.fromEntries([...m[3].matchAll(/(\w+)=(\S+)/g)].map((x) => [x[1], x[2]]));
  const name = (p["名前"]?.title ?? []).map((t) => t.plain_text).join("");
  const nm = name.match(/^「(.+?)」\s*→\s*「(.+?)」/);
  const D = (x) => (/^\d{4}-\d{2}-\d{2}$/.test(x || "") ? x : null);
  // sstart/sdue (2026-10-07): 結ぶときに後続の 開始日／期日 も一緒に置く提案 (先行の期日より前に始まらないように)
  return { predId: m[1], succId: m[2], predName: nm ? nm[1] : "先行", succName: nm ? nm[2] : "後続", sstart: D(kv.sstart), sdue: D(kv.sdue) };
}
// 日程案の行 (種別=日程案): 結論 に「[dates task=<id> start=YYYY-MM-DD due=YYYY-MM-DD]」(どちらか片方でも可)
function parseDatesRow(p) {
  const m = DEC_RT(p["結論"]).match(/\[dates task=([0-9a-f-]{32,36})([^\]]*)\]/);
  if (!m) return null;
  const kv = Object.fromEntries([...m[2].matchAll(/(\w+)=(\S+)/g)].map((x) => [x[1], x[2]]));
  const D = (x) => (/^\d{4}-\d{2}-\d{2}$/.test(x || "") ? x : null);
  const r = { taskId: m[1], start: D(kv.start), due: D(kv.due) };
  return r.start || r.due ? r : null;
}
async function reviewQuestions(env) {
  const today = todayJst();
  const out = [];
  const [projects, decs, verif, carried] = await Promise.all([
    projectsInfo(env).catch(() => []),
    notion(env, `/data_sources/${env.DECISIONS_DATA_SOURCE_ID}/query`, { method: "POST", body: JSON.stringify({
      filter: { and: [{ property: "状態", select: { does_not_equal: "決着" } }, { or: [{ property: "開始日", date: { is_empty: true } }, { property: "開始日", date: { on_or_before: today } }] }] },
      sorts: [{ property: "日付", direction: "ascending" }], page_size: 30 }) }).catch(() => ({ results: [] })),
    notion(env, `/data_sources/${env.DECISIONS_DATA_SOURCE_ID}/query`, { method: "POST", body: JSON.stringify({
      filter: { and: [{ property: "状態", select: { equals: "決着" } }, { property: "検証日", date: { on_or_before: today } }, { property: "検証結果", select: { is_empty: true } }] },
      sorts: [{ property: "検証日", direction: "ascending" }], page_size: 20 }) }).catch(() => ({ results: [] })),
    notion(env, `/data_sources/${env.TASKS_DATA_SOURCE_ID}/query`, { method: "POST", body: JSON.stringify({
      filter: { and: [NOT_DONE, { property: "説明", rich_text: { contains: "[棚卸し滞留 繰越" } }] }, page_size: 50 }) }).catch(() => ({ results: [] })),
  ]);
  const names = await projectNames(env).catch(() => new Map());
  // (2) PJ クローズ候補 — その場で決着できる
  for (const p of projects.filter((p) => p.closable)) out.push({
    kind: "project-close", db: "Projects", label: "クローズ可否", id: p.id, url: p.url,
    q: `「${p.name}」のタスクは ${p.done} 件とも完了しています。クローズしますか？`,
    ctx: [["完了条件", p.cond || "未記入"], ["最後の完了", p.lastDone ? `${p.lastDoneAt ? p.lastDoneAt.slice(5).replace("-", "/") + " " : ""}${p.lastDone}` : "—"], ["役割", (p.roles || []).join("・") || "—"]].filter((x) => x[1]),
    options: [{ a: "close", t: "クローズする", s: "Decisions に決着行", pri: true }, { a: "add", t: "まだ続ける", s: "次のアクションを起票" }, { a: "skip", t: "今は決めない", s: "次回また聞く" }],
    name: p.name, projectLabel: p.label,
  });
  // (1) Decisions の未決
  for (const pg of decs.results ?? []) {
    const p = pg.properties ?? {};
    const name = (p["名前"]?.title ?? []).map((t) => t.plain_text).join("");
    if (!name) continue;
    const ai = p["AI推奨"]?.select?.name ?? null;
    const pj = (p["関連プロジェクト"]?.relation ?? []).map((r) => names.get(r.id)).filter(Boolean);
    // (6) 依存案 (2026-10-07): 夜間棚卸しが「A の後に B」を提案した行。結ぶ／結ばない で決着。機械が結ぶとタスクが操作不能 (blocked) になり得るので人が確定する
    if (p["種別"]?.select?.name === "依存案") {
      const d = parseDepsRow(p);
      if (!d) continue;
      out.push({
        kind: "deps", db: "Decisions", label: "依存の提案", id: pg.id, url: pg.url,
        q: name, body: DEC_RT(p["問い"]).slice(0, 300) || null,
        ctx: [["先に", d.predName], ["後に", d.succName], ["後続の日程", [d.sstart && `開始 ${d.sstart.slice(5).replace("-", "/")}`, d.sdue && `期日 ${d.sdue.slice(5).replace("-", "/")}`].filter(Boolean).join("・")], ["PJ", pj.join("・")]].filter((x) => x[1]),
        options: [{ a: "link", t: d.sstart || d.sdue ? "結んで日程も置く" : "結ぶ", s: `「${d.succName.slice(0, 14)}」の先行に入れる`, pri: true }, ...(d.sstart || d.sdue ? [{ a: "linkonly", t: "結ぶだけ", s: "日程は触らない" }] : []), { a: "nolink", t: "結ばない", s: "順番の制約は無い" }, { a: "skip", t: "今は決めない", s: "提示済みにして次回" }],
        name,
      });
      continue;
    }
    // (7) 日程案 (2026-10-07): 依存の洗い出しと一緒に、開始日・期日が無い／矛盾しているタスクの日程を提案した行
    if (p["種別"]?.select?.name === "日程案") {
      const d = parseDatesRow(p);
      if (!d) continue;
      out.push({
        kind: "dates", db: "Decisions", label: "日程の提案", id: pg.id, url: pg.url,
        q: name, body: DEC_RT(p["問い"]).slice(0, 300) || null,
        ctx: [["開始日", d.start], ["期日", d.due], ["PJ", pj.join("・")]].filter((x) => x[1]),
        options: [{ a: "apply", t: "この日程にする", s: "開始日・期日を書く", pri: true }, { a: "nope", t: "置かない", s: "日程は決めない" }, { a: "skip", t: "今は決めない", s: "提示済みにして次回" }],
        name,
      });
      continue;
    }
    out.push({
      kind: "decision", db: "Decisions", label: p["状態"]?.select?.name === "提示済み" ? "提示済みの未決" : "提案中", id: pg.id, url: pg.url,
      q: name, body: DEC_RT(p["問い"]).slice(0, 400) || null,
      ctx: [["出所", DEC_RT(p["出所"]).slice(0, 60)], ["AI推奨", ai], ["PJ", pj.join("・")], ["日付", (p["日付"]?.date?.start ?? "").slice(0, 10)]].filter((x) => x[1]),
      options: [{ a: "着手する", t: "着手する", s: "決着・次のアクションへ", pri: ai === "着手する" }, { a: "棚上げ", t: "棚上げ", s: "決着・今は動かない", pri: ai === "棚上げ" }, { a: "削除", t: "やめる", s: "決着・削除扱い", pri: ai === "削除" }, { a: "skip", t: "今は決めない", s: "提示済みにして次回" }],
      name,
    });
  }
  // (3) 繰越 3 回以上のタスク (Bullet Journal の Migration: まだ生きているか問う)
  for (const pg of carried.results ?? []) {
    const t = pageToTask(pg);
    if (t.carry < 3 || t.owner) continue;
    out.push({
      kind: "task-carry", db: "Tasks", label: `繰越 ${t.carry} 回`, id: t.id, url: t.url,
      q: `「${t.name}」は棚卸しで ${t.carry} 回繰り越されています。まだやりますか？`,
      ctx: [["期日", t.due || "なし"], ["PJ", t.projectIds.map((id) => names.get(id)).filter(Boolean).join("・")], ["優先度", t.priority]].filter((x) => x[1]),
      options: [{ a: "skip-done", t: "やめる（見送りで完了）", s: "説明に見送りの根拠を残す" }, { a: "mit", t: "⭐ 今日の3つに入れて片付ける", s: "今日やる" }, { a: "nextweek", t: "来週に送る", s: "開始日を来週の月曜に", }, { a: "skip", t: "今は決めない", s: "次回また聞く" }],
      name: t.name, task: t,
    });
  }
  // (5) 習慣の手動申告 (Atomic Habits の記録): 今日 (週N は日曜に今週) の記録が無い 手動／半自動 の習慣
  try {
    for (const h of await habitsDue(env)) out.push({
      kind: "habit", db: "Habits", label: h.freq, id: h.id, url: h.url,
      q: h.freq === "毎日" ? `今日「${h.name}」はやりましたか？` : `今週「${h.name}」（${h.freq}）はできましたか？`,
      ctx: [["判定", h.rule], ["役割", (h.roles || []).join("・")]].filter((x) => x[1]),
      options: [{ a: "done", t: "やった", s: "Habit Log に達成で記録", pri: true }, { a: "miss", t: "やらなかった", s: "未達で記録（正直に）" }, { a: "skip", t: "今は決めない", s: "次回また聞く" }],
      name: h.name,
    });
  } catch (e) { /* Habits が読めなくても他の問いは出す */ }
  // (4) 検証待ちの決定 (PDCA の C: 当たり外れを記録する)
  for (const pg of verif.results ?? []) {
    const p = pg.properties ?? {};
    const name = (p["名前"]?.title ?? []).map((t) => t.plain_text).join("");
    out.push({
      kind: "verify", db: "Decisions", label: "検証待ち", id: pg.id, url: pg.url,
      q: `「${name}」は決めてから検証日を迎えました。結果は？`,
      ctx: [["結論", DEC_RT(p["結論"]).slice(0, 120)], ["期待する結果", DEC_RT(p["期待する結果"]).slice(0, 120)], ["検証日", (p["検証日"]?.date?.start ?? "").slice(0, 10)]].filter((x) => x[1]),
      options: [{ a: "当たり", t: "当たり", s: "期待どおりだった", pri: true }, { a: "部分的", t: "部分的", s: "一部だけ" }, { a: "外れ", t: "外れ", s: "期待と違った" }, { a: "検証不要", t: "検証不要", s: "見なくてよい" }],
      name,
    });
  }
  return { today, questions: out };
}
// 見直しの答えを Notion に書く。decision の決着・検証結果・繰越タスクの処理。PJ クローズは closeProject を使う
async function reviewAnswer(env, kind, id, answer, note) {
  const today = todayJst();
  const memo = (note || "").replace(/\s+/g, " ").trim().slice(0, 300);
  if (kind === "decision") {
    if (answer === "skip") { // 提示したが決めなかった: 提示済みにして次回へ
      await notion(env, `/pages/${id}`, { method: "PATCH", body: JSON.stringify({ properties: { "状態": { select: { name: "提示済み" } }, "提示日": { date: { start: today } } } }) });
      return { ok: true, state: "提示済み" };
    }
    if (!["着手する", "棚上げ", "削除"].includes(answer)) throw new Error("bad answer");
    const props = { "状態": { select: { name: "決着" } }, "決定": { select: { name: answer } }, "決定日": { date: { start: today } },
      "結論": { rich_text: [{ text: { content: (`${answer} (${today}, Kairos 見直し)` + (memo ? `: ${memo}` : "")).slice(0, 1900) } }] } };
    await notion(env, `/pages/${id}`, { method: "PATCH", body: JSON.stringify({ properties: props }) });
    return { ok: true, state: "決着" };
  }
  if (kind === "deps") { // 依存案 (2026-10-07): link=後続の 先行タスク に先行を足して決着、nolink=結ばずに決着、skip=提示済み
    const pg = await notion(env, `/pages/${id}`);
    const d = parseDepsRow(pg.properties ?? {});
    if (!d) throw new Error("not a deps row");
    if (answer === "skip") {
      await notion(env, `/pages/${id}`, { method: "PATCH", body: JSON.stringify({ properties: { "状態": { select: { name: "提示済み" } }, "提示日": { date: { start: today } } } }) });
      return { ok: true, state: "提示済み" };
    }
    if (!["link", "linkonly", "nolink"].includes(answer)) throw new Error("bad answer");
    let linked = false, dated = false;
    if (answer !== "nolink") {
      const succ = await getTask(env, d.succId);
      const have = new Set(succ.predIds.map((x) => x.replace(/-/g, "")));
      const props = {};
      if (!have.has(d.predId.replace(/-/g, ""))) { props["先行タスク"] = { relation: [...succ.predIds, d.predId].map((x) => ({ id: x })) }; linked = true; }
      if (answer === "link") { // 日程も一緒に置く (提案があるものだけ)
        if (d.sstart) props["開始日"] = { date: { start: d.sstart } };
        if (d.sdue) props["期日"] = { date: { start: d.sdue } };
        dated = !!(d.sstart || d.sdue);
      }
      if (Object.keys(props).length) await patchTask(env, d.succId, props);
      projStatCache.at = 0;
    }
    const conclusion = `${answer === "nolink" ? "結ばない" : dated ? "結んで日程も置いた" : "結んだ"} (${today}, Kairos 見直し)` + (memo ? `: ${memo}` : "") + ` ${DEC_RT(pg.properties?.["結論"]).match(/\[deps [^\]]*\]/)?.[0] ?? ""}`;
    await notion(env, `/pages/${id}`, { method: "PATCH", body: JSON.stringify({ properties: { "状態": { select: { name: "決着" } }, "決定": { select: { name: answer === "nolink" ? "削除" : "決定済み" } }, "決定日": { date: { start: today } }, "結論": { rich_text: [{ text: { content: conclusion.slice(0, 1900) } }] } } }) });
    return { ok: true, state: "決着", linked, dated };
  }
  if (kind === "dates") { // 日程案 (2026-10-07): apply=開始日・期日を書いて決着、nope=決着(削除)、skip=提示済み
    const pg = await notion(env, `/pages/${id}`);
    const d = parseDatesRow(pg.properties ?? {});
    if (!d) throw new Error("not a dates row");
    if (answer === "skip") {
      await notion(env, `/pages/${id}`, { method: "PATCH", body: JSON.stringify({ properties: { "状態": { select: { name: "提示済み" } }, "提示日": { date: { start: today } } } }) });
      return { ok: true, state: "提示済み" };
    }
    if (answer !== "apply" && answer !== "nope") throw new Error("bad answer");
    if (answer === "apply") {
      const props = {};
      if (d.start) props["開始日"] = { date: { start: d.start } };
      if (d.due) props["期日"] = { date: { start: d.due } };
      await patchTask(env, d.taskId, props);
    }
    const conclusion = `${answer === "apply" ? "日程を置いた" : "置かない"} (${today}, Kairos 見直し)` + (memo ? `: ${memo}` : "") + ` ${DEC_RT(pg.properties?.["結論"]).match(/\[dates [^\]]*\]/)?.[0] ?? ""}`;
    await notion(env, `/pages/${id}`, { method: "PATCH", body: JSON.stringify({ properties: { "状態": { select: { name: "決着" } }, "決定": { select: { name: answer === "apply" ? "決定済み" : "削除" } }, "決定日": { date: { start: today } }, "結論": { rich_text: [{ text: { content: conclusion.slice(0, 1900) } }] } } }) });
    return { ok: true, state: "決着" };
  }
  if (kind === "verify") {
    if (!["当たり", "外れ", "部分的", "検証不要"].includes(answer)) throw new Error("bad answer");
    const props = { "検証結果": { select: { name: answer } } };
    if (memo) props["学び"] = { rich_text: [{ text: { content: memo } }] };
    await notion(env, `/pages/${id}`, { method: "PATCH", body: JSON.stringify({ properties: props }) });
    return { ok: true };
  }
  if (kind === "habit") {
    if (answer !== "done" && answer !== "miss") throw new Error("bad answer");
    return { ok: true, log: await habitLog(env, id, answer === "done", memo) };
  }
  if (kind === "task-carry") {
    const cur = await getTask(env, id);
    if (answer === "skip-done") {
      const props = doneProps();
      props["AI処理開始"] = { date: null }; props["AI処理種別"] = { select: null };
      props["説明"] = { rich_text: [{ text: { content: (`見送り (${today}, PWA 見直し)` + (memo ? `: ${memo}` : "") + (cur.rawDesc ? "\n" + cur.rawDesc : "")).slice(0, 1900) } }] };
      await patchTask(env, id, props);
      return { ok: true };
    }
    if (answer === "mit") { await patchTask(env, id, { "今日の3つ": { date: { start: today } }, ...(cur.start && cur.start > today ? { "開始日": { date: { start: today } } } : {}) }); return { ok: true }; }
    if (answer === "nextweek") {
      const d = deferTo("nextweek"); const props = { "開始日": { date: { start: d } } };
      if (cur.due && (cur.due < d || (cur.start && cur.due === cur.start))) props["期日"] = { date: { start: d } }; // 延期と同じ条件 (2026-10-07)
      await patchTask(env, id, props); return { ok: true };
    }
    throw new Error("bad answer");
  }
  throw new Error("bad kind");
}

// PJ をクローズ (Phase B-8): ステータス=完了 にし、Decisions に決着行を 1 行入れる (手動の決定として残す)
async function closeProject(env, projectId, note) {
  const { rows } = await projectsAll(env);
  const p = rows.find((r) => r.id === projectId || r.id.replace(/-/g, "") === projectId.replace(/-/g, ""));
  if (!p) throw new Error("project not found");
  const today = todayJst();
  await notion(env, `/pages/${p.id}`, { method: "PATCH", body: JSON.stringify({ properties: { "ステータス": { status: { name: "完了" } } } }) });
  const conclusion = (note || "").trim() || "タスクが全て完了したので Kairos からクローズ";
  const dec = await notion(env, "/pages", {
    method: "POST",
    body: JSON.stringify({
      parent: { type: "data_source_id", data_source_id: env.DECISIONS_DATA_SOURCE_ID },
      icon: { type: "emoji", emoji: "📁" },
      properties: {
        "名前": { title: [{ text: { content: `「${p.name}」をクローズ` } }] },
        "状態": { select: { name: "決着" } },
        "種別": { select: { name: "手動" } },
        "決定": { select: { name: "決定済み" } },
        "問い": { rich_text: [{ text: { content: `PJ「${p.name}」をクローズするか` } }] },
        "結論": { rich_text: [{ text: { content: `クローズ (${today}, PWA): ${conclusion}`.slice(0, 1900) } }] },
        "出所": { rich_text: [{ text: { content: "Kairos PJ別タブ" } }] },
        "関連プロジェクト": { relation: [{ id: p.id }] },
        ...(p.roleIds.length ? { "役割": { relation: p.roleIds.map((id) => ({ id })) } } : {}),
        "日付": { date: { start: today } },
        "決定日": { date: { start: today } },
      },
    }),
  });
  projectCache.at = 0; projStatCache.at = 0;
  return { project: { id: p.id, name: p.name, status: "完了" }, decision: { id: dec.id, url: dec.url } };
}

// Notion の式 (着手可否・期限区分・前倒し候補) と同じ判定を JST の今日で二重にかける。
// 式は now() の扱いで UTC とズレたことがあり (2026-09-28 に前倒し候補を修正)、更新直後は
// 式の再計算が遅れて古い結果が返ることもあるので、素の 期日・開始日 から確かめ直す。
function passesView(t, view, today) {
  if (t.done) return false;
  if (view === "delegated") return !!t.owner;
  if (t.owner) return false; // 委任中は自分のタブに出さない (2026-10-01)。PJ別にも出さず「委任」タブで見る
  if (view === "project") return t.projectIds.length > 0; // 待機・待ちも含めて全部
  if (view === "doing") return t.status === "進行中" || t.status === "人対応"; // 着手中は開始日が先でも先行待ちでも出す
  // 先行待ち: 今日系タブには原則出さない。期日が今日以前のものだけ「今日やる」に薄く出す (2026-09-29 決定)
  if (t.blocked) return view === "today" && !!t.due && t.due <= today;
  if (t.start && t.start > today) return false; // 着手可否=待機
  if (view === "today") return !!t.due && t.due <= today;
  if (view === "can" || view === "phone") {
    if (t.status === "待ち") return false;
    if (view === "phone") return t.env.includes("iPhone") || t.env.includes("電話");
    if (!t.due) return true;
    const d = Math.round((Date.parse(t.due + "T00:00:00Z") - Date.parse(today + "T00:00:00Z")) / 86_400_000);
    return d >= 1 && d <= 7;
  }
  return true;
}

function dedupeTasks(arr) { const seen = new Set(); return arr.filter((t) => { const k = t.id.replace(/-/g, ""); if (seen.has(k)) return false; seen.add(k); return true; }); }
async function listTasks(env, view) {
  const spec = VIEWS[view];
  if (!spec) throw new Error(`unknown view: ${view}`);
  const today = todayJst();
  const out = [];
  let cursor;
  do {
    const r = await notion(env, `/data_sources/${env.TASKS_DATA_SOURCE_ID}/query`, {
      method: "POST",
      body: JSON.stringify({ ...spec, page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) }),
    });
    for (const page of r.results ?? []) {
      const t = pageToTask(page);
      if (passesView(t, view, today)) out.push(t);
    }
    cursor = r.has_more ? r.next_cursor : undefined;
  } while (cursor && out.length < 300);
  // 🤖 処理中のタスクはどのタブにも出す (2026-10-03)。ビューのフィルタに関係なく AI処理開始 が立っている未完了を足す
  try {
    const r = await notion(env, `/data_sources/${env.TASKS_DATA_SOURCE_ID}/query`, {
      method: "POST",
      body: JSON.stringify({ filter: { and: [NOT_DONE, { property: "AI処理開始", date: { is_not_empty: true } }] }, page_size: 50 }),
    });
    const have = new Set(out.map((t) => t.id));
    for (const page of r.results ?? []) {
      const t = pageToTask(page);
      if (t.aiActive && !have.has(t.id)) { t.aiForeign = true; out.push(t); }
    }
  } catch (e) { /* 一覧本体は返す */ }
  // ⭐ 今日の3つ の合流は 今日やる だけ (2026-10-07 利用者「星印は出さないように」。他のタブはそのタブの条件を満たすものだけ)
  if (view === "today") try {
    const r = await notion(env, `/data_sources/${env.TASKS_DATA_SOURCE_ID}/query`, {
      method: "POST",
      body: JSON.stringify({ filter: { and: [NOT_DONE, { property: "今日の3つ", date: { equals: today } }] }, page_size: 10 }),
    });
    const have = new Set(out.map((t) => t.id));
    for (const page of r.results ?? []) {
      const t = pageToTask(page);
      if (!t.mit || have.has(t.id)) continue;
      // ⭐ なのに開始日が未来 (Dreamtime が 10/10 開始のタスクを今日の3つに置いた, 2026-10-07): 今日やるものなので開始日を今日に戻す
      if (t.start && t.start > today) { try { await patchTask(env, t.id, { "開始日": { date: { start: today } } }); t.start = today; t.startRaw = today; } catch (e) { /* 表示は続ける */ } }
      t.mitForeign = true; out.push(t);
    }
  } catch (e) { /* 一覧本体は返す */ }
  // 同じページが 2 回返ることがある (並びに同値が多いときの Notion のページング)。id で重複を落とす (2026-10-06, 象限で発覚)
  const uniq = dedupeTasks(out);
  if (uniq.some((t) => t.projectIds.length)) {
    const names = await projectNames(env).catch(() => new Map());
    for (const t of uniq) t.project = t.projectIds.map((id) => names.get(id)).filter(Boolean).join(" / ") || null;
  }
  return uniq;
}

// WIP (着手中) の件数 (Personal Kanban の WIP 制限, 2026-10-06): ステータスが 進行中 か 人対応 の未完了。上限を超えたら Kairos が警告する
const WIP_LIMIT = 10; // 2026-10-06 夜: 5 → 10 (利用者「同時に実行できるタスクの数は10個ぐらい」)
async function wipCount(env) {
  const r = await notion(env, `/data_sources/${env.TASKS_DATA_SOURCE_ID}/query`, {
    method: "POST",
    body: JSON.stringify({ filter: { and: [NOT_DONE, { or: [{ property: "ステータス", status: { equals: "進行中" } }, { property: "ステータス", status: { equals: "人対応" } }] }] }, page_size: 100 }),
  });
  const rows = (r.results ?? []).map(pageToTask).filter((t) => !t.owner); // 委任中は自分の WIP に数えない
  return { count: rows.length, limit: WIP_LIMIT, names: rows.slice(0, 8).map((t) => t.name) };
}

// 検索 (2026-10-04): 語ごとに 名前 か 説明 に含まれるタスク (AND)。既定は未完了のみ、all=1 で完了も含める。
// Notion のフィルタは部分一致 (contains) なので、スペース区切りの各語を and で重ねる。最大 100 件
async function searchTasks(env, q, all) {
  const words = q.split(/[\s　]+/).filter(Boolean).slice(0, 5);
  if (!words.length) return [];
  const per = words.map((w) => ({ or: [
    { property: "名前", title: { contains: w } },
    { property: "説明", rich_text: { contains: w } },
  ] }));
  const filter = { and: [...(all ? [] : [NOT_DONE]), ...per] };
  const r = await notion(env, `/data_sources/${env.TASKS_DATA_SOURCE_ID}/query`, {
    method: "POST",
    // 未完了は期日の近い順、完了済みは新しい順 (all=1 は 100 件で切れるので古い完了から埋まらないように期日降順で取り、未完了だけ並べ直す)
    body: JSON.stringify({ filter, page_size: 100, sorts: [{ property: "完了", direction: "ascending" }, { property: "期日", direction: all ? "descending" : "ascending" }] }),
  });
  const out = (r.results ?? []).map(pageToTask);
  if (all) out.sort((a, b) => (a.done === b.done ? (a.done ? 0 : (a.due ?? "9").localeCompare(b.due ?? "9")) : a.done ? 1 : -1));
  // 同じページが 2 回返ることがある (並びに同値が多いときの Notion のページング)。id で重複を落とす (2026-10-06, 象限で発覚)
  const uniq = dedupeTasks(out);
  if (uniq.some((t) => t.projectIds.length)) {
    const names = await projectNames(env).catch(() => new Map());
    for (const t of uniq) t.project = t.projectIds.map((id) => names.get(id)).filter(Boolean).join(" / ") || null;
  }
  return uniq;
}

// タスクの概要 (2026-09-30): 説明プロパティ (BLUF) とページ本文の先頭をテキストで返す。
// 本文は上位ブロック 40 個まで。メニューを開いたときだけ呼ぶので一覧は重くならない
const RT = (b) => (b?.rich_text ?? []).map((t) => t.plain_text).join("");
function blockText(b) {
  const t = b.type, v = b[t] ?? {};
  switch (t) {
    case "paragraph": return RT(v);
    case "heading_1": case "heading_2": case "heading_3": return "■ " + RT(v);
    case "bulleted_list_item": return "・" + RT(v);
    case "numbered_list_item": return "・" + RT(v);
    case "to_do": return (v.checked ? "☑ " : "☐ ") + RT(v);
    case "quote": return "> " + RT(v);
    case "callout": return (v.icon?.emoji ? v.icon.emoji + " " : "") + RT(v);
    case "toggle": return "▸ " + RT(v);
    case "code": return RT(v);
    case "divider": return "―";
    case "child_page": return "📄 " + (v.title ?? "");
    default: return "";
  }
}
async function taskDetail(env, id) {
  const [page, blocks] = await Promise.all([
    notion(env, `/pages/${id}`),
    notion(env, `/blocks/${id}/children?page_size=40`).catch(() => ({ results: [] })),
  ]);
  const t = pageToTask(page);
  const body = (blocks.results ?? []).map(blockText).filter((x) => x.trim()).join("\n");
  return { id, desc: t.rawDesc || "", body, more: !!blocks.has_more, kind: page.properties?.["種類"]?.select?.name ?? null, labels: (page.properties?.["ラベル"]?.multi_select ?? []).map((o) => o.name) };
}

async function patchTask(env, id, properties) {
  const page = await notion(env, `/pages/${id}`, { method: "PATCH", body: JSON.stringify({ properties }) });
  return pageToTask(page);
}

// 完了処理は必ずこの3点をまとめて立てる (Notion Tasks 操作規約 §4-1)。スキル側と同じ規約。
const doneProps = () => ({
  "完了": { checkbox: true },
  "完了日": { date: { start: todayJst() } },
  "ステータス": { status: { name: "完了" } },
});
const reopenProps = () => ({
  "完了": { checkbox: false },
  "完了日": { date: null },
  "ステータス": { status: { name: "未着手" } },
});

async function quickAdd(env, name, projectId) {
  const today = todayJst();
  const page = await notion(env, "/pages", {
    method: "POST",
    body: JSON.stringify({
      parent: { type: "data_source_id", data_source_id: env.TASKS_DATA_SOURCE_ID },
      icon: { type: "emoji", emoji: env.QUICK_ADD_ICON || "📥" },
      properties: {
        "名前": { title: [{ text: { content: name } }] },
        "エリア": { select: { name: env.QUICK_ADD_AREA || "Inbox" } },
        "ソース": { select: { name: "手動" } },
        "ステータス": { status: { name: "未着手" } },
        "開始日": { date: { start: today } }, // 原則きょう＝着手可 (2026-08-31)
        "実行環境": { multi_select: [{ name: "iPhone" }] }, // スマホから入れたものはスマホで片付く前提
        // PJ別タブの「この PJ にタスクを足す」「次のアクションを1件決める」(Phase B, 2026-10-06) から来たときは PJ に紐づける
        ...(projectId ? { "関連プロジェクト": { relation: [{ id: projectId }] } } : {}),
      },
    }),
  });
  if (projectId) projStatCache.at = 0;
  const t = pageToTask(page);
  if (projectId) { const names = await projectNames(env).catch(() => new Map()); t.project = names.get(projectId) ?? null; }
  return t;
}

// ---------- HTTP ----------

const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...extra },
  });

function getCookie(req, name) {
  const m = (req.headers.get("Cookie") ?? "").match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : null;
}

// 文字列の定数時間比較 (公開コードで比較順が読める前提, 2026-10-08)
function safeEq(a, b) {
  const x = new TextEncoder().encode(String(a)), y = new TextEncoder().encode(String(b));
  if (x.length !== y.length) return false;
  let d = 0; for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}
function authed(req, env) {
  if (!env.APP_TOKEN) return false;
  const bearer = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  return safeEq(bearer, env.APP_TOKEN) || safeEq(getCookie(req, COOKIE) ?? "", env.APP_TOKEN);
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === "/health") return json({ ok: true, ts: new Date().toISOString() });
    if (!env.NOTION_TOKEN || !env.APP_TOKEN) return json({ error: "secrets not configured" }, 503);

    // ?t=<APP_TOKEN> で来たら Cookie を焼いて / に戻す (PWA インストール前の初回だけ使う)
    const t = url.searchParams.get("t");
    if (t !== null) {
      if (!safeEq(t, env.APP_TOKEN)) return new Response("forbidden", { status: 403 });
      return new Response(null, {
        status: 302,
        headers: {
          Location: "/",
          "Set-Cookie": `${COOKIE}=${encodeURIComponent(t)}; Path=/; Max-Age=${COOKIE_MAX_AGE}; HttpOnly; Secure; SameSite=Lax`,
        },
      });
    }

    // 静的ファイル。manifest と sw は認証なしでも配る (インストール後に Cookie が切れても殻は動くように)
    if (path === "/manifest.webmanifest")
      return new Response(MANIFEST, { headers: { "Content-Type": "application/manifest+json" } });
    if (path === "/sw.js")
      return new Response(SW_JS, { headers: { "Content-Type": "text/javascript", "Cache-Control": "no-cache" } });
    if (path === "/icon-192.png" || path === "/icon-512.png") {
      const b64 = path.includes("192") ? ICON_192_B64 : ICON_512_B64;
      const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      return new Response(bin, { headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" } });
    }

    if (!authed(req, env)) {
      if (path.startsWith("/api/")) return json({ error: "unauthorized" }, 401);
      return new Response(
        "<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width'>" +
          "<p style='font-family:sans-serif;padding:24px'>このアプリはトークン付きの URL から開いてください (?t=…)。<br>配布されたリンクから開き直してください。</p>",
        { status: 401, headers: { "Content-Type": "text/html; charset=utf-8" } }
      );
    }

    if (path === "/" || path === "/index.html")
      return new Response(APP_HTML, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" } });

    try {
      if (path === "/api/tasks" && req.method === "GET") {
        const view = url.searchParams.get("view") ?? "today";
        const [tasks, wip, dl] = await Promise.all([listTasks(env, view), wipCount(env).catch(() => null), delegates(env)]);
        return json({ view, today: todayJst(), tasks, wip, delegates: dl });
      }
      if (path === "/api/search" && req.method === "GET") {
        const q = (url.searchParams.get("q") ?? "").trim().slice(0, 100);
        const all = url.searchParams.get("all") === "1";
        return json({ q, all, today: todayJst(), tasks: await searchTasks(env, q, all) });
      }
      if (path === "/api/tasks" && req.method === "POST") {
        const body = await req.json().catch(() => ({}));
        const name = String(body.name ?? "").trim();
        if (!name) return json({ error: "name required" }, 400);
        const projectId = /^[0-9a-f-]{32,36}$/.test(String(body.projectId ?? "")) ? body.projectId : null;
        return json({ task: await quickAdd(env, name, projectId) }, 201);
      }
      // 📁 PJ別の見出し (Phase B-7/8, 2026-10-06): 進行中 PJ の ゴール・完了条件・件数・クローズ候補
      if (path === "/api/projects" && req.method === "GET") return json({ today: todayJst(), projects: await projectsInfo(env) });
      const mpc = path.match(/^\/api\/projects\/([0-9a-f-]{32,36})\/close$/);
      if (mpc && req.method === "POST") {
        const b = await req.json().catch(() => ({}));
        return json(await closeProject(env, mpc[1], String(b.note ?? "").replace(/\s+/g, " ").trim().slice(0, 300)));
      }
      if (path === "/api/quadrant" && req.method === "GET") return json(await quadrant(env));
      if (path === "/api/habits/due" && req.method === "GET") return json({ today: todayJst(), habits: await habitsDue(env) });
      const mhl = path.match(/^\/api\/habits\/([0-9a-f-]{32,36})\/log$/);
      if (mhl && req.method === "POST") { const b = await req.json().catch(() => ({})); return json({ log: await habitLog(env, mhl[1], b.done !== false, String(b.note ?? "").trim()) }); }
      const mtg = path.match(/^\/api\/tasks\/([0-9a-f-]{32,36})\/graph$/);
      if (mtg && req.method === "GET") return json(await taskGraph(env, mtg[1]));
      // 🔗 PJ の依存 (Phase C-11): ガント／依存順タイムライン用
      const mpd = path.match(/^\/api\/projects\/([0-9a-f-]{32,36})\/deps$/);
      if (mpd && req.method === "GET") return json(await projectDeps(env, mpd[1]));
      // 🗂 見直し (Phase C-9): 問いの一覧と、答えの書き込み
      if (path === "/api/review" && req.method === "GET") return json(await reviewQuestions(env));
      const mrv = path.match(/^\/api\/review\/(decision|verify|task-carry|habit|deps|dates)\/([0-9a-f-]{32,36})$/);
      if (mrv && req.method === "POST") {
        const b = await req.json().catch(() => ({}));
        return json(await reviewAnswer(env, mrv[1], mrv[2], String(b.answer ?? ""), String(b.note ?? "")));
      }
      // 🧭 役割タブ (Phase B-6): 読むだけ。書くのは 今週の目標 (今週の石) だけ
      if (path === "/api/roles" && req.method === "GET") return json(await rolesInfo(env));
      const mrg = path.match(/^\/api\/roles\/([0-9a-f-]{32,36})\/goal$/);
      if (mrg && req.method === "POST") {
        const b = await req.json().catch(() => ({}));
        const taskId = /^[0-9a-f-]{32,36}$/.test(String(b.taskId ?? "")) ? b.taskId : null;
        return json({ role: await setRoleGoal(env, mrg[1], taskId) });
      }
      const mc = path.match(/^\/api\/tasks\/([0-9a-f-]{32,36})\/chain$/);
      if (mc && req.method === "GET") return json(await resolveChain(env, mc[1]));
      const md = path.match(/^\/api\/tasks\/([0-9a-f-]{32,36})\/detail$/);
      if (md && req.method === "GET") return json(await taskDetail(env, md[1]));
      // ⏭ 先行タスクを置き換える (2026-10-07, 依存の洗い出し A): body {ids:[...]} を 先行タスク にそのまま入れる (空で全部外す)。自分自身と循環は弾く
      const mpr = path.match(/^\/api\/tasks\/([0-9a-f-]{32,36})\/preds$/);
      if (mpr && req.method === "POST") {
        const b = await req.json().catch(() => ({}));
        const me = mpr[1].replace(/-/g, "");
        const ids = [...new Set((Array.isArray(b.ids) ? b.ids : []).map(String).filter((x) => /^[0-9a-f-]{32,36}$/.test(x)).map((x) => x.replace(/-/g, "")))].filter((x) => x !== me);
        for (const pid of ids) { // pid の先行を辿って自分に戻るなら循環
          const { chain, cycle } = await resolveChain(env, pid);
          if (cycle || chain.some((t) => t.id.replace(/-/g, "") === me)) return json({ error: "cycle", with: pid }, 400);
        }
        const task = await patchTask(env, mpr[1], { "先行タスク": { relation: ids.map((id) => ({ id })) } });
        projStatCache.at = 0;
        return json({ task });
      }

      // 取り消し (2026-10-02): Kairos が操作前の値を控えておき、↩ で渡してくる。渡された列だけ戻す
      const mr = path.match(/^\/api\/tasks\/([0-9a-f-]{32,36})\/restore$/);
      if (mr && req.method === "POST") {
        const b = await req.json().catch(() => ({}));
        const props = {};
        if (b.done === false) Object.assign(props, reopenProps());
        if ("due" in b) props["期日"] = { date: b.due ? { start: b.due } : null };
        if ("startRaw" in b) props["開始日"] = { date: b.startRaw ? { start: b.startRaw } : null };
        if ("status" in b && b.status) props["ステータス"] = { status: { name: b.status } };
        if ("owner" in b) props["担当"] = { select: b.owner ? { name: b.owner } : null };
        if ("desc" in b) props["説明"] = { rich_text: [{ text: { content: String(b.desc ?? "").slice(0, 1900) } }] };
        if ("aiSince" in b) props["AI処理開始"] = { date: b.aiSince ? { start: b.aiSince } : null };
        // PJ の付け替えの取り消し (2026-10-06)。控えと今が違うときだけ戻す (他の操作の取り消しで PJ を触らない)
        if (Array.isArray(b.projectIds)) {
          const cur = await getTask(env, mr[1]);
          const want = b.projectIds.map((x) => String(x).replace(/-/g, "")).sort().join(","), have = cur.projectIds.map((x) => x.replace(/-/g, "")).sort().join(",");
          if (want !== have) { props["関連プロジェクト"] = { relation: b.projectIds.map((id) => ({ id })) }; projStatCache.at = 0; }
        }
        if (Array.isArray(b.predIds)) { // 先行タスクの取り消し (2026-10-07)。控えと今が違うときだけ
          const cur = await getTask(env, mr[1]);
          const want = b.predIds.map((x) => String(x).replace(/-/g, "")).sort().join(","), have = cur.predIds.map((x) => x.replace(/-/g, "")).sort().join(",");
          if (want !== have) { props["先行タスク"] = { relation: b.predIds.map((id) => ({ id })) }; projStatCache.at = 0; }
        }
        if (!Object.keys(props).length) return json({ error: "nothing to restore" }, 400);
        return json({ task: await patchTask(env, mr[1], props) });
      }
      const m = path.match(/^\/api\/tasks\/([0-9a-f-]{32,36})\/(done|reopen|defer|wait|human|start|skip|dup|evening|daytime|ai|ai-clear|delegate|mit|mit-clear|due|project|doing|todo)$/);
      if (m && req.method === "POST") {
        const [, id, action] = m;
        // 🤖 を押した印。Claude を起動する直前に立て、Claude が終了時に空にする (§11)。ai-clear は人が手で外す用
        if (action === "ai") {
          const cur = await getTask(env, id);
          // resume=1 (2026-10-06): 「前回の Claude セッションを開く」。同じチャットの続きなので AIセッション は残し、種別も前回のまま。印だけ立て直す
          const resume = url.searchParams.get("resume") === "1";
          // AI処理種別 (2026-10-03)。resume でも mode= が来ていればそれに従う (2026-10-08: 前回のセッションで「更新」を頼むとき)
          const mq = url.searchParams.get("mode");
          const mode = mq === "update" ? "更新" : mq === "run" ? "実行" : (resume ? (cur.aiMode || "実行") : "実行");
          // AIセッション は前回の URL が残っていると新セッションと紛れるので空にしてから Claude に書かせる (resume のときは残す)
          const props = { "AI処理開始": { date: { start: new Date().toISOString() } }, "AI処理種別": { select: { name: mode } }, ...(resume ? {} : { "AIセッション": { url: null } }) };
          if (cur.status === "人対応") props["ステータス"] = { status: { name: "進行中" } }; // 人対応 を Claude に渡し直したら手番は Claude へ
          return json({ task: await patchTask(env, id, props) });
        }
        if (action === "ai-clear") return json({ task: await patchTask(env, id, { "AI処理開始": { date: null }, "AI処理種別": { select: null } }) });
        // 家族へ委任 (2026-10-01): 担当 を立てる。to= 空で自分に戻す。選択肢に無い名前は 400
        if (action === "delegate") {
          const to = (url.searchParams.get("to") ?? "").trim();
          const dl = await delegates(env);
          if (to && !dl.includes(to)) return json({ error: `to must be one of ${dl.join("/")} or empty` }, 400);
          return json({ task: await patchTask(env, id, { "担当": { select: to ? { name: to } : null } }) });
        }
        if (action === "done" || action === "skip" || action === "dup") {
          // 完了の前後で依存を見る: 先行が残っていれば pendingPreds (その場で聞く)、後続が着手可になれば unblocked (トースト)
          const before = await getTask(env, id);
          const pendingPreds = (await Promise.all(before.predIds.map((pid) => getTask(env, pid)))).filter((p) => !p.done);
          let props = doneProps();
          props["AI処理開始"] = { date: null }; props["AI処理種別"] = { select: null }; // 完了したら 🤖 処理中 の印は外す
          // 理由・メモ 1行 (2026-10-06): note= があれば 完了 でも説明欄の先頭に残す。見送り／重複は従来の根拠行の末尾に「: メモ」で続ける
          const memo = (url.searchParams.get("note") ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
          if (action === "skip" || action === "dup" || memo) {
            const desc = (before.rawDesc ?? "");
            const withName = (url.searchParams.get("with") ?? "").trim().slice(0, 120);
            const head = action === "skip" ? "見送り" : action === "dup" ? "重複のため完了" : "完了";
            const note = (action === "skip"
              ? `見送り (${todayJst()}, PWA)`
              : action === "dup" ? `重複のため完了 (${todayJst()}, PWA${withName ? `, 相手: ${withName}` : ""})` // 操作規約 §4-1 の「根拠1行」
              : `完了 (${todayJst()}, PWA)`) + (memo ? `: ${memo}` : "");
            props["説明"] = { rich_text: [{ text: { content: (!memo && desc.startsWith(head)) ? desc : (note + (desc ? "\n" + desc : "")).slice(0, 1900) } }] };
          }
          const task = await patchTask(env, id, props);
          const succs = await Promise.all(before.succIds.map((sid) => getTask(env, sid)));
          const unblocked = succs.filter((s) => !s.done && !s.blocked);
          return json({ task, pendingPreds, unblocked });
        }
        // 今夜に送る = 開始日を「今日 18:00 (JST)」の日時に。今日に戻す = 日付だけの今日に
        if (action === "evening") return json({ task: await patchTask(env, id, { "開始日": { date: { start: `${todayJst()}T18:00:00+09:00` } } }) });
        if (action === "daytime") return json({ task: await patchTask(env, id, { "開始日": { date: { start: todayJst() } } }) });
        if (action === "reopen") return json({ task: await patchTask(env, id, reopenProps()) });
        // 待ちに (GTD の Waiting For, 2026-10-06): who= があれば説明欄の先頭に「待ち (日付, PWA): 相手」を1行。既に 待ち 行があれば置き換える
        if (action === "wait") {
          const props = { "ステータス": { status: { name: "待ち" } } };
          const who = (url.searchParams.get("who") ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
          if (who) {
            const cur = await getTask(env, id);
            const rest = (cur.rawDesc ?? "").replace(/^待ち \([^)]*\): .*\n?/m, "");
            props["説明"] = { rich_text: [{ text: { content: (`待ち (${todayJst()}, PWA): ${who}` + (rest ? "\n" + rest : "")).slice(0, 1900) } }] };
          }
          return json({ task: await patchTask(env, id, props) });
        }
        // ⭐ 今日の3つ (MIT, 2026-10-06): 今日の日付を入れる／外す。4件目以降も入れられるが Kairos 側で件数を警告する
        if (action === "mit") { // 開始日が未来なら今日に戻す (今日やると決めたのだから, 2026-10-07)
          const cur = await getTask(env, id);
          const props = { "今日の3つ": { date: { start: todayJst() } } };
          if (cur.start && cur.start > todayJst()) props["開始日"] = { date: { start: todayJst() } };
          return json({ task: await patchTask(env, id, props) });
        }
        if (action === "mit-clear") return json({ task: await patchTask(env, id, { "今日の3つ": { date: null } }) });
        // PJ を付け替える (B-7 の残り, 2026-10-06): to= に PJ の id、空なら PJ から外す。1 件だけ持つ (複数 PJ は Claude で)
        if (action === "project") {
          const to = (url.searchParams.get("to") ?? "").trim();
          if (to && !/^[0-9a-f-]{32,36}$/.test(to)) return json({ error: "to must be a page id or empty" }, 400);
          const task = await patchTask(env, id, { "関連プロジェクト": { relation: to ? [{ id: to }] : [] } });
          projStatCache.at = 0;
          if (to) { const names = await projectNames(env).catch(() => new Map()); task.project = names.get(to) ?? null; }
          return json({ task });
        }
        // 期日を置き直す (Phase C-11, 2026-10-06): 依存の矛盾 (後続の期日 < 先行の期日) を「先行に揃える」で直すため。開始日が新しい期日より後なら同じ日に戻す
        if (action === "due") {
          const d = url.searchParams.get("date") ?? "";
          if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return json({ error: "date=YYYY-MM-DD required" }, 400);
          const cur = await getTask(env, id);
          const props = { "期日": { date: { start: d } } };
          if (cur.start && cur.start > d) props["開始日"] = { date: { start: d } };
          return json({ task: await patchTask(env, id, props), startMoved: !!props["開始日"] });
        }
        // 人対応 (2026-10-03, §11-6): Claude が「人の手が要る」で止めたときの印。手で付けるときは 🤖 の印も外す
        if (action === "human") return json({ task: await patchTask(env, id, { "ステータス": { status: { name: "人対応" } }, "AI処理開始": { date: null }, "AI処理種別": { select: null } }) });
        // 状態の切替 (2026-10-07, 利用者「人対応に変更するボタンがあってもいいかも」): シートの 🚦 状態 から 未着手／進行中 にも戻せる。進行中 は WIP に数える
        if (action === "doing") return json({ task: await patchTask(env, id, { "ステータス": { status: { name: "進行中" } } }) });
        if (action === "todo") return json({ task: await patchTask(env, id, { "ステータス": { status: { name: "未着手" } } }) });
        // 「明日へ」「週末に」「来週に」「開始日を選ぶ」はどれも **開始日** を動かす操作 (2026-09-27 決定)。
        // 期日 (2026-10-07 夜, 利用者と決定): 条件付きで一緒に動かす。
        //   (a) 期日が新しい開始日より前 (そのままだと期限切れで始まる) → 期日も同じ日に
        //   (b) 期日 ＝ 元の開始日 (「その日にやる」1 日タスク) → 期日も同じ日に
        //   それ以外 (先の締切) は触らない。常に揃えると来月締切のタスクを週末に送ったとき締切が土曜に縮む
        if (action === "start" || action === "defer") {
          let d;
          if (action === "start") {
            d = url.searchParams.get("date") ?? "";
            if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return json({ error: "date=YYYY-MM-DD required" }, 400);
          } else {
            const to = url.searchParams.get("to");
            if (to === "weekend" || to === "nextweek") d = deferTo(to);
            else {
              const days = Math.min(30, Math.max(1, parseInt(url.searchParams.get("days") ?? "1", 10) || 1));
              d = deferDate(days);
            }
          }
          const cur = await getTask(env, id);
          const props = { "開始日": { date: { start: d } } };
          if (cur.due && (cur.due < d || (cur.start && cur.due === cur.start))) props["期日"] = { date: { start: d } };
          return json({ task: await patchTask(env, id, props), dueMoved: !!props["期日"] });
        }
      }
      return json({ error: "not found" }, 404);
    } catch (e) {
      return json({ error: String(e?.message ?? e) }, 502);
    }
  },
};
