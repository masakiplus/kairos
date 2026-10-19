# D1を正本にする切り替え

## 保存形式と互換API

`DATA_BACKEND=d1` のとき、Kairosの一覧、検索、役割、PJ、見直し、習慣、完了・延期・取り消しはD1だけを読み書きする。Notion APIへのフォールバックは行わない。`NOTION_TOKEN`も通常動作には不要。`APP_TOKEN`の既存認証は保持する。

データソースIDはD1の定義から解決するため、Notion用のID環境変数も通常動作には不要。ローカルはD1のSQLバックアップを `wrangler d1 execute kairos --local --file <backup.sql>` で復元し、APP_TOKENを設定して動かせる。

- `entities`: 元のページJSON、データソースID、collection、更新リビジョン。
- `entity_schemas`: 元のデータソース定義と選択肢。
- `entity_links`: 全件取得したrelation。更新時はスキーマに基づいて逆側も反映する。
- `entity_children` / `entity_bodies` / `entity_body_versions`: 元ブロックJSON、並び順、取得完了と元ページ更新日時。
- `entity_assets` / `entity_asset_chunks`: Notion管理の添付をD1のBLOBとして保存。認証付きのダウンロードで返す。
- `entity_databases`: 子データベースの元定義。子ページ・子DBのページも元JSONと本文を取得する。

旧 `docs` / `links` / `docs_rt` は移行実験時の写しとして残す。D1切り替え後の正本ではない。Markdown変換で失われる表現は元JSONに保持し、元のMarkdown検査の成功を切り替え条件には使わない。

日付の期限区分・着手可否・前倒し候補と先行未完了数はWorkerがJSTの現在日付とD1の依存関係から計算する。Notionに残った古いformula/rollup値はそれらの判定に使わない。タスクのURLはKairosの `/?page=<id>` へ変わる。

## 移行と監査

認証情報は `.dev.vars` に保存しGitには入れない。出力は所有者だけが読めるGit対象外ディレクトリを指定する。

```sh
node --env-file=.dev.vars scripts/migrate-native.mjs /tmp/kairos-migration-vars.json .wrangler/migration-backups/2026-10-17/native props
node --env-file=.dev.vars scripts/migrate-native.mjs /tmp/kairos-migration-vars.json .wrangler/migration-backups/2026-10-17/native bodies
```

`props` は6つのDBの元JSON・全relation・スキーマを保存する。`bodies` はチェックポイントから本文、子ページ、子DB、添付を取得する。複数のbody実行を同時に起動しない。終了時の `body-state.json` のerrorsを必ず確認する。中断時は保存されたactiveとqueueから再開する。

`GET /api/storage/audit` の未取得本文、未取得子ブロック、部分relation、添付未取得、更新日時不一致がすべて0になることを確認する。最後にpropertiesを再取得し、移植中に更新された本文だけ再取得する。編集を続けているNotionとの完全な同時スナップショットは保証できないため、最終照合から切り替えまではNotion編集を止める。

画面の `/?preview=d1` はD1の読み取り専用プレビュー。全APIリクエストにプレビュー用ヘッダーを付け、更新操作はサーバー側で拒否する。`X-Kairos-Preview: d1` を付けたAPIの読み取りと、通常のNotion版を比較できる。通常版の検証でも `X-Kairos-Validation: readonly` を付けるとGET中の自動記録を抑止する。

## AI・外部ジョブ

`GET /api/storage/agent` がAPIの操作規約、`GET /api/storage/sources` がデータソースID一覧。既存のKairos Cookieまたは `Authorization: Bearer APP_TOKEN` で認証する。秘密を依頼文やURLに含めない。

- 読み取り: `GET /api/data/pages/:id`
- DB問い合わせ: `POST /api/data/data_sources/:id/query`
- 更新: `PATCH /api/data/pages/:id` に `{properties:{...}}`
- 作成: `POST /api/data/pages` に `{parent:{data_source_id},properties:{...},children?:[...]}`
- 本文: `GET /api/data/blocks/:id/children`、`PATCH`で追記。元のNotionブロック形のJSONを使う。
- 完了: `POST /api/tasks/:id/done`。完了・完了日・ステータスの3点と処理中の解除をまとめて行う。
- 取り消し: `POST /api/tasks/:id/restore`。

この互換APIはKairosが使う操作の範囲であり、Notion API全体の実装ではない。未対応操作はエラーにし、Notionへ転送しない。役割は今週の目標、PJはステータス・名前・対応ゴール・完了条件・役割だけを変更する。依存の循環は拒否する。

