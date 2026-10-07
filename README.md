# Kairos

Notion のタスク DB を **スマホのホーム画面から 1 タップで回す** ための薄い PWA。Cloudflare Worker 1 本で、画面（`src/app.html`）と Notion を叩く API（`src/index.js`）を両方配る。

> καιρός ＝ 機が熟した時。「いま手を付けるものを決める場」。考える仕事は AI チャットに投げ、Kairos は判断を押すだけの層にとどめる。

*A thin PWA that drives a Notion task database from a phone's home screen with one tap. One Cloudflare Worker serves both the UI and the Notion-backed API. Japanese-first; the design notes and rules in `docs/` are the useful part if you are building something similar.*

## できること

| タブ | 中身 |
|---|---|
| 今日やる | 期限切れ＋今日期日、着手できるものだけ。先頭に ⭐ 今日の3つ（MIT） |
| 今日できる | 前倒し候補（期日 1〜7 日 or 日付なし） |
| スマホで | 実行環境が iPhone／電話 |
| PJ別 | プロジェクトごと。ゴール・進捗・クローズ候補・順番未整理バッジ・🔗 つながり（ガント／依存順） |
| 役割 | 7 つの習慣型の役割ごとに ミッション／今週の石／PJ ツリー／象限 |
| 見直し | 一問一答カード（未決・PJ クローズ・繰越・検証・習慣・依存案・日程案） |
| 委任 | 家族に任せたもの |

行の操作: **丸タップ＝完了**、**右スワイプ＝🤖 AI に進めてもらう**、**左スワイプ＝明日へ**、タップ＝シート（状態・先行タスク・日程・委任・片付ける）。すべての操作に ↩ 取り消し。

振る舞いの規約は [`docs/rules.md`](docs/rules.md)、Notion 側に必要なプロパティは [`docs/notion-schema.md`](docs/notion-schema.md)、判断の経緯は [`docs/design-notes.md`](docs/design-notes.md)。

## 構成

```
src/
  index.js            Worker（ルーティング・Notion アクセス・規約ロジック）
  app.html            画面（HTML/CSS/JS を 1 ファイルに）
  sw.txt              Service Worker。先頭の kairos-vNN がキャッシュ版数
  manifest.webmanifest, icons.js
wrangler.toml         Worker 名・ビルド規則・既定値（ID と秘密は含めない）
.github/workflows/deploy.yml   main への push で wrangler deploy
docs/                 規約・スキーマ・設計の経緯
```

## 動かす

1. Notion に `docs/notion-schema.md` のプロパティを持つ DB を用意し、内部インテグレーションを Connect する。
2. Cloudflare Workers のアカウントで、秘密を 2 つ入れる:
   ```
   npx wrangler secret put NOTION_TOKEN   # Notion internal integration token
   npx wrangler secret put APP_TOKEN      # この PWA を開くための共有トークン（長いランダム文字列）
   ```
3. データソース ID を vars として渡す。ローカルは `.dev.vars`（`.dev.vars.example` を写す）、本番は GitHub Actions の Variables（`TASKS_DATA_SOURCE_ID` ほか、`deploy.yml` 参照）。
4. `npx wrangler dev` → `http://localhost:8787/?t=<APP_TOKEN>` で開く。初回だけ `?t=` 付きで開くと Cookie に入り、以後はホーム画面に追加して使う。

## 公開前の検査（事故から決めた手順）

- `cp src/index.js /tmp/chk.mjs && node --check /tmp/chk.mjs` — `.js` のまま `node --check` すると ESM が黙って通る
- `app.html` の `<script>` を切り出して同じく `node --check`
- `gitleaks detect` を通す
- `src/sw.txt` の `kairos-vNN` を +1（忘れると端末のキャッシュが入れ替わらない）

## 周辺

- 夜間の棚卸し（期限切れの置き直し・依存と日程の提案・メモ取り込み）は別リポジトリの headless ジョブが行い、提案は Notion の Decisions に置かれて Kairos の見直しタブで確定する。Kairos 単体でも動く。
- デザインの原案は Claude Design で起こしてから CSS に反映している。

## License

MIT
