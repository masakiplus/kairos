# ドリル SRS の共通正本（/api/drill/）

2026-11-12 から、漢字（`docs/kanji.md`）以外の紙ドリルの state も Kairos の D1 を正本にできる。Mac の紙ドリルは saito-tools の `drill_srs_sync.py` 経由で読み書きする（漢字の `kanji_srs_sync.py` と同じ write-through 方式。ローカルのファイルは D1 の写しとして残り、signage・weekly_review・weak_sheet は無改修で動く）。切り替えは Mac の `~/.config/saito-tools/.env` の `DRILL_SRS_REMOTE=<名前,名前,…>` に書いた名前だけ。

## 置き場（`src/drill.js`。初回に CREATE TABLE IF NOT EXISTS）

| 表 | 中身 |
|---|---|
| `drill_state(name, key, data)` | state ファイルの最上位キー 1 つ = 1 行。`data` は値をそのまま JSON（dict・配列・数値） |
| `drill_files(name, file, content)` | `review.txt` などテキストを全文で。許可は `DRILLS[name]` に書いたファイル名だけ |

Kairos 本体の表とは独立で、書き込みで `storage_control.rev` を進めない。

## 名前（`DRILLS`）

| name | ローカルの実体 |
|---|---|
| saya_kokugo | kanji_drill/kokugo_state.json（読解:型・語句:語句） |
| sansu_srs | sansu_drill/sansu_srs_state.json |
| rika_review | rika_drill/rika_review_state.json |
| shakai_review | shakai_drill/shakai_review_state.json |
| yuzuki_hiragana | hiragana_drill_yuzuki/review_state.json と review.txt |
| hikizan_srs・hikizan_tokei | hikizan_akito/ の 2 ファイル |
| tasshizan_srs・tasshizan_tokei | tasshizan_yuzuki/ の 2 ファイル |
| yuzuki_kokugo | kokugo_yuzuki/kokugo_yuzuki_state.json |
| saya_tokinaoshi | kokugo_drill/tokinaoshi_state.json（休止中） |

移さないもの: 各 `state.db`（出題ローテ・生成キャッシュ。再生成できる）、`grade_log.jsonl`（追記ログ）。

## API（すべて Kairos の認証が必要）

| メソッド・パス | 役割 |
|---|---|
| `GET /api/drill/state?name=` | `{name, state:{key:値}, files:{ファイル:全文}}` |
| `PUT /api/drill/state?name=` `{set:{key:値 または null}, files:{ファイル:全文}, replace?}` | 差分 upsert（null は削除）。replace=true は state を全部入れ替え（移行・復元） |
| `GET /api/drill/export` | 全ドリル分（Mac の日次バックアップ `drill_srs_sync.py backup` 用） |
| `GET /api/drill/names` | 許可した名前とテキストファイル |
