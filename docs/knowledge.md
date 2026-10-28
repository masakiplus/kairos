# 知識文書（PRJ・archive・ref）の正本を Kairos へ寄せ切る

2026-10-29 設計案。決めた経緯は Kairos のタスク「知識文書（PRJ・ref・archive）を Notion から Kairos（D1）へ移す設計案と移行スクリプト、Kairos→Drive の控えをクラウドで作る」の本文にある。

- 2026-10-21 Notion への書き込みをやめ、Kairos に一本化する。知識文書の正本も Kairos へ移す
- 2026-10-24 控えは Kairos → Google Drive の向きにする（saito-tools `kairos_backup`）
- 留意: **移行（apply）は本人がこの設計を確認してから実行する。Notion は消さず、読み取り専用で残す**

## 1. 洗い出し

### 文書の種別と置き場

ボルトの `PRJ/`・`archive/`・`ref/` のファイルが「文書」の単位。saito-tools の `knowledge_ownership.py` が種別を決めている（A=人と Claude が書く文書、B=機械が積む記録、C=添付、除外=認証情報）。Notion へ移っていた（FLIPPED）のは A だけで、B・C・除外はボルトのまま。この設計も A だけを扱う。

| ボルトのパス | 2026-10-18 以降の置き場（D1） | 件数（D1 の `移行元` から） |
|---|---|---|
| `PRJ/<名前>/README.md` | `projects` の行の本文 | 約40行（入れ子の行 `PRJ/負債キャッシュフロー改善/ルーブル錦糸町売却` を含む） |
| `archive/<名前>/README.md` | `projects` の行の本文（ステータス=完了・アーカイブ） | 約90行 |
| `PRJ/<名前>/<子>.md`・`archive/…/<子>.md` | その行の子ページ（`child_page` の題名が `<子>.md`）。D1 では collection `pages` | 照合（`audit`）で数える |
| `ref/<…>.md` | `reference` の行の本文（`移行元` = パス） | 500行超 |

**10/18 の移行で、知識文書は既に D1 に入っている。** 新しい表は作らない。足りなかったのは「パスで引く入口」「Kairos で書いた印」「取り込み後に Notion で動いた分の照合」の3つ。

### 誰が書くか（saito-tools の `notion_sync/notion_knowledge.py` 経由）

| 書き手 | 操作 | 対象 |
|---|---|---|
| 人・Claude セッション | `read` / `section` / 全文差し替え | PRJ・ref の README と子文書 |
| ai-drive（Action A・D、第2.5段判定） | `upsert_section`・`body_edited`・`human_edited` | PRJ の README の節 |
| card-debit-analysis | `append_to_section`・`create_page` | `PRJ/負債キャッシュフロー改善/…` |
| livable-thread-watch | `create_page`・節の更新 | `…/ルーブル錦糸町売却/` |
| sapix-text-grading | `create_page`（ref 行を起こす） | `ref/sapix/…` |
| `mirror_knowledge.py`（launchd） | 読むだけ（Notion → ボルトの写し） | FLIPPED の A 全部 |

`notion_knowledge.py` は Notion API の形で呼ぶが、Mac では `kairos_shim`／`kairos_route` が Kairos が持つ ID を Kairos へ回し、10/24 からは実 Notion への書き込みを 403 で断っている。つまり**書き込みは既に Kairos に届いている**。ただし次の穴があった。

1. Kairos で足したブロックに時刻が無い → `body_edited()`（ai-drive のナッジ判定）と `mirror_knowledge.py`（ブロック時刻の最大で「動いたか」を見る）が Kairos での編集を見落とす。ボルトの写しが Kairos に追いつかない
2. 子ページを作れない（`POST /pages` の `parent.page_id` が未対応）→ `create_page` が 403／エラー
3. 入れ子のブロックの編集・削除でページの時刻が進まない → 控え（`kairos_backup`）は 900 件巡回で補っている
4. 10/18 の取り込み後に Notion 側で書かれた分（人の Notion アプリでの編集、shim を通らない経路、10/24 までの書き込み）が D1 に入っているか分からない

## 2. 設計

### 置き場とパス（変えない）

上の表のまま。パス → 行の規則は `notion_knowledge.locate()` と同じで、**深く当たった行が勝つ**（`ルーブル錦糸町売却` のように入れ子で独立した行がある）。Kairos 側の実装は `src/knowledge.js` の `resolvePath()`。

### D1 に足したもの

