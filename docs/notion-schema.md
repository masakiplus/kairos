# Notion スキーマ定義（Kairos が読む・書くプロパティ）

Kairos は Notion の 6 つのデータベース（データソース）を読み書きする。ここに無いプロパティは Kairos からは触らない。
プロパティ名は **日本語の名前で一致させる**（コード側は名前で引いている）。別名にしたいときは `src/index.js` の該当文字列を直す。

| 変数名（wrangler の vars） | DB | 役割 |
|---|---|---|
| `TASKS_DATA_SOURCE_ID` | ✅ Tasks | タスク本体。Kairos の主戦場 |
| `PROJECTS_DATA_SOURCE_ID` | 📁 Projects | PJ 別タブの見出し・つながり・クローズ |
| `ROLES_DATA_SOURCE_ID` | 🧭 Roles | 役割タブ・今週の石 |
| `DECISIONS_DATA_SOURCE_ID` | 🧠 Decisions | 見直しタブ（未決・検証・依存案・日程案）・PJ クローズの決着行 |
| `HABITS_DATA_SOURCE_ID` | 🔁 Habits | 見直しタブの習慣申告 |
| `HABIT_LOG_DATA_SOURCE_ID` | 📒 Habit Log | 習慣申告の記録先 |

データソース ID は Notion API の `GET /v1/databases/{id}` の `data_sources[].id`（2025-09 以降の API）。URL の 32 桁 ID はデータベース ID で、別物。

> 時刻はすべて **JST** 前提。式列の `dateAdd(now(), 9, "hours")` は Notion の `now()` が UTC で評価されることへの補正。他のタイムゾーンなら 9 を変える。

---

## ✅ Tasks

### 必須（これが無いと一覧が出ない）

| プロパティ | 型 | 用途 |
|---|---|---|
| 名前 | title | |
| 完了 | checkbox | 完了の正本。完了 ＝ `完了`✓ ＋ `完了日`＝今日 ＋ `ステータス`＝完了 の 3 点セット |
| 完了日 | date | |
| ステータス | status | 選択肢: `未着手` / `進行中` / `待ち` / `人対応` / `完了`。進行中＋人対応 が WIP に数えられる |
| 期日 | date | 締切 |
| 開始日 | date | 「それより前に着手しても意味が無い日」。延期操作はこれを動かす。時刻付き（当日 17:00 以降）なら「🌙 今夜」 |
| 着手可否 | formula | 下記 |
| 期限区分 | formula | 下記 |
| 前倒し候補 | formula | 下記 |
| 先行タスク | relation（自己参照、双方向） | 依存。相手側のプロパティ名は `後続タスク` |
| 後続タスク | relation（自己参照） | 先行タスク の裏側 |
| 先行未完了数 | rollup | 先行タスク → 完了 を `unchecked` で数える。>0 なら「先行待ち」 |

式（そのまま貼れる）:

```
着手可否:
if(prop("先行未完了数") > 0, "先行待ち",
  if(empty(prop("開始日")), "着手可",
    if(toNumber(formatDate(prop("開始日"),"YYYYMMDD")) <= toNumber(formatDate(dateAdd(now(),9,"hours"),"YYYYMMDD")), "着手可", "待機")))

期限区分:
if(empty(prop("期日")), "⑤日付なし",
  if(toNumber(formatDate(prop("期日"),"YYYYMMDD")) < toNumber(formatDate(dateAdd(now(),9,"hours"),"YYYYMMDD")), "①期限切れ",
    if(toNumber(formatDate(prop("期日"),"YYYYMMDD")) == toNumber(formatDate(dateAdd(now(),9,"hours"),"YYYYMMDD")), "②今日",
      if(toNumber(formatDate(prop("期日"),"YYYYMMDD")) <= toNumber(formatDate(dateAdd(dateAdd(now(),9,"hours"),7,"days"),"YYYYMMDD")), "③今週", "④先"))))

前倒し候補:
if(prop("着手可否") != "着手可", "",
  if(and(not(empty(prop("親アイテム"))), prop("種類") == "購入"), "",
    if(empty(prop("期日")), "候補",
      let(base, parseDate(formatDate(dateAdd(now(), 9, "hours"), "YYYY-MM-DD")),
        let(d, dateBetween(prop("期日"), base, "days"), if(and(d >= 1, d <= 7), "候補", ""))))))
```

Kairos は式の結果を **文字列一致** で引いたうえで、素の 期日・開始日 からも同じ判定をかけ直す（式の再計算遅れと UTC ズレの保険）。式は消さないこと。

### Kairos が使う任意プロパティ

