# AIアプリの切り替え

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

D1移行検査のPRとは別の変更。Worker APIやNotionの列は追加しない。Service Workerはv67に更新する（D1移行検査の提案はv66）。両PRを統合する時は、最終のキャッシュ版数とpackage.jsonの両方の検査コマンドを残す。
