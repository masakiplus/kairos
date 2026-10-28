# AIアプリの切り替え

D1版では依頼文に「正本はKairos D1、Notionのコピーは更新しない」と接続先APIを付ける。受け渡し先のAIがD1へ接続するには、別途Kairosの認証が必要。秘密を依頼文には含めない。Mac Chromeからのコピーと、ローカルの検証フォームへの貼り付けで、日本語・改行・D1ページURL・API案内を確認済み。

画面上部の「任せるAI」で Claude → ChatGPT → Antigravity の順に選べる。初回はClaude。選択は端末ごとに保存する。アプリの利用上限を自動検出したり、依頼を自動送信する機能ではない。

Claudeが使えない場合はChatGPT、ChatGPTも使えない場合はAntigravityに切り替える。

## 渡し方

- **Claude**: 既存の1タップ起動を維持する。AndroidのintentとMacのClaudeアプリ起動も維持する。
- **ChatGPT**: 依頼文を表示し「依頼文をコピー」→「ChatGPTを開く」→チャットに貼って送る。Codex専用画面には送らない。通常のHTTPSリンクを使うため、端末の設定によってはブラウザで開く。MacのChatGPTアプリにもコピーした文面を貼れる。
- **Antigravity**: 文面をコピーし、MacのAntigravityアプリに貼って送る。「案内を開く」は公式サイトへのリンクで、アプリを直接起動するものではない。

タスクの実行・更新・先行チェーンに加え、各タブ末尾の相談、役割、見直し、PJ・依存関係の相談も同じ選択を使う。タスク名・Notion URL・依頼内容は引き継ぎ、ChatGPT/Antigravity向け文面にはClaude専用の `read_conversation` を要求しない。受け渡し中の依頼文を端末ストレージには保存しない。

ChatGPT/Antigravityでは、コピー・リンクを開く操作だけでNotionの「AI処理開始」を立てない。受け取ったAIが実行を始める時に記録するよう依頼する。前のAIの作業を重複実行せず、Notionや規約への接続を確認できなければ質問する指示も渡す。受け渡し先のNotion接続・権限は別途必要。

## セッション

既存チャットのURLはアプリごとに判定する。選択したAIと保存済みセッションが一致する場合だけ再開先として使い、ClaudeのチャットをChatGPTに再利用しない。ChatGPTのURLをClaude用のintentに変換しない。HTTPSかつ既知のAIホスト以外の保存済みセッションは起動しない。

受け渡し画面は閉じるボタン・Escape・端末の戻るで閉じられ、背面のタスクシートを保つ。コピーに失敗した時は成功表示にせず、依頼文を選択して手動コピーを案内する。

## 検証

```sh
npm run check
npm run check:ui
npm run test:ai
```

8件の回帰テストで、既定のClaude起動、各AI向けの文面、先行順、セッションの分離、コピー失敗、選択の保存、コピー時のNotion非更新を確認する。ブラウザ・実機での起動先は端末設定によって異なるため、Androidのアプリ切替とMacの貼付操作を実機で確認する。

## Macでの確認

1. Kairosで「任せるAI」をChatGPTに変更し、タスクのAIボタンを押す。
2. 表示されたタスク名・Notion URL・依頼内容を確認し、「依頼文をコピー」を押す。
3. MacのChatGPTアプリで新しいチャットを開き、貼り付ける。送信前に文面とNotionへの接続を確認する。
4. 受け渡し画面を閉じ、元のタスクシートへ戻れることを確認する。コピーやリンクを開いただけでは「AI処理開始」が変わらないことも確認する。
5. Claudeに戻して既存の起動を確認する。Antigravityでも依頼文をコピーしてMacアプリに貼れることを確認する。
6. ウィンドウ幅400pxでAI選択と受け渡し画面を操作し、横にはみ出さずボタンを押せることを確認する。

これらは実機確認の手順で、実施済みの記録ではない。Notionへ書き込む依頼の送信は内容を確認してから行う。

D1移行検査と統合した状態では `npm test` で両方の回帰テストを実行する。Worker APIやNotionの列は追加しない。Service Workerはv68。

## 2026-10-17 Mac検証記録

