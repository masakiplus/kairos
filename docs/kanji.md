# 漢字書き取り（/kanji/）と紙ドリルの SRS 正本

2026-11-07 から、紗綾（saya）・明澄（akito）の漢字ドリルの SRS は Kairos の D1 が正本。Mac の紙ドリル（saito-tools の `kanji_drill` / `kanji_drill_akito`）も、iPad の PWA（`/kanji/`）も、ここを読み書きする。設計書: Claude Docs「漢字書き取り iPad PWA 詳細設計」。

## 置き場（`src/kanji.js`。初回に CREATE TABLE IF NOT EXISTS）

| 表 | 中身 |
|---|---|
| `kanji_srs(child, key, data)` | review_state.json の 1 キー = 1 行。`data` は紙ドリルが書いた dict をそのまま JSON（stage・due・shown・last_miss など） |
| `kanji_files(child, name, content)` | `review.txt` / `review_retired.txt` の中身をそのまま |
| `kanji_results(id, child, key, source, grade, detail, …)` | 採点の履歴。`id` で再送を弾く。`applied=0` は記録だけ（その日の再出題・もういちど） |
| `kanji_today(child, date, items)` | その日の書き取り。紙ドリルの生成が書く |
| `kanji_glyph(ch, data)` | KanjiVG（© Ulrich Apel, CC BY-SA 3.0）の画と番号位置のキャッシュ |
| `kanji_art(id, mime, data)` | 正解イラスト。id は中身のハッシュ。出題の `art` に id、`say` に吹き出しのセリフ |

Kairos 本体の表とは独立で、書き込みで `storage_control.rev` を進めない（一覧キャッシュを捨てない）。

## API

| メソッド・パス | 認証 | 役割 |
|---|---|---|
| `GET /kanji/` ほか殻（sw.js・manifest・アイコン） | なし | PWA |
| `GET /api/kanji/today?child=` | 合鍵 or Kairos | 今日（JST）の出題。まだ無ければ直近の日 |
| `POST /api/kanji/results {child, results:[{id,key,grade,retry?,…}]}` | 合鍵 or Kairos | 採点の取り込み。`grade` = ok / hint / ng |
| `GET /api/kanji/glyph?ch=池今日` | 合鍵 or Kairos | お手本 |
| `GET /api/kanji/state?child=` ／ `PUT …` `{srs:{key:dict\|null}, files:{name:全文}, replace?}` | Kairos | 紙ドリルの読み書き・移行・復元 |
| `PATCH /api/kanji/files?child=` `{name, add:[行], remove:[行]}` | Kairos | review.txt の差分 |
| `PUT /api/kanji/today?child=&date=` `{items:[{key,ans,sentence,reading,emoji?}]}` | Kairos | 出題の書き込み（`sentence` の □ が答えの位置） |
| `PATCH /api/kanji/art?child=&date=` `{art:{key:{mime,data,say?}}}` | Kairos | 正解イラストを付ける。SVG（検査あり）か JPEG/PNG/WebP の base64。Mac の kanji_art.py が夜に描いて送る |
| `GET /api/kanji/art/<id>` | なし | 絵そのもの（immutable キャッシュ） |
| `GET /api/kanji/export?days=120` | Kairos | 全員分の SRS・ファイル・履歴（Mac の日次バックアップ用） |
| `GET /api/kanji/link` | Kairos | iPad に渡すリンク（`/kanji/#key=<合鍵>`） |

合鍵 = `HMAC-SHA256(APP_TOKEN, "kanji-pwa/v1")` の先頭 16 バイト。新しい秘密は増やさない。APP_TOKEN を変えると合鍵も変わるので、iPad はリンクを開き直す。合鍵でできるのは上の 3 つだけ。

## stage 遷移（紙の `srs_mark` と同じ）

| | 紗綾 | 明澄 |
|---|---|---|
| 間隔 | 1・3・7・14・60 日、stage5 で卒業 | 1・3・7・14 日、stage4 で卒業 |
| ok | stage+1 | stage+1 |
| ng | stage−2、last_miss | stage0、last_miss |
| hint（iPad のみ） | stage 据え置き、翌日 | 同左 |
| キー | 送り仮名を落とす（決める→決） | そのまま |

規則を変えるときは saito-tools 側の `srs_mark` と同時に変える（`tests/kanji.test.mjs` に両方の例がある）。

## 画面のふるまい（2026-11-07 追加）

- 1画ずつのその場ヒント: 書いた画をお手本の同じ画と比べる（1画目は形と向きだけ、2画目からはそれまでの画で位置と大きさを合わせる）。合わなければその画を赤で見せ、書いた線を 1.3 秒で消す。ヒントを出した字は △
- 音（Web Audio、ファイルなし）: 1画ごとに少しずつ高くなる「ぽん」、まちがいは「ぶっぶ」、正解はファンファーレ。ホームの「おと」で切り替え
- × のあとは書き順を見せてから、その字の練習（うすいお手本をなぞる 2 回＋お手本なし 1 回、ヒントと音つき）。練習は SRS に入れない
- 合成テスト（18 字×3 回）: 正しく書いた・小さく端に・子どもらしいずれ（弱）でヒントが出たのは 0/54、ずれ（強）で 4/54。書き順入れかえ・ちがう字は 51/54 で途中で止まる
