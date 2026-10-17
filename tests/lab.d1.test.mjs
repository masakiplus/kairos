import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

// 実際の Worker ランタイム + ローカル D1 で API を通す。外部 API・本番 DB は使わない。
test('Worker / D1: ページ分割した往復、壊れた入力、差分と未完了の検出', async () => {
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: true,
    compatibilityDate: '2026-09-01',
    d1Databases: ['DB'],
    script: readFileSync(new URL('../src/lab.js', import.meta.url), 'utf8') + `
      export default { fetch(req, env) {
        return labRoute(req, env, new URL(req.url), (body, status = 200) => Response.json(body, { status }));
      } };
    `,
  }));
  try {
    const db = await mf.getD1Database('DB');
    const api = async (path, body) => {
      const res = await mf.dispatchFetch('http://localhost/api/lab/' + path, {
        method: body === undefined ? 'GET' : 'POST',
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      assert.ok(res.status < 500, await res.clone().text());
      return { status: res.status, body: await res.json() };
    };
    await api('init', {});
    assert.equal((await api('compare')).body.ok, false);
    const ids = ['a'.repeat(32), 'b'.repeat(32), 'c'.repeat(32)];
    for (const id of ids) {
      await db.prepare(`INSERT INTO docs (id, collection, title, body_md, props, body_status, conv)
        VALUES (?, 'tasks', '題名', ?, '{}', 'done', '{"missing":0,"lossy":{},"truncated":false}')`)
        .bind(id, '\n本文\n---\n終わり\n').run();
    }
    let next = '', exported = [];
    do {
      const page = await api('export?n=2&after=' + next);
      exported.push(...page.body.files);
      next = page.body.next;
      if (page.body.files.length) assert.equal((await api('import-md', { files: page.body.files })).status, 200);
    } while (next);
    assert.equal(exported.length, 3);
    assert.equal((await api('compare')).body.ok, true);
    assert.equal((await db.prepare('SELECT body_md FROM docs_rt WHERE id = ?').bind(ids[0]).first()).body_md, '\n本文\n---\n終わり\n');

    const rejected = await api('import-md', { files: [
      { text: exported[0].text.replace('title: "題名"', 'title: "上書き"') }, { text: 'broken' },
    ] });
    assert.equal(rejected.status, 400);
    assert.equal(rejected.body.n, 0);
    assert.equal((await db.prepare('SELECT title FROM docs_rt WHERE id = ?').bind(ids[0]).first()).title, '題名');

    await db.prepare('UPDATE docs_rt SET updated = ? WHERE id = ?').bind('changed', ids[0]).run();
    await db.prepare('DELETE FROM docs_rt WHERE id = ?').bind(ids[1]).run();
    await db.prepare('UPDATE docs_rt SET id = ? WHERE id = ?').bind('d'.repeat(32), ids[2]).run();
    const diff = (await api('compare')).body;
    assert.equal(diff.meta_diff, 1); assert.equal(diff.missing_in_rt, 2); assert.equal(diff.extra_in_rt, 1);
    assert.equal(diff.ok, false); assert.equal(diff.examples.length, 4);
    await api('import-md', { files: exported });
    await db.prepare('DELETE FROM docs_rt WHERE id = ?').bind('d'.repeat(32)).run();
    for (const conv of ['broken', 'null', '{}', '{"missing":0,"lossy":{},"truncated":false}']) {
      await db.prepare('UPDATE docs SET conv = ?').bind(conv).run();
      assert.equal((await api('compare')).body.ok, conv.includes('truncated'));
    }
    await db.prepare("UPDATE docs SET body_status = 'pending'").run();
    assert.equal((await api('compare')).body.incomplete_bodies, 3);
  } finally {
    await mf.dispose();
  }
});
