import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { initD1 } from '../src/d1.js';

// 実際の Worker (index.js + mcp.js + d1.js) を Miniflare の D1 の上で動かし、OAuth から tools まで通す。
// 連結のしかたは d1-app.test.mjs と同じ（mcp.js は名前の衝突を避けて関数で包む）
const src = (name) => readFileSync(new URL('../src/' + name, import.meta.url), 'utf8');
const bundle = () =>
  src('lab.js') + '\n' + src('d1.js').replace(/^import .*;$/m, '') + '\n' + src('icons.js').replaceAll('export const ', 'const ') + '\n' +
  ['APP_HTML', 'SW_JS', 'MANIFEST'].map((name, i) => 'const ' + name + '=' + JSON.stringify(src(['app.html', 'sw.txt', 'manifest.webmanifest'][i])) + ';').join('\n') + '\n' +
  'const {isMcpPath,mcpRoute}=(()=>{' + src('mcp.js').replace(/^export /gm, '') + '\nreturn {isMcpPath,mcpRoute};})();\n' +
  src('index.js').replace(/^import .*\n/gm, '');

const ORIGIN = 'https://kairos.test';
const TOKEN = 'test-only-token';
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
const b64u = (buf) => Buffer.from(buf).toString('base64url');

test('実 Worker: OAuth でつないで tools が D1 を読み書きでき、MCP のトークンでは /api を直接呼べない', async () => {
  const ds = 'd'.repeat(32), id = 'a'.repeat(32);
  let outbound = 0;
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: true, compatibilityDate: '2026-09-01', d1Databases: ['DB'],
    bindings: { APP_TOKEN: TOKEN, DATA_BACKEND: 'd1', TASKS_DATA_SOURCE_ID: ds },
    outboundService: () => { outbound++; return new Response('blocked', { status: 500 }); },
    script: bundle(),
  }));
  try {
    const db = await mf.getD1Database('DB');
    await initD1({ DB: db });
    await db.prepare('INSERT INTO entity_schemas VALUES(?,?,?)').bind(ds, 'tasks', JSON.stringify({ properties: { 名前: { type: 'title' }, 完了: { type: 'checkbox' }, ステータス: { type: 'status' }, 実行環境: { type: 'multi_select', multi_select: { options: [{ name: 'スマホ' }] } }, 担当: { type: 'select', select: { options: [] } } } })).run();
    const today = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
    await db.prepare('INSERT INTO entities(id,ds,collection,payload) VALUES(?,?,?,?)').bind(id, ds, 'tasks', JSON.stringify({ id, parent: { type: 'data_source_id', data_source_id: ds }, properties: { 名前: { type: 'title', title: [{ plain_text: '検証タスク' }] }, 完了: { type: 'checkbox', checkbox: false }, 期日: { type: 'date', date: { start: today } }, ステータス: { type: 'status', status: { name: '未着手' } } } })).run();
    await db.prepare('INSERT INTO entity_bodies VALUES(?,1)').bind(id).run();

    const fetchJson = async (path, init = {}) => { const r = await mf.dispatchFetch(ORIGIN + path, init); return { status: r.status, res: r, text: await r.text() }; };

    // 登録 → 同意（Cookie あり）→ コード → トークン
    const reg = await fetchJson('/oauth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_name: 'Claude', redirect_uris: [REDIRECT] }) });
    assert.equal(reg.status, 201);
    const client = JSON.parse(reg.text);
    const verifier = b64u(randomBytes(40)), challenge = b64u(createHash('sha256').update(verifier).digest());
    const q = new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', state: 's' });
    const page = await fetchJson('/authorize?' + q, { headers: { Cookie: 'tp=' + TOKEN } });
    assert.equal(page.status, 200);
    const areq = page.text.match(/name="areq" value="([^"]+)"/)[1];
    const approve = await mf.dispatchFetch(ORIGIN + '/authorize', { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: ORIGIN, Cookie: 'tp=' + TOKEN }, body: new URLSearchParams({ areq, decision: 'allow' }).toString() });
    assert.equal(approve.status, 303);
    const code = new URL(approve.headers.get('Location')).searchParams.get('code');
    const tok = await fetchJson('/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: client.client_id, redirect_uri: REDIRECT, code_verifier: verifier }).toString() });
    assert.equal(tok.status, 200);
    const access = JSON.parse(tok.text).access_token;

    // /mcp は Cookie/APP_TOKEN では入れず、MCP のトークンでだけ入れる
    const mcp = async (method, params, bearer = access) => {
      const r = await fetchJson('/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + bearer }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      return { status: r.status, json: r.status === 200 ? JSON.parse(r.text) : null };
    };
    const call = async (name, args) => { const { json } = await mcp('tools/call', { name, arguments: args }); return { isError: !!json.result.isError, text: json.result.content[0].text }; };
    assert.equal((await mcp('ping', undefined, TOKEN)).status, 401);
    assert.equal((await mcp('initialize', { protocolVersion: '2025-06-18' })).json.result.serverInfo.name, 'kairos');

    // 規約 §11（AI処理開始/AIセッション/人対応）が /api/storage/agent に載っている
    const agent = JSON.parse((await fetchJson('/api/storage/agent', { headers: { Authorization: 'Bearer ' + TOKEN } })).text);
    assert.ok(agent.rules.some((r) => r.includes('AIセッション') && r.includes('AI処理開始')));
    assert.ok(agent.rules.some((r) => r.includes('人対応')));
    // MCP のトークンでは /api/* を直接は呼べない
    assert.equal((await fetchJson('/api/tasks?view=today', { headers: { Authorization: 'Bearer ' + access } })).status, 401);

    // tools: 読む → 更新 → 追記 → 完了
    const list = JSON.parse((await call('kairos_list_tasks', { view: 'today' })).text);
    assert.equal(list.tasks[0].name, '検証タスク');
    const got = JSON.parse((await call('kairos_get', { id })).text);
    assert.equal(got['名前'], '検証タスク');
    const upd = await call('kairos_update', { id, fields: { ステータス: '進行中' } });
    assert.equal(upd.isError, false, upd.text);
    assert.equal(JSON.parse((await call('kairos_get', { id, include_body: false })).text)['ステータス'], '進行中');
    const app = await call('kairos_append_body', { id, markdown: '## 結果\n- 日本語の追記' });
    assert.equal(app.isError, false, app.text);
    assert.match(JSON.parse((await call('kairos_get', { id })).text).body, /## 結果\n- 日本語の追記/);
    assert.equal((await call('kairos_update', { id, fields: { 完了: true } })).isError, true);
    const done = await call('kairos_task_action', { id, action: 'done' });
    assert.equal(done.isError, false, done.text);
    assert.equal(JSON.parse(done.text).task.done, true);
    assert.equal((await call('kairos_list_tasks', { view: 'today' })).text.includes('検証タスク'), false, '完了したので今日やるから消える');
    assert.equal(outbound, 0, '外へは出ない');
  } finally { await mf.dispose(); }
});
