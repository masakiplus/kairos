# MCP コネクタ（`/mcp`）

Kairos を **リモート MCP サーバー**として公開する。claude.ai のコネクタ、Claude のモバイルアプリ、クラウドのセッションから、トークンを渡さずに Kairos（D1）のタスク・判断・習慣を読み書きするための入口。実装は `src/mcp.js`。

## なぜ作ったか

クラウド側のセッションは `/api/*` を呼べなかった（認証がなく 401）。トークンを環境変数やチャットで渡すと、シェルやログから漏れうる。そこで OAuth でつなぐコネクタにして、**トークンがチャットにもシェルにも出ない**ようにした。スマホ単体でも Mac の電源に関係なく動く。

## つなぎ方（人が一度だけ）

1. claude.ai の 設定 → コネクタ → カスタムコネクタを追加 で、URL に `https://<worker>/mcp` を入れる（`<worker>` は `tasks-pwa.masaki-saito.workers.dev`）。
2. 認可画面が開く。**Kairos の Cookie がある端末**なら「許可する」を押すだけ。Cookie がなければ `APP_TOKEN` を入力する。
3. 以後、このアカウントのチャットで `kairos_*` が使える。

## 仕組み

| 経路 | 役割 |
|---|---|
| `GET /.well-known/oauth-protected-resource` | このリソースを守る認可サーバー（自分自身）を知らせる |
| `GET /.well-known/oauth-authorization-server` | 認可・トークン・登録の各エンドポイント、PKCE（S256）の要求 |
| `POST /oauth/register` | 動的クライアント登録。`redirect_uri` は claude.ai / claude.com の MCP コールバックと、検査用のループバックだけ |
| `GET/POST /authorize` | 同意画面。人が許可して初めてコードを出す |
| `POST /oauth/token` | コード→トークン、リフレッシュ（アクセス 1 時間、リフレッシュ 60 日） |
| `POST /mcp` | MCP（Streamable HTTP、状態なし、JSON 応答） |

- **状態を持たない**。client_id・コード・アクセス／リフレッシュトークンは、`APP_TOKEN` から導いた鍵で HMAC 署名した文字列。D1 を読み書きしない（読み取り枠を使わない）。トークンには種類（`typ`）と期限が入り、コードをアクセストークンとして使い回すような取り違えは弾く。
- **`/api/*` は MCP のトークンでは呼べない**。使えるのは下の tools だけ。tools は Worker 自身の API を内部で呼ぶので、`APP_TOKEN` は Worker の外へ出ない。
- 認可コードは 60 秒・PKCE 必須。署名だけで単回使用は強制していない（60 秒の間、`code_verifier` を知る者だけが交換できる）。

## tools

| 名前 | 内容 |
|---|---|
| `kairos_rules` | 操作規約と、API 側の最新の規約 |
| `kairos_list_tasks` | 画面別の一覧（today / can / phone / doing / project / delegated） |
| `kairos_search_tasks` | 名前・説明で検索（完了を含めるか選べる） |
| `kairos_get` | 1 件のプロパティと本文（Markdown 風） |
| `kairos_query` | DB の行（open_only・where・columns・limit） |
| `kairos_schema` | プロパティ名・型・選択肢 |
| `kairos_create` | tasks / decisions / habitlog を 1 件作る |
| `kairos_update` | 一部のプロパティを更新（`null` で空にする） |
| `kairos_append_body` | 本文の末尾に追記（既存の本文は消さない） |
| `kairos_task_action` | done / skip / reopen / human / ai_clear |

守っている規約（`/api/storage/agent` と同じ）:

- タスクの完了は `kairos_task_action` の `done`。`kairos_update` で `完了`・`完了日`・`ステータス=完了` を書こうとするとエラーにする（完了日とステータスを一緒に入れるため。`AI処理開始` も空になる）。
- Roles で変えてよいのは `今週の目標`、Projects で変えてよいのは `ステータス`・`対応ゴール`・`完了条件`・`役割`・`名前` だけ（2026-10-20 に 対応ゴール・完了条件・役割 を、2026-10-21 に 名前 を許可した）。
- タスクの `説明` は「なぜ: …」「何を: …」の 2 行だけ。出所・根拠・手順・経過は本文に書く（例外は `docs/rules.md` §1）。
- 選択肢にない値は作らず、エラーにする。
- **削除・アーカイブの道具は置いていない。**
- 長い文字列は 1900 字ずつに分けて保存し、切り捨てない。

## 取り消し（つないだものを全部切る）

次のどちらかで、発行済みの MCP トークンがすべて無効になる。

- `npx wrangler secret put MCP_EPOCH` で適当な値を入れ直す（PWA の Cookie はそのまま使える）。
- `APP_TOKEN` を替える（PWA の Cookie も入れ直しになる）。

その後、コネクタ側でつなぎ直す。

## デプロイ後の確認

```sh
curl -s https://<worker>/.well-known/oauth-authorization-server | head -c 300
curl -si -X POST https://<worker>/mcp -d '{}' | head -5   # 401 と WWW-Authenticate が返ること
```

実際につないだら、チャットで `kairos_list_tasks` を呼び、画面と同じ一覧が返ることを見る。

## 検査

`npm test` に入っている。

- `tests/mcp.test.mjs` … OAuth の一連（登録・同意・PKCE・期限・取り違え・取り消し）と、tools の安全装置（完了は done 経由、Roles/Projects の列制限、選択肢の検証、空にする形、本文追記）
- `tests/mcp-worker.test.mjs` … 実際の Worker と D1（Miniflare）の上で、OAuth から `kairos_list_tasks`／`kairos_update`／`kairos_append_body`／`kairos_task_action` まで通し、MCP のトークンで `/api/tasks` が 401 になることを確かめる
