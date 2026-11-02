// 🛒 買い物画面 (2026-11-02)。正本の仕様は Kairos タスク「①Kairos に買い物画面を作る」の本文。
//   - 載せる範囲: 種類=購入 の未完了タスク全部 (+ ラベル「買ったつもり」の未完了は種類を問わず。AMS lite のように 種類=判断 で持っているものがあるため)
//   - 区分: 「買ったつもり」(ラベル付き) と「その他の購入」。並びはセール窓の開始日順、窓なしは末尾
//   - 必要度 C は起票から 30 日未満なら「冷却中 (残り n 日)」
//   - グラフ: セール窓ごとの予定額 / 引落し月ごとの予定額 (購入月の翌月27日) と裁量枠 / 買ったつもり貯金 (見送りで完了した同ラベルの金額)
// 規約ロジックは Worker 側 (ここ) に置き、画面は表示だけ (CONTRIBUTING.md)。D1 の初期化 (列・選択肢・セール窓マスター) は d1.js の ensureShopping。

import { SHOP_CONST } from "./d1.js";
/** セール窓マスター (追加コレクション sale_windows) のデータソース ID・買ったつもりのラベル・必要度の選択肢。正本は d1.js (列・選択肢を足す移行と同じ値) */
export const { SALE_WINDOWS_DS, TEMP_BUY_LABEL, NEED_OPTIONS } = SHOP_CONST;
/** 裁量日割りパラメータ (現在値) の正本ページ。本文の YAML の discretionary_pool を読む */
export const CF_PARAM_PAGE_ID = "3ea0cdbff88a815b9169ec7d2763f017";
export const COOLING_DAYS = 30;
export const DEBIT_DAY = 27; // 楽天プレミアム: 月末締め・翌月27日引落し

const rt = (a) => (a ?? []).map((x) => x.plain_text ?? x.text?.content ?? "").join("");
const ymd = (s) => (s ? String(s).slice(0, 10) : null);
const jstDate = (iso) => (iso ? new Date(Date.parse(iso) + 9 * 3600_000).toISOString().slice(0, 10) : null);

/** YYYY-MM に n か月足す */
export function addMonths(ym, n) {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}
function daysBetween(a, b) { return Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86_400_000); }

/**
 * 裁量日割りパラメータ本文 (YAML を含むテキスト) から 月→discretionary_pool を拾う。
 * 行頭 (字下げなし) の「YYYY-MM:」が月の見出し、その下の字下げされた「discretionary_pool: N」が値。月ごとに最初の 1 つだけ採る
 */