PR #6（e9af223）をローカルへ取得し、架空のタスクを返す読み取り専用localhostで検証。本番Notionには接続していない。

- Mac ChromeでChatGPTを選択 → タスクの受け渡し → コピー → 通常のChatGPT Web入力欄へCommand+V。日本語、改行、Notion URLを保持。送信せず、検証文面を消去した。
- Chromeの端末表示400×832、ズーム100%でAI選択と受け渡しの表示を確認。コピーと開くボタンが画面内に収まる。
- アプリ内ブラウザでEscape後に背面のタスクシートが残ること、Antigravityの文面・案内URL・戻るで閉じる動作を確認。
- スワイプ先にClaudeが固定表示される箇所と、案内文に式がそのまま出る箇所を修正。保存済みの別AIセッションを開く際の処理中更新も抑止。Service Workerはv69。
- AntigravityはMac上でアプリを見つけられず、アプリ内の貼り付けは未検証。ChatGPTのMacアプリとClaudeの実起動、実Notion接続・更新も未検証。

本番反映は未実施。GitHub上では #5 は未マージ、#6 は #5 のブランチがベースで、その変更を包含する。#5のマージがmainのデプロイを起動するため、マージ前に検証結果と反映順を確認する。

## 2026-10-29 入口の切り分けと打刻（kairos-v86）

🤖 の入口は 3 つ。**cloud**（Claude Code のクラウド、`claude.ai/code/new`）・**mac**（Mac を接続して開く `claude.ai/new`）・**cowork**（それ以外の `claude.ai/new`）。規則は `src/launches.js` の `ENTRY_RULES` 1 か所に置き、夜間の棚卸しと 🤖 の打刻が同じものを読む。

1. Mac の印: 実行環境に Mac・紙・郵送、または名前・説明・本文に `.env`・launchd・SRS・印刷・スキャン・box.com → mac（埋めるのは `Mac`）
2. リポジトリの仕事: エリア=自動化・システム かつ 種類=作業/調査 で、名前・説明・本文に saito-tools・saito-workers・kairos・tasks-pwa・tools/ → cloud（埋めるのは `クラウド`、接続先は PR #33 と同じ）
3. それ以外 → cowork（実行環境は空のまま）

本人が手で付けた実行環境は常に勝つ。自動判定は空のときだけ埋める（書く直前に読み直して空でなければ飛ばす）。

| API | 役割 |
|---|---|
| `GET /api/entry/rules` | 規則そのもの（JSON） |
| `POST /api/entry/fill?dry=1` | 実行環境が空の未完了（委任中を除く）を規則で埋める。`dry=1` は書かずに候補だけ。応答の `summary` が「クラウドに振った n 本・Mac に振った n 本・Cowork のまま n 本」で、`cloud[]`／`mac[]` に名前・URL・当たった理由。毎晩 02:30 の tasks-undated-review（saito-tools）が呼んで翌朝の報告に載せる |
| `POST /api/tasks/:id/ai?…&provider=&dev=` | 🤖 の印に加えて D1 の `launch_log`（ts・day・task_id・entry・repo・mode・resume・device・rule）に 1 行。entry は実際に飛んだ先（実行環境にクラウドがあるときだけ cloud）、rule は規則の判定。打刻に失敗しても 🤖 の印は返す |
| `GET /api/entry/log?days=7` | 打刻の生の行 |
| `GET /api/entry/weekly?weeks=4` | 週（月曜 16:00 JST の枠リセット区切り）ごとに入口別の本数・クラウドの割合と、使用率ログ（タスク「Claude週間枠 使用率ログ」本文の表の 日時・週間% 列。`USAGE_LOG_TASK_ID` で差し替え可）の最終値、枠の 1 日ごとの本数と週間% |

比較の起点はクレジットが切れた 11/6 以降の最初の週。`credit: true` の週（11/5 16:59 までに始まった週）はクラウドの消費が週間枠に乗らないので比較に使わない。

あわせて、「クラウドで」の 🤖 処理中 節に実行環境にクラウドを含まないタスクが混ざっていたのを直した（処理中の合流はどのタブにも足すが、クラウドで だけはクラウドのものに限る）。
