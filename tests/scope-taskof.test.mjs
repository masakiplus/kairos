// 決めるタブが「taskOf is not defined」で落ちた回帰 (2026-11-06)。
// taskOf の定義は reviewQuestions の中になければならない（taskGraph に迷い込んでいた）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../src/index.js", import.meta.url), "utf8");
const fnBody = (name) => {
  const i = src.indexOf(`async function ${name}(`);
  assert.ok(i >= 0, `${name} が無い`);
  const next = src.indexOf("\nasync function ", i + 10);
  return src.slice(i, next < 0 ? undefined : next);
};

test("taskOf は reviewQuestions の中で定義され、taskGraph には無い", () => {
  assert.match(fnBody("reviewQuestions"), /const taskOf = async/);
  assert.doesNotMatch(fnBody("taskGraph"), /taskOf/);
});