export function parsePools(text) {
  const out = {};
  let month = null;
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const h = line.match(/^(\d{4}-\d{2}):\s*(#.*)?$/);
    if (h) { month = h[1]; continue; }
    if (/^\S/.test(line)) { month = null; continue; } // 字下げの無い別の行で月の塊は終わる
    const v = month && line.match(/^\s+discretionary_pool:\s*([\d,]+)/);
    if (v && !(month in out)) out[month] = Number(v[1].replace(/,/g, ""));
  }
  return out;
}
/** その月の裁量枠。無ければ直近の過去の月の値 (パラメータ正本の「前月値暫定採用」と同じ扱い) */
export function poolFor(pools, month) {
  if (month in pools) return { amount: pools[month], month, provisional: false };
  const past = Object.keys(pools).filter((m) => m < month).sort().pop();
  return past ? { amount: pools[past], month: past, provisional: true } : null;
}

/** タスクのページから買い物画面が使う値を取り出す (pageToTask の上に足す分) */
export function shopFields(page) {
  const p = page.properties ?? {};
  const desc = rt(p["説明"]?.rich_text);
  return {
    amount: typeof p["金額"]?.number === "number" ? p["金額"].number : null,
    need: p["必要度"]?.select?.name ?? null,
    windowIds: (p["セール窓"]?.relation ?? []).map((r) => String(r.id).replace(/-/g, "").toLowerCase()),
    created: jstDate(page.created_time),
    doneAt: ymd(p["完了日"]?.date?.start) ?? (p["完了"]?.checkbox ? jstDate(page.last_edited_time) : null),
    skipped: /^見送り/m.test(desc), // skip (PWA・MCP) が説明欄の先頭に置く理由行
  };
}

/** セール窓マスターの行 → 画面用 */
export function windowFromPage(page) {
  const p = page.properties ?? {};
  return {
    id: String(page.id).replace(/-/g, "").toLowerCase(),
    name: rt(p["名前"]?.title) || "(無題の窓)",
    shop: p["店"]?.select?.name ?? null,
    start: ymd(p["開始日"]?.date?.start),
    end: ymd(p["終了日"]?.date?.start) ?? ymd(p["開始日"]?.date?.end),
    certainty: p["確度"]?.select?.name ?? null, // 確定 / 予想
  };
}

const isShopItem = (t) => !t.done && (t.kind === "購入" || (t.labels ?? []).includes(TEMP_BUY_LABEL));

/**
 * 買い物画面の中身。tasks は pageToTask + shopFields を合わせたもの (完了済みも含めて渡す。貯金の集計に使う)
 * @returns {{items, windows, debit, savings, totals}}
 */
export function shoppingModel({ tasks, windows, pools, today }) {
  const win = new Map(windows.map((w) => [w.id, w]));
  const thisMonth = today.slice(0, 7);
  const items = tasks.filter(isShopItem).map((t) => {
    const w = (t.windowIds ?? []).map((id) => win.get(id)).find(Boolean) ?? null;
    let cooling = null;
    if (t.need && t.need.startsWith("C") && t.created) {
      const left = COOLING_DAYS - daysBetween(t.created, today);
      if (left > 0) cooling = left;
    }
    // 買う日の見込み: セール窓の開始日 → 開始日 (先なら) → 今日。過去の窓・開始日は今日に寄せる
    const planned = [w?.start, t.start].find((d) => d && d >= today) ?? today;
    const buyMonth = planned.slice(0, 7);
    return {
      ...t,
      tempBuy: (t.labels ?? []).includes(TEMP_BUY_LABEL),
      window: w,
      cooling,
      planned,
      debitMonth: addMonths(buyMonth, 1),
    };
  });
  const key = (x) => [x.window?.start ?? "9999-99-99", x.start ?? "9999-99-99", x.name].join("\u0001");
  items.sort((a, b) => key(a).localeCompare(key(b), "ja"));

  // セール窓ごとの予定額。終わった窓は品目が残っているときだけ出す
  const windowRows = windows
    .map((w) => {
      const its = items.filter((x) => x.window?.id === w.id);
      return { ...w, total: its.reduce((s, x) => s + (x.amount ?? 0), 0), count: its.length, unpriced: its.filter((x) => x.amount == null).length };
    })
    .filter((w) => w.count || !w.end || w.end >= today)
    .sort((a, b) => String(a.start ?? "9").localeCompare(String(b.start ?? "9")));
  const noWin = items.filter((x) => !x.window);
  if (noWin.length) windowRows.push({ id: null, name: "窓なし", shop: null, start: null, end: null, certainty: null, total: noWin.reduce((s, x) => s + (x.amount ?? 0), 0), count: noWin.length, unpriced: noWin.filter((x) => x.amount == null).length });

  // 引落し月ごと: 購入月の翌月27日。線は購入月の裁量枠 (discretionary_pool)、残りは 枠 − 予定額
  const byDebit = new Map();
  for (const x of items) {
    const d = byDebit.get(x.debitMonth) ?? { month: x.debitMonth, total: 0, count: 0, unpriced: 0 };
    d.total += x.amount ?? 0; d.count++; if (x.amount == null) d.unpriced++;
    byDebit.set(x.debitMonth, d);
  }
  const first = addMonths(thisMonth, 1), last = [...byDebit.keys()].sort().pop() ?? first;
  const debit = [];
  for (let m = first, i = 0; m <= (last > first ? last : first) && i < 24; m = addMonths(m, 1), i++) {
    const d = byDebit.get(m) ?? { month: m, total: 0, count: 0, unpriced: 0 };
    const pool = poolFor(pools, addMonths(m, -1));
    debit.push({ ...d, date: `${m}-${DEBIT_DAY}`, buyMonth: addMonths(m, -1), pool: pool?.amount ?? null, poolProvisional: pool?.provisional ?? null, left: pool ? pool.amount - d.total : null });
  }

  // 買ったつもり貯金: 見送りで完了した「買ったつもり」の金額を、完了日の月で合計し累計を出す
  const saved = tasks.filter((t) => t.done && t.skipped && (t.labels ?? []).includes(TEMP_BUY_LABEL) && t.doneAt);
  const byMonth = new Map();
  for (const t of saved) {
    const m = t.doneAt.slice(0, 7), r = byMonth.get(m) ?? { month: m, amount: 0, count: 0, unpriced: 0 };
    r.amount += t.amount ?? 0; r.count++; if (t.amount == null) r.unpriced++;
    byMonth.set(m, r);
  }
  const months = [...byMonth.keys()].sort();
  const savings = [];
  if (months.length) {
    let cum = 0;
    for (let m = months[0]; m <= thisMonth || m <= months[months.length - 1]; m = addMonths(m, 1)) {
      const r = byMonth.get(m) ?? { month: m, amount: 0, count: 0, unpriced: 0 };
      cum += r.amount; savings.push({ ...r, cum });
    }
  }

  const sum = (arr) => arr.reduce((s, x) => s + (x.amount ?? 0), 0);
  const temp = items.filter((x) => x.tempBuy), other = items.filter((x) => !x.tempBuy);
  return {
    items,
    windows: windowRows,
    debit,
    savings,
    totals: {
      count: items.length, amount: sum(items), unpriced: items.filter((x) => x.amount == null).length,
      tempCount: temp.length, tempAmount: sum(temp), otherCount: other.length, otherAmount: sum(other),
      savedAmount: savings.length ? savings[savings.length - 1].cum : 0, savedCount: saved.length,
    },
    needOptions: NEED_OPTIONS,
  };
}
