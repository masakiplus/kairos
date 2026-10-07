# 開発の手引き（AI エージェント・別端末からの変更向け）

このリポジトリを Claude Code などのエージェントに読ませて変更するときの前提。人が読んでも同じ。

## 守ること

- **規約ロジックは `src/index.js`（Worker）に置く。** 画面（`src/app.html`）は表示と 1 タップだけ。`docs/rules.md` が正本。
- Roles に書くのは `今週の目標`、Projects に書くのは `ステータス` だけ。自由編集フォームは作らない。
- 完了・見送り・重複は `説明` の先頭に根拠 1 行を残す。既存の書式を崩さない。
- 1 タップ操作には必ず ↩ 取り消しを付ける（操作前の値を控えて `POST /api/tasks/:id/restore`）。
- 新しい Notion 列を増やす前に、既存の列・説明欄の先頭行で表せないかを考える。
- 秘密（Notion トークン・APP_TOKEN・Cloudflare トークン）をファイルに書かない。データソース ID は vars。
- 幅 400px（折りたたみ端末を閉じた状態）で崩れないことを先に見る。

## 変更の手順

1. `src/` を編集
2. `src/sw.txt` の `kairos-vNN` を +1
3. 検査（必須）
   ```sh
   cp src/index.js /tmp/chk.mjs && node --check /tmp/chk.mjs      # .js のままだと ESM が黙って通る
   python3 - <<'PY'
   import re; h=open('src/app.html').read(); open('/tmp/app_chk.js','w').write('\n'.join(re.findall(r'<script>(.*?)</script>', h, re.S)))
   PY
   node --check /tmp/app_chk.js
   gitleaks detect --no-banner
   ```
4. ブランチ → Pull Request。**main への直接 push はしない**（main への push がそのまま本番デプロイになる）
5. マージ後、`https://<worker>/sw.js` が新しい版数を返せば反映済み

## API（`src/index.js` のルーター順）

| メソッド・パス | 役割 |
|---|---|
| `GET /api/tasks?view=today\|can\|phone\|project\|delegated` | 一覧。`wip`（着手中件数）と `delegates`（委任先）も返す |
| `GET /api/search?q=&all=1` | 検索（all=1 で完了も） |
| `POST /api/tasks {name, projectId?}` | クイック追加 |
| `GET /api/projects` ／ `POST /api/projects/:id/close {note}` ／ `GET /api/projects/:id/deps` | PJ 見出し・クローズ・つながり |
| `GET /api/roles` ／ `POST /api/roles/:id/goal {taskId}` | 役割タブ・今週の石 |
| `GET /api/review` ／ `POST /api/review/(decision\|verify\|task-carry\|habit\|deps\|dates)/:id {answer, note}` | 見直しカード |
| `GET /api/quadrant` ／ `GET /api/habits/due` ／ `POST /api/habits/:id/log` | 象限・習慣 |
| `GET /api/tasks/:id/(graph\|chain\|detail)` | 3 列グラフ・先行チェーン・詳細 |
| `POST /api/tasks/:id/preds {ids}` | 先行タスクの置き換え（循環は 400） |
| `POST /api/tasks/:id/restore {...}` | 取り消し（渡された列だけ戻す） |
| `POST /api/tasks/:id/(done\|reopen\|defer\|wait\|human\|start\|skip\|dup\|evening\|daytime\|ai\|ai-clear\|delegate\|mit\|mit-clear\|due\|project\|doing\|todo)` | 1 タップ操作。`?note=` `?with=` `?date=` `?to=` `?mode=update&resume=1` |

認証: 初回 `/?t=<APP_TOKEN>` で Cookie。`/api/*` は Cookie か `Authorization: Bearer`。`/health` `/sw.js` `/manifest.webmanifest` とアイコンは認証なし。

## 画面（`src/app.html`）の構成

- `render()` が一覧。中身の署名が前回と同じなら DOM を触らない（スクロール位置を保つ）
- `openSheet()` がタスクのシート、`openPredPick()` 先行ピッカー、`openPjPick()` PJ 付け替え、`openDeps()` つながり（`matchMedia("(min-width:700px)")` でガント／依存順）、`openGraph()` 3 列、`openQuad()` 象限、`renderRoles()` `renderReview()`
- 状態は変数。`localStorage` は一覧のキャッシュと取り消しの控えだけ
- 🤖 への遷移（`intent://`）の前に `await` を挟まない（Android Chrome が Web 版に落ちる）

## 用語

- 今週の石 ＝ Roles の `今週の目標` で指名したタスク（役割ごとに 1 件）
- ⭐ 今日の3つ ＝ MIT。夜間の棚卸しが置き、人が朝に出し入れする
- 人対応 ＝ AI が人の手が要るで止めたタスク
- 🤖 処理中 ＝ `AI処理開始` が 2 時間以内