AI向けの文面はD1正本と上記のAPIを指示する。**既存のNotion用AI接続や夜間ジョブが自動的にD1へ接続し直されるわけではない。** 呼び出し先・認証・対応操作をそれぞれ変更する必要がある。Notionへの更新は切り替え後のKairosには反映されない。位置受信も従来Notionに書く外部ジョブなので、新しい正本に継続反映するには同様の対応が必要。

## 反映と復旧

切り替え前のWorkerバージョンとD1 SQLエクスポートを記録する。全検査と監査を通した後に `DATA_BACKEND=d1` を反映する。リポジトリのwrangler.tomlにも同じ値を保存し、次のデプロイで戻らないようにする。`/api/storage/status` で実際のbackendを確認する。

切り替え後は移行APIと旧lab APIの再取得を禁止し、Notionの古いコピーでD1を上書きさせない。**D1への実更新が始まった後に単にNotionへ戻すと、その更新が画面から消える。** 復旧はD1を保持した修正・互換Workerの再反映を基本とし、古いNotion版への切り戻しはD1の更新を退避・再移植してから判断する。

## 2026-10-18 の移行チェックポイント

### 早朝（枠上限で停止）
D1の日次書き込み無料枠の上限に達し、切り替えを保留した。枠のリセットは毎日00:00 UTC（日本時間09:00）。課金プランへの変更は行っていない。停止時点で基本6DB 2,342件・子DB 177件・子ページ等 453件、本文 5,083か所、未完了の本文 128か所と添付 6件。日付をまたいだため期限の派生値に差（formulaDiffs 76件、期限区分・前倒し候補だけ）が出ていた。

### 09:08〜（再開・監査 ready）
- `props` を再取得（tasks 1,447・projects 182・roles 6・decisions 636・habits 12・habit_log 86。停止後の Notion 側の追加分を含む）。再取得後は **formulaDiffs 0**。差は日付境界で Notion の保存値と D1 の当日計算がずれたもので、計算の誤りではない。
- `bodies` を再開し、残り 128か所を取得。添付 6件は Worker の `fetch(..., {redirect:'error'})` が Workers で使えず全件失敗していたため、手動で最大3回までリダイレクトを追い、各段で許可ホストを確かめる形に直した（636714d）。修正版を backend=notion のまま反映し、添付 6件（PDF 4・CSV 2、計 1,548,318 バイト）を保存。
- `props` 再取得で更新日時が進んだ 36件の本文は古い扱いになったため、その 36件だけ `done` から外して再取得した。
- 監査: pendingRoots 0・pendingChildren 0・partialRelations 0・pendingAssets 0・outdatedBodies 0・formulaDiffs 0、**ready=true**。
- 最終 SQL バックアップ `.wrangler/migration-backups/2026-10-18/native-ready.sql`（130,279,875 バイト）。ローカル SQLite に復元して `PRAGMA integrity_check=ok`。件数は監査と一致、本文 5,238 か所すべて complete、子ブロック 70,939、relation 4,708、添付 6件は各チャンク合計がサイズと一致。`native-ready.verification.json` に記録（Git 対象外）。
- 読み取り比較（通常版と `X-Kairos-Preview: d1`、`X-Kairos-Validation: readonly`）: today・can・phone・doing・project・delegated の6一覧で件数・欠け・余分・項目差（名前・期日・開始日・状態・完了・先行待ち・状況・PJ・優先度・今日の3つ・担当・今夜）がすべて 0。役割・PJ・習慣・見直し・検索・象限も件数一致。応答は D1 が 0.15〜0.34 秒（初回 1.3 秒）、Notion が 0.7〜2.5 秒。
- D1 モードの一覧が毎回全件を読み直して約1秒かかっていたため、行数・revision・rowid の合計と JST 日付の指紋が変わらない間は解析済みの写しを使い回すようにした（9017fcb）。

### 未検証として残すもの
- Mac の `codex://new?prompt=…` 遷移と Android の共有シートは実機未確認。Android 対応済みと扱わない。
- 外部の Notion 連携（夜間棚卸し・Telegram ボット・リマインダー取り込み・メール/iMessage トリアージ・health-sync・location-sync など）は D1 へ向け直していない。切り替え後はそれらの Notion への書き込みが Kairos に反映されず、Kairos の更新も Notion には届かない。Kairos 本体の移行完了と外部連携の完了を混同しない。
