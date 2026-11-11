import {readFileSync} from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
// 2026-11-12: 横長 (900〜1599px) の着手中・PJ別・役割・決める・買い物では詳細を一覧の上に重ねる。
// 暗幕 (.veil) よりシートが下だと、シートが暗幕に隠れ、触ると暗幕のタップで閉じて「詳細が開かない」になる (Fold 展開で発生)
const html=readFileSync(new URL('../src/app.html',import.meta.url),'utf8');
const css=html.slice(html.indexOf('<style>'),html.indexOf('</style>'));
const z=(re)=>{const m=css.match(re);assert.ok(m,'rule not found: '+re);return Number(m[1]);};
test('重ねる画面ではシートが暗幕より上',()=>{
 const veil=z(/\n\s*\.veil\{[^}]*z-index:(\d+)/);
 const overlay=z(/body:is\(\[data-view="doing"\][^{]*\) \.sheet\{[^}]*z-index:(\d+)/);
 assert.ok(overlay>veil,`overlay sheet z-index ${overlay} <= veil ${veil}`);
});