| もの | 中身 |
|---|---|
| `entity_body_edits(id, edited)` | 本文を Kairos で最後に書いた時刻。id は本文の持ち主（入れ子のブロックなら最寄りのページ）。本文を書く全経路（追記・ブロック更新・ブロック削除・子ページ作成）が同じ batch で付ける。切り替え後は `/api/storage/init` が使えないので、無ければ isolate の初回に作る |
| ブロックの `created_time`・`last_edited_time` | Kairos で足したブロックにも入れる（穴1） |
| ブロック更新の `last_edited_by` | Kairos でブロックを更新したら消す。取り込み時の Notion の人に、その後の編集を付けない（`human_edited` の判定のため） |
| `POST /api/data/pages` の `parent.page_id` | 親の本文の末尾に `child_page` ブロックを置き、子ページを collection `pages` の行として作る（穴2） |

### API（`/api/knowledge/*`、Cookie か `Authorization: Bearer APP_TOKEN`）

| 呼び出し | 返すもの |
|---|---|
| `GET /api/knowledge/index` | 全文書。`path`・`id`・`kind`（readme / sub / reference）・`captured`（取り込み時の Notion の時刻）・`kairosEdited`・`bodyEdited`（上の段のブロックの最大時刻と `kairosEdited` の遅い方。ボルトの写しが「動いたか」を見るのに使う）・`pageEdited`・`topBlocks`・`complete` |
| `GET /api/knowledge/resolve?path=PRJ/x/README.md` | 1文書。子ページがまだ無ければ `id:null` と親 `parent` |
| `GET /api/knowledge/inspect?id=` | 本文の木を見た判定。`touched`（取り込み後に Kairos で書いた）・`ambiguous`（証拠は無いがページの時刻が取り込みより後） |

本文の読み書きは今までどおり `/api/data/blocks/:id/children` と `/api/data/blocks/:id`。MCP には今回は足していない（足すなら `kairos_knowledge_read(path)` を想定）。

### 早送り（Notion → Kairos、知識文書だけ）

切り替え後は「Notion の古い写しで D1 を上書きしない」ため、取り込み API は閉じている（`docs/d1-cutover.md`）。知識文書だけ、次の門を通ったものに限って開ける。

1. `POST /api/storage/knowledge-begin?id=&session=` — 知識文書でなければ 409。`touched` なら 409（**Kairos で書いた文書は上書きしない**）。`ambiguous` は `accept=1` が無ければ 409（属性だけの編集なら取り直してよいが、入れ子ブロックの削除だと区別できないので、人が中身を見て決める）。通れば本文と入れ子を消して「未取得」にし、`kref:<id>` の印を付ける。**子ページ（別の文書）の本文には降りない**
2. 印の付いた文書の中に限り `capture-body`・`capture-asset`、まだ Kairos に無いページに限り `capture-page`（新しい子ページ・新しい ref 行）を通す。既にあるページの属性は上書きしない
3. `POST /api/storage/knowledge-end?id=&session=&notion_edited=` — 本文が揃っていなければ 409。揃えば取り込み時刻を Notion の時刻にし、Kairos 編集の印と、この回の印を外す。以後また閉じる

新しい ref 行は `knowledge-begin?new=1` で予約してから `capture-page`。取ってきたページが Reference の行でなければ入れたものを戻す。PRJ・archive の行が Notion にだけある場合（`projects` は中核コレクション）は自動で足さず、照合の報告に載せる。

Worker が Notion を読むのは `NOTION_TOKEN`（wrangler secret）で、読み取り（GET）だけ。

### 移行スクリプト `scripts/knowledge-migrate.mjs`

`APP_TOKEN` と `NOTION_TOKEN`（読み取りに使うだけ）を `.dev.vars` に置き、Mac で動かす。出力先は Git 対象外の非公開ディレクトリ。

```sh
node --env-file=.dev.vars scripts/knowledge-migrate.mjs <out> audit [--only=PRJ|archive|ref]
npx wrangler d1 export kairos --remote --output <out>/before-apply.sql   # apply の前に必ず
node --env-file=.dev.vars scripts/knowledge-migrate.mjs <out> apply --confirm [--accept=<id>,…] [--limit=N]
```

- Notion へは GET と data_sources の query だけ。書き込みの要求は送る前に例外にする（テストで確認）
- 照合の区分: `same`・`fast-forward`（Notion で動き Kairos では書いていない）・`review`（ページの時刻だけ動いた）・`conflict`（両方で書いた）・`new-sub`・`new-ref`・`new-project`・`kairos-only`。結果は `<out>/audit.md`・`audit.json`
- apply で取り直すのは `fast-forward`、人が `--accept` に並べた `review`／`conflict`、`new-sub` の親（親が未編集のとき）、`new-ref`。取り直す前に Kairos 側の本文を `<out>/before/<id>.json` に控える
- `conflict` は自動では触らない。`before/` と Notion を突き合わせ、Kairos 側を手で直すか、Notion 側を採るなら `--accept`
- D1 の書き込み無料枠（日次）があるので、多いときは `--limit` で日を分ける