| プロパティ | 型 | 用途 | 選択肢の例 |
|---|---|---|---|
| 優先度 | select | 行のチップ・象限の「重要」 | `p1` `p2` `p3` `p4` |
| 説明 | rich_text | シートの概要。完了理由・待ちの相手・棚卸しの印はここの先頭行に残る | |
| エリア | select | クイック追加の既定（`QUICK_ADD_AREA`） | `Inbox` ほか任意 |
| 実行環境 | multi_select | 「スマホで」タブの条件（`iPhone` か `電話` を含む） | `iPhone` `Mac` `電話` `外出` `紙・郵送` `自宅` |
| 種類 | select | シートの表示・前倒し候補の式 | `判断` `手続き` `支払い` `連絡` `購入` `確認` `調査` `作業` |
| ラベル | multi_select | 棚卸し系の印（`SchedReview` など）。表示のみ | |
| ソース | select | クイック追加が `手動` を入れる | `手動` ほか |
| 担当 | select | 家族への委任。**選択肢をそのまま委任先ボタンにする**（Kairos がスキーマから読む） | 家族の名前 |
| 関連プロジェクト | relation → Projects | PJ 別タブ・先行ピッカーの範囲 | |
| 親アイテム / サブアイテム | relation（自己参照） | 前倒し候補の式で参照。Kairos 本体は読まない | |
| 今日の3つ | date | ⭐ MIT。当日の日付が入っていれば ⭐。翌日は自然に外れる | |
| AI処理開始 | date | 🤖 Claude に投げた時刻。2 時間以内なら「処理中」 | |
| AI処理種別 | select | `実行` / `更新` | |
| AIセッション | url | 受けた Claude が書く自分のチャット URL | |
| 🤖 Claudeへ | formula | タスク名＋ページ URL 入りの `claude.ai/new?q=…`。Kairos は同じ文面を自前で組むので無くても動く | |

## 📁 Projects

| プロパティ | 型 | 用途 |
|---|---|---|
| 名前 | title | |
| ステータス | status | `未着手` / `進行中` / `保留` / `完了` / `アーカイブ`。**Kairos が書くのはこれだけ**（クローズで `完了`） |
| 対応ゴール | rich_text | 見出しの「ゴール」。未記入は警告 |
| 完了条件 | rich_text | クローズ候補カードに表示 |
| 役割 | relation → Roles | 見出しの役割名・役割→PJ ツリー |
| タスク | relation → Tasks | 関連プロジェクト の裏側 |
| テーマ | select | 表示のみ |

## 🧭 Roles

| プロパティ | 型 | 用途 |
|---|---|---|
| 名前 | title | |
| ミッション | rich_text | 役割カード（2 行まで） |
| Q2テーマ | rich_text | 役割カード |
| 今年のゴール | rich_text | 役割カード |
| 今週の目標 | rich_text | **今週の石**。書式 `〜M/D：<タスク名> → Tasks <page_id>。（補足）`。Kairos が Roles に書く唯一の列 |
| プロジェクト | relation → Projects | 役割 の裏側。PJ 数・ツリー |

## 🧠 Decisions

| プロパティ | 型 | 用途 |
|---|---|---|
| 名前 | title | 問いの題 |
| 状態 | select | `提案中` / `提示済み` / `決着` |
| 種別 | select | `手動` のほか、夜間棚卸しが使う `依存案` / `日程案` など |
| 決定 | select | `着手する` / `棚上げ` / `削除` / `未決` / `決定済み` |
| 問い | rich_text | カードの本文 |
| 結論 | rich_text | 決着の 1 行。依存案／日程案では機械行 `[deps pred=<id> succ=<id> sstart=… sdue=…]` / `[dates task=<id> start=… due=…]` をここに置く |
| 出所 / 期待する結果 / 学び | rich_text | 表示・検証の記録 |
| AI推奨 | select | `着手する` / `棚上げ` / `削除` / `その他`。カードの既定ボタン |
| 検証結果 | select | `当たり` / `外れ` / `部分的` / `検証不要` |
| 日付 / 決定日 / 検証日 / 提示日 / 開始日 | date | 開始日が未来の未決はまだ出さない。検証日≦今日で検証結果が空なら「検証待ち」 |
| 関連タスク | relation → Tasks | |
| 関連プロジェクト | relation → Projects | |
| 役割 | relation → Roles | |

## 🔁 Habits / 📒 Habit Log

Habits: 名前(title)・計測方法(select: `自動`/`半自動`/`手動`)・状態(select: `提案中`/`有効`/`定着済み`/`停止`)・頻度(select: `毎日`/`週1`/`週2`/`週3`/`毎週日曜`)・判定ルール(rich_text)・役割(relation → Roles)・記録(relation → Habit Log)。

Habit Log: 名前(title, `YYYY-MM-DD 習慣名`)・日付(date)・習慣(relation → Habits)・達成(checkbox)・取得元(select: `manual` ほか)・メモ(rich_text)。Kairos は 計測方法 が 手動／半自動 で今日の記録が無い習慣を見直しタブに出し、`取得元=manual` で 1 行書く。

---

## 最小構成で動かすなら

Tasks の「必須」だけ揃えれば 今日やる／今日できる／スマホで／検索／追加／完了／延期／取り消し は動く。PJ 別・役割・見直し・つながり は対応する DB の ID を vars に入れたときだけ有効（無ければそのタブは「取得できませんでした」になる）。
