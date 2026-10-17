# D1 移行実験の検査

Notion が正本の間、`/api/lab/*` で D1 の写しを検査する。本番の一覧は引き続き Notion を使う。各 API は Kairos と同じ認証が必要。

## 実行順

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