### 書き手の付け替えと名前（saito-tools、2026-10-29）

Notion を使わなくなるので、**名前を中立にした**（2026-10-29 本人の指摘）。

| 旧 | 新 | 中身 |
|---|---|---|
| `notion_sync/notion_knowledge.py` | `knowledge/knowledge_store.py` | 同じ関数（`locate`・`read`・`read_section`・`replace_body`・`upsert_section`・`append_to_section`・`create_page`・`body_edited`・`human_edited`）を `/api/knowledge/resolve` と `/api/data/*` で直接実装。書いたブロックに `last_edited_by = saito-tools` を付け、`human_edited` はそれと Notion 時代のインテグレーションの id を人の編集から外す |
| `notion_sync/mirror_knowledge.py`・`.sh` | `knowledge/knowledge_mirror.py`・`.sh` | Kairos → ボルトの写し。対象と時刻は `/api/knowledge/index` の `bodyEdited` を1回で取る。門（作成途中・空・入口だけ・衝突退避・認証情報）は同じ。launchd `com.masaki.mirrorknowledge` と scheduler_watchdog の鮮度検査はこちらを見る |
| `knowledge_ownership.notion_owns` | `kairos_owns` | 判定は同じ。旧名は別名で残す（ファイルは `notion_sync/` のまま） |
| 旧モジュール | 退役の印を付けて残す | 旧い検査と、まだ付け替えていない保守用スクリプト（`ensure_pages`・`check_knowledge_drift`・`fill_ownership_prop`・`flip_banner`）のため。`notion_sync/mirror_knowledge.sh` は新しい方への転送 |

据え置いたもの: ボルトの写しの frontmatter の鍵（`mirror: notion`・`notion_edited`）。ai-drive の手順書と apple-notes の写しが「`mirror: notion` があれば機械の写し」と読むので、鍵の名前はそちらと一緒に替える。URL は `kairos_url` に替えた。Projects・Reference の `正本` 列（選択肢 `Notion`）も未変更。

### Kairos → Drive の控え

既に `kairos_backup`（Mac の launchd、04:10・15:10）が Kairos の全データソースと子ページを `マイドライブ/Backups/kairos/` へ書いている。知識文書もそこに入る。加えて `_knowledge/PRJ|archive|ref/…` に**ボルトと同じパスで**同じ中身を置くようにした（`/api/knowledge/index` を使う。古い Worker では飛ばす）。ボルトの写しが壊れても、Drive のフォルダ構成のまま読める・戻せる。

クラウドだけで回す案（GitHub Actions から Drive API へ）は、Drive へ書く鍵をクラウドに置くことになるので採らない。Mac が止まったときの控えの欠測は `launchd-jobs-watchdog` が拾う。

### Notion

消さない。読み取り専用で残す（shim が書き込みを断っている）。照合で `same` と `kairos-only` だけになったら、`mirror_knowledge`・`sync_projects`・`sync_reference` の Notion 経路を止める（Mac の作業）。

## 3. 手順と合格条件

1. この PR をマージ（Worker に `/api/knowledge/*` と早送りの門が入る。Notion は呼ばない）
2. Mac で `audit` を流し、`audit.md` を本人が見る。`review`・`conflict`・`new-project` の扱いを決める
3. D1 を export してから `apply --confirm`（必要なら `--accept`）
4. もう一度 `audit` → `fast-forward`・`new-sub`・`new-ref` が 0、残る `review`／`conflict` が本人の判断どおり
5. saito-tools の付け替え（中立名。済み）→ 残る保守用スクリプトの Notion 経路を止める
6. Drive の `_knowledge/` に PRJ・archive・ref が揃っていることを確かめる

## 4. 限界

- `entity_body_edits` が付くのはこの変更の後の編集から。それ以前（10/18〜）の Kairos での編集は「時刻の無いブロック」「取り込みより新しいブロック」「ページの時刻」で推定する。入れ子ブロックの削除だけは痕跡が残らないので、ページの時刻が動いた文書は `review` にして人が見る
- 照合は本文の上の段の時刻と件数で見る。Notion の入れ子だけの編集は上の段の時刻を進めないことがあり、`same` に見えうる（Notion 側の挙動）。気になる文書は `--accept` で取り直せる
- ref 行の属性（カテゴリ・関連プロジェクトなど）は取り直さない。本文だけ
