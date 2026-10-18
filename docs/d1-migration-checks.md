# D1 移行実験の検査

以下はNotionが正本の間の旧移行実験の手順・記録。D1を正本にする保存形式・切り替え・監査は [`d1-cutover.md`](d1-cutover.md) を参照する。D1切り替え後は `/api/lab/*` を無効にし、古いNotionの写しで正本を上書きしない。各APIはKairosと同じ認証が必要。

## 実データのコピー

`scripts/copy-notion-to-d1.mjs` は Tasks / Projects / Roles / Decisions / Habits / Habit Log の6つを順番にコピーする。既存WorkerのNotion接続を使うため、新しいNotionインテグレーションは不要。必要なのはKairosの既存APP_TOKEN（初回URLの `?t=` またはログイン済みブラウザのCookie `tp`）。`.dev.vars` に設定し、チャットやGitへ貼らない。

コピー前に `wrangler d1 export kairos --remote --output <非公開バックアップ先>` でD1を保存する。2026-10-17のコピー前バックアップは `.wrangler/migration-backups/2026-10-17/before.sql` に取得済み（Git対象外）。

```sh
gh variable list --repo masakiplus/kairos --json name,value > /tmp/kairos-migration-vars.json
node --env-file=.dev.vars scripts/copy-notion-to-d1.mjs /tmp/kairos-migration-vars.json .wrangler/migration-backups/2026-10-17/copy
```

実行スクリプトは各データソースIDを明示するため、Habit Logの既定設定を持たない旧Workerでも実行できる。Notionへの書き込み・docsの削除・往復検査表のリセット・デプロイ・画面の参照先切り替えはしない。既存の同じIDのD1行は最新のNotion属性へ更新し、本文はpendingのものを取得する。既存のerror/truncatedは自動再試行せず、最終検査を不合格にする。

出力先は所有者のみアクセスできるディレクトリとし、DB別のMarkdown exportのJSON、件数、本文変換の問題、実行途中のreport.jsonを保存する。実データなのでGit対象外の場所を指定する。中断時は最後の記録を確認し、同じコマンドで再取得できる。異常終了で `.copy.lock` が残った場合は、実行プロセスが終了していることを確かめてからそのロックだけを削除する。複数の出力先や別端末から同時には実行しない。

`copy_ok` は取得件数とD1件数、本文の完了・変換欠落の検査であり、完全移植の宣言ではない。コピー中のNotion更新、同数のID入れ替わり、子ページの別途取得、部分relation、添付ファイルの永続保存、元のNotionブロックJSON・属性型の保存は保証しない。照合前にはNotion編集を止め、コピー結果に加えて以下の往復検査とID・relation・添付の確認を行う。コピー完了後もNotionを正本として保持する。

## 実行順

### 2026-10-17 実コピー結果

既存の認証済みWorkerからNotionを読み、D1 `kairos` にコピーした。Workerのデプロイ、画面の参照先切り替え、Notionへの書き込みは行っていない。

| collection | Notionクエリ件数 | D1書き出し件数 | 本文done |
|---|---:|---:|---:|
| tasks | 1,434 | 1,434 | 1,434 |
| projects | 182 | 182 | 182 |
| roles | 6 | 6 | 6 |
| decisions | 627 | 627 | 627 |
| habits | 12 | 12 | 12 |
| habit_log | 81 | 81 | 81 |
| 合計 | 2,342 | 2,342 | 2,342 |

以前から失敗していた対象内の本文10件は再取得に成功。対象外のsessionsは変更せず、2件のエラーが残る。Habit LogとHabitsの本文は取得した結果が空であり、属性は保存されている。

**完全移植の判定は未合格。** 部分relationが11ページ（tasks 1、projects 7、roles 3）に残る。既存の変換検査には文字欠落候補1件、pdf 3、file 2、child_database 5の非可逆変換がある。これらの解消と、編集中データの再照合が参照先切り替え前に必要。旧Workerのrelation取得は最初の応答だけなので、継続取得の修正・検証・反映が必要。

非公開の保存先は `.wrangler/migration-backups/2026-10-17/`（Git対象外）。`before.sql` / `after.sql` が前後のD1バックアップ、`verified/` が再取得後のMarkdown export、`verification.json` が最終件数・部分relation一覧。`copy/report.json` は本文10件の再試行前の途中結果なので、最終判定には使わない。SQLバックアップのSQLite整合性はok、対象2,342件のexportとSQLのタイトル・属性・本文・メタデータは全件一致。`snapshot-verification.json` に照合結果とバックアップのSHA256を保存した。

1. `POST /api/lab/init` で実験用の表を作る。
2. `POST /api/lab/props?coll=tasks`（他の collection も同様）を、返された `next` を `cursor` に渡して最後まで実行する。
3. `GET /api/lab/pending` の ID ごとに `POST /api/lab/body?id=…` を実行し、`stats` の error / truncated / missing / lossy を確認する。
4. `POST /api/lab/reset-rt` で**往復検査用の docs_rt だけ**を空にする。
5. `GET /api/lab/export` の全ページを取得する。`next` を `after` に渡し、`next: null` まで続ける。各レスポンスの `files` を `POST /api/lab/import-md` に渡す。
6. `GET /api/lab/compare` の結果を確認する。検査中は props / body / import / reset を並行実行しない。

## 判定

- `roundtrip_ok`: 元が 1 件以上あり、ID の不足・余分、タイトル・属性・本文・メタデータの差分がすべて 0。
- `ok`: 上記に加え、本文がすべて `done`、変換記録と属性 JSON が有効、文字欠落・非可逆変換・切断・エラー・relation の `__more` がない。
- `examples`: 不足・余分・全種類の差分を含む ID を昇順で最大 5 件。未完了や変換問題の例は含まないので、各件数も確認する。

メタデータは collection / parent_id / created / updated / version を比較し、NULL と空文字も区別する。属性は取り込み時にキーを整列した JSON 文字列として比較する。本文の先頭・末尾改行も保持する。

`import-md` はこの実験の export 形式を受け付ける。files は 1〜500 件。必須 frontmatter、ID、collection、title、version、props、重複 ID を検査し、1 件でも不正なら HTTP 400・`n: 0` でバッチ全体を拒否する。既存の docs_rt は変更しない。成功したバッチは D1 の batch でまとめて書き込む。

`ok` は D1 内の本文変換と MD 往復に関する判定。Notion の全ページを取得できたこと、属性型全体の可逆性、添付ファイルの永続性、links の往復までは保証しない。links と conv / body_status は MD の出力対象ではなく、移行完了をこのフラグだけで判断しない。

## ローカルと CI

Node.js 22.13 以降で実行する。`npm ci` で依存を取得する。Cloudflare / Notion の認証情報は不要。

```sh
npm ci
npm run check
npm test
```

構文検査は src のすべての JavaScript と app.html のインライン script が対象。テストはメモリ内 SQLite に実際の SQL を実行し、正常往復、空 DB、不足・余分、各列の差分、本文未完了、変換欠落、不正取込と部分書込防止を検査する。さらに `lab.d1.test.mjs` が、Wrangler に同梱される Miniflare の Worker ランタイムとローカル D1 を使い、ページ分割した export/import、部分書込防止、不足・余分・メタ差分、不正 JSON と未完了の判定を検証する。本番データでの確認は別途必要。

ブランチ push / PR 時に check workflow、デプロイ前にも同じ検査を実行する。check workflow では gitleaks 8.30.1 による全履歴の秘密検査も行う。配布バイナリは SHA256 を固定して検証し、検出値はログで伏せる。
