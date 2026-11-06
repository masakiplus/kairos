// かんじ れんしゅう (/kanji/) の殻。index.js が /kanji/ のときだけ動的 import する (docs/kanji.md)
import KANJI_HTML from "./kanji.html";
import KANJI_SW from "./kanji-sw.txt";
import KANJI_MANIFEST from "./kanji.webmanifest";
import { KANJI_ICON_180_B64, KANJI_ICON_512_B64 } from "./kanji-icons.js";
export const KANJI_ASSETS = { html: KANJI_HTML, sw: KANJI_SW, manifest: KANJI_MANIFEST, icon180: KANJI_ICON_180_B64, icon512: KANJI_ICON_512_B64 };
