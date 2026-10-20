import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { isMcpPath, mcpRoute } from '../src/mcp.js';

const ORIGIN = 'https://kairos.test';
const TOKEN = 'test-only-token';
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
const hex = (c) => c.repeat(32);
const DS = { tasks: hex('a'), projects: hex('b'), roles: hex('c'), decisions: hex('d') };
const SCHEMA = {
  [DS.tasks]: { 名前: { type: 'title' }, 完了: { type: 'checkbox' }, 完了日: { type: 'date' }, ステータス: { type: 'status', status: { options: [{ name: '未着手' }, { name: '進行中' }, { name: '人対応' }, { name: '完了' }] } }, 期日: { type: 'date' }, AIセッション: { type: 'url' }, 説明: { type: 'rich_text' }, ラベル: { type: 'multi_select', multi_select: { options: [{ name: 'Home' }] } } },
  [DS.projects]: { 名前: { type: 'title' }, 対応ゴール: { type: 'rich_text' }, ステータス: { type: 'status', status: { options: [{ name: '進行中' }, { name: '完了' }] } } },
  [DS.roles]: { 名前: { type: 'title' }, 今週の目標: { type: 'relation' } },
};
const pg = (id, name, done, st, proj) => ({ id, properties: { 名前: { type: 'title', title: [{ plain_text: name }] }, 完了: { type: 'checkbox', checkbox: done }, ステータス: { type: 'status', status: { name: st } }, 関連プロジェクト: { type: 'relation', relation: proj.map((x) => ({ id: x })) } } });
const QROWS = { [DS.tasks]: [pg(hex('4'), '終わった', true, '完了', [hex('9')]), pg(hex('5'), '開いている', false, '未着手', [hex('9')]), pg(hex('6'), '別PJ', false, '進行中', [hex('8')])] };
const PAGES = { [hex('1')]: DS.tasks, [hex('2')]: DS.projects, [hex('3')]: DS.roles };

// Worker 自身の API の代わり。呼ばれた内容を calls に残す
function fakeWorker() {
  const calls = [];
  const res = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
  const call = async (method, path, body) => {
    calls.push({ method, path, body });
    const p = path.split('?')[0];
    if (p === '/api/storage/sources') return res({ sources: Object.entries(DS).map(([collection, id]) => ({ collection, id })) });
    if (method === 'POST' && p.endsWith('/query')) return res({ results: QROWS[p.split('/')[4]] ?? [], has_more: false });
    let m = p.match(/^\/api\/data\/data_sources\/([0-9a-f]{32})$/);
    if (m) return res({ properties: SCHEMA[m[1]] ?? {} });
    m = p.match(/^\/api\/data\/pages\/([0-9a-f]{32})$/);
    if (m && method === 'GET') return res({ id: m[1], parent: { data_source_id: PAGES[m[1]] }, properties: { 名前: { type: 'title', title: [{ plain_text: '検証' }] } } });
    if (m && method === 'PATCH') return res({ id: m[1], properties: { 名前: { type: 'title', title: [{ plain_text: '検証' }] } } });
    if (/^\/api\/data\/blocks\/[0-9a-f]{32}\/children$/.test(p)) return res({ results: [] });
    if (/^\/api\/tasks\/[0-9a-f]{32}\/(done|skip|reopen|human|ai-clear)$/.test(p)) return res({ task: { id: p.split('/')[3], status: '完了', done: true } });
    return res({ error: 'not found' }, 404);
  };
  return { call, calls };
}

const cookieAuth = (req) => (req.headers.get('Cookie') ?? '').includes('tp=' + TOKEN);
const safeEq = (a, b) => a === b;

function setup(envExtra = {}) {
  const env = { APP_TOKEN: TOKEN, ...envExtra };
  const fw = fakeWorker();
  const deps = { call: fw.call, authed: cookieAuth, safeEq };
  const send = (path, init = {}) => { const url = new URL(ORIGIN + path); return mcpRoute(new Request(url, init), env, url, deps); };
  return { env, fw, send };
}

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const pkce = () => { const verifier = b64u(randomBytes(40)); return { verifier, challenge: b64u(createHash('sha256').update(verifier).digest()) }; };
const form = (o) => ({ method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: ORIGIN, Cookie: 'tp=' + TOKEN }, body: new URLSearchParams(o).toString() });

async function registerClient(send, redirect = REDIRECT) {
  const r = await send('/oauth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_name: 'Claude', redirect_uris: [redirect], token_endpoint_auth_method: 'none' }) });
  return { status: r.status, body: await r.json() };
}

// 登録 → 同意 → コード → トークン まで通す
async function connect(send) {
  const { body: client } = await registerClient(send);
  const { verifier, challenge } = pkce();
  const q = new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', state: 'xyz', resource: ORIGIN + '/mcp' });
  const page = await send('/authorize?' + q, { headers: { Cookie: 'tp=' + TOKEN } });
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /許可する/);
  assert.doesNotMatch(html, /type="password"/, 'Cookie があれば APP_TOKEN は聞かない');
  const areq = html.match(/name="areq" value="([^"]+)"/)[1];
  const approve = await send('/authorize', form({ areq, decision: 'allow' }));
  assert.equal(approve.status, 303);
  const loc = new URL(approve.headers.get('Location'));
  assert.equal(loc.origin + loc.pathname, REDIRECT);
  assert.equal(loc.searchParams.get('state'), 'xyz');
  const code = loc.searchParams.get('code');
  const tok = await send('/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: client.client_id, redirect_uri: REDIRECT, code_verifier: verifier }).toString() });
  assert.equal(tok.status, 200);
  return { client, code, verifier, tokens: await tok.json() };
}

const rpc = async (send, token, method, params, id = 1) => {
  const r = await send('/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
  return { status: r.status, json: r.status === 200 ? await r.json() : null, res: r };
};
const tool = async (send, token, name, args) => {
  const { json } = await rpc(send, token, 'tools/call', { name, arguments: args });
  return { isError: !!json.result.isError, text: json.result.content[0].text };
};

test('MCP のパスだけを横取りする', () => {
  for (const p of ['/mcp', '/authorize', '/oauth/token', '/oauth/register', '/.well-known/oauth-protected-resource', '/.well-known/oauth-authorization-server']) assert.equal(isMcpPath(p), true, p);
  for (const p of ['/', '/api/tasks', '/health', '/sw.js', '/api/storage/agent']) assert.equal(isMcpPath(p), false, p);
});

test('メタデータは認証なしで読め、PKCE S256 と公開クライアントを示す', async () => {
  const { send } = setup();
  const as = await (await send('/.well-known/oauth-authorization-server')).json();
  assert.equal(as.issuer, ORIGIN);
  assert.deepEqual(as.code_challenge_methods_supported, ['S256']);
  assert.equal(as.registration_endpoint, ORIGIN + '/oauth/register');
  const pr = await (await send('/.well-known/oauth-protected-resource')).json();
  assert.equal(pr.resource, ORIGIN + '/mcp');
  assert.deepEqual(pr.authorization_servers, [ORIGIN]);
});

test('クライアント登録は claude.ai / claude.com / ループバックの redirect_uri だけ許す', async () => {
  const { send } = setup();
  assert.equal((await registerClient(send)).status, 201);
  assert.equal((await registerClient(send, 'https://claude.com/api/mcp/auth_callback')).status, 201);
  assert.equal((await registerClient(send, 'http://localhost:6274/oauth/callback')).status, 201);
  for (const bad of ['https://evil.example/cb', 'https://claude.ai.evil.example/api/mcp/auth_callback', 'http://claude.ai/api/mcp/auth_callback', 'https://claude.ai/other'])
    assert.equal((await registerClient(send, bad)).status, 400, bad);
});

test('登録→同意→コード→トークン→MCP の一連が通り、リフレッシュもできる', async () => {
  const { send } = setup();
  const { client, tokens } = await connect(send);
  assert.equal(tokens.token_type, 'Bearer');
  assert.equal(tokens.expires_in, 3600);
  const init = await rpc(send, tokens.access_token, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  assert.equal(init.status, 200);
  assert.equal(init.json.result.protocolVersion, '2025-06-18');
  assert.equal(init.json.result.serverInfo.name, 'kairos');
  const list = await rpc(send, tokens.access_token, 'tools/list', undefined, 2);
  const names = list.json.result.tools.map((t) => t.name);
  assert.ok(names.includes('kairos_task_action') && names.includes('kairos_append_body'));
  assert.ok(!names.some((n) => /delete|archive|remove/.test(n)), '削除する道具は置かない');
  const refreshed = await send('/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.client_id }).toString() });
  assert.equal(refreshed.status, 200);
  assert.equal((await rpc(send, (await refreshed.json()).access_token, 'ping', undefined, 3)).status, 200);
});

test('通知には 202 を返し、未知のメソッドとツールはエラーにする', async () => {
  const { send } = setup();
  const { tokens } = await connect(send);
  const note = await send('/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tokens.access_token }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
  assert.equal(note.status, 202);
  assert.equal((await rpc(send, tokens.access_token, 'nope')).json.error.code, -32601);
  assert.equal((await rpc(send, tokens.access_token, 'tools/call', { name: 'kairos_delete', arguments: {} })).json.error.code, -32602);
});

test('トークンなし・偽物・取り違えは 401 で、リソースメタデータの場所を返す', async () => {
  const { send, env } = setup();
  const none = await send('/mcp', { method: 'POST', body: '{}' });
  assert.equal(none.status, 401);
  assert.match(none.headers.get('WWW-Authenticate'), /resource_metadata="https:\/\/kairos\.test\/\.well-known\/oauth-protected-resource"/);
  assert.equal((await rpc(send, 'x.y', 'ping')).status, 401);
  assert.equal((await rpc(send, TOKEN, 'ping')).status, 401, 'APP_TOKEN そのものを MCP のトークンとしては受けない');
  const { tokens, code } = await connect(send);
  assert.equal((await rpc(send, tokens.refresh_token, 'ping')).status, 401, 'refresh を access として使えない');
  assert.equal((await rpc(send, code, 'ping')).status, 401, 'code を access として使えない');
  const [body, sig] = tokens.access_token.split('.');
  assert.equal((await rpc(send, body + '.' + sig.slice(0, -2) + 'AA', 'ping')).status, 401, '署名が壊れたら通さない');
  assert.equal((await rpc(send, tokens.access_token, 'ping')).status, 200);
  const other = setup({ MCP_EPOCH: '2' });
  assert.equal((await rpc(other.send, tokens.access_token, 'ping')).status, 401, 'MCP_EPOCH を替えると発行済みトークンは全部無効');
  const rotated = setup({ APP_TOKEN: 'rotated' });
  assert.equal((await rpc(rotated.send, tokens.access_token, 'ping')).status, 401, 'APP_TOKEN を替えても無効');
  assert.equal(env.APP_TOKEN, TOKEN);
});

test('/mcp は POST 以外を断り、許可外の Origin を断る', async () => {
  const { send } = setup();
  const { tokens } = await connect(send);
  const get = await send('/mcp', { headers: { Authorization: 'Bearer ' + tokens.access_token } });
  assert.equal(get.status, 405);
  const evil = await send('/mcp', { method: 'POST', headers: { Authorization: 'Bearer ' + tokens.access_token, Origin: 'https://evil.example', 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(evil.status, 403);
});

test('認可: PKCE の検証・コードの期限・取り違えを防ぐ', async () => {
  const { send } = setup();
  const { client } = await connect(send);
  const mk = async () => {
    const { verifier, challenge } = pkce();
    const q = new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256' });
    const html = await (await send('/authorize?' + q, { headers: { Cookie: 'tp=' + TOKEN } })).text();
    const areq = html.match(/name="areq" value="([^"]+)"/)[1];
    const code = new URL((await send('/authorize', form({ areq, decision: 'allow' }))).headers.get('Location')).searchParams.get('code');
    return { verifier, code };
  };
  const exchange = (o) => send('/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', client_id: client.client_id, redirect_uri: REDIRECT, ...o }).toString() });
  const a = await mk();
  assert.equal((await exchange({ code: a.code, code_verifier: pkce().verifier })).status, 400, '別の verifier は不可');
  assert.equal((await exchange({ code: a.code, code_verifier: a.verifier, redirect_uri: 'https://claude.com/api/mcp/auth_callback' })).status, 400, 'redirect_uri が違えば不可');
  assert.equal((await exchange({ code: a.code, code_verifier: a.verifier, client_id: 'other' })).status, 400, 'client_id が違えば不可');
  assert.equal((await exchange({ code: a.code, code_verifier: 'short' })).status, 400);
  assert.equal((await exchange({ code: a.code, code_verifier: a.verifier })).status, 200);
  const b = await mk();
  const realNow = Date.now;
  Date.now = () => realNow() + 61 * 1000;
  try { assert.equal((await exchange({ code: b.code, code_verifier: b.verifier })).status, 400, '60 秒を過ぎたコードは不可'); } finally { Date.now = realNow; }
  const c1 = await mk(), c2 = await mk();
  const mixed = await exchange({ code: c1.code, code_verifier: c2.verifier });
  assert.equal(mixed.status, 400, '別のやり取りの verifier とは組めない');
  assert.equal((await mixed.json()).error, 'invalid_grant');
});

test('アクセストークンは 1 時間で切れる', async () => {
  const { send } = setup();
  const { tokens } = await connect(send);
  const realNow = Date.now;
  Date.now = () => realNow() + 3601 * 1000;
  try { assert.equal((await rpc(send, tokens.access_token, 'ping')).status, 401); } finally { Date.now = realNow; }
});

test('同意画面: Cookie が無ければ APP_TOKEN を聞き、違えば通さず、Origin が違う POST は断る', async () => {
  const { send } = setup();
  const { body: client } = await registerClient(send);
  const { challenge } = pkce();
  const q = new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256' });
  const html = await (await send('/authorize?' + q)).text();
  assert.match(html, /type="password"/);
  const areq = html.match(/name="areq" value="([^"]+)"/)[1];
  const noCookie = (o, origin = ORIGIN) => ({ method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: origin }, body: new URLSearchParams(o).toString() });
  assert.equal((await send('/authorize', noCookie({ areq, decision: 'allow', token: 'wrong' }))).status, 401);
  assert.equal((await send('/authorize', noCookie({ areq, decision: 'allow', token: TOKEN }, 'https://evil.example'))).status, 403);
  const ok = await send('/authorize', noCookie({ areq, decision: 'allow', token: TOKEN }));
  assert.equal(ok.status, 303);
  const denied = await send('/authorize', form({ areq, decision: 'deny' }));
  assert.equal(new URL(denied.headers.get('Location')).searchParams.get('error'), 'access_denied');
});

test('認可リクエストの入口: 未登録の client・登録外の redirect_uri・PKCE なしを断る', async () => {
  const { send } = setup();
  const { body: client } = await registerClient(send);
  const { challenge } = pkce();
  const base = { response_type: 'code', client_id: client.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256' };
  assert.equal((await send('/authorize?' + new URLSearchParams({ ...base, client_id: 'forged' }))).status, 400);
  assert.equal((await send('/authorize?' + new URLSearchParams({ ...base, redirect_uri: 'https://claude.com/api/mcp/auth_callback' }))).status, 400);
  const noPkce = await send('/authorize?' + new URLSearchParams({ ...base, code_challenge: '' }));
  assert.equal(noPkce.status, 302);
  assert.equal(new URL(noPkce.headers.get('Location')).searchParams.get('error'), 'invalid_request');
  const plain = await send('/authorize?' + new URLSearchParams({ ...base, code_challenge_method: 'plain' }));
  assert.equal(new URL(plain.headers.get('Location')).searchParams.get('error'), 'invalid_request');
  const wrongRes = await send('/authorize?' + new URLSearchParams({ ...base, resource: 'https://other.example/mcp' }));
  assert.equal(new URL(wrongRes.headers.get('Location')).searchParams.get('error'), 'invalid_target');
});

test('tools: 完了は done 経由、Roles/Projects は決まった列だけ、id は検証する', async () => {
  const { send, fw } = setup();
  const { tokens } = await connect(send);
  const t = tokens.access_token;
  const done = await tool(send, t, 'kairos_task_action', { id: hex('1'), action: 'done', note: '退避先を削除した' });
  assert.equal(done.isError, false);
  assert.deepEqual(fw.calls.at(-1), { method: 'POST', path: `/api/tasks/${hex('1')}/done?note=${encodeURIComponent('退避先を削除した')}`, body: {} });
  await tool(send, t, 'kairos_task_action', { id: hex('1'), action: 'ai_clear' });
  assert.equal(fw.calls.at(-1).path, `/api/tasks/${hex('1')}/ai-clear`);
  assert.equal((await tool(send, t, 'kairos_task_action', { id: hex('1'), action: 'delete' })).isError, true);
  assert.equal((await tool(send, t, 'kairos_task_action', { id: '../../etc', action: 'done' })).isError, true);

  const before = fw.calls.length;
  const direct = await tool(send, t, 'kairos_update', { id: hex('1'), fields: { 完了: true } });
  assert.equal(direct.isError, true);
  assert.match(direct.text, /kairos_task_action/);
  assert.equal((await tool(send, t, 'kairos_update', { id: hex('1'), fields: { ステータス: '完了' } })).isError, true);
  assert.equal((await tool(send, t, 'kairos_update', { id: hex('3'), fields: { 名前: '改名' } })).isError, true, 'Roles は 今週の目標 だけ');
  assert.equal((await tool(send, t, 'kairos_update', { id: hex('2'), fields: { 開始日: '2026-11-01' } })).isError, true, 'Projects は ステータス・対応ゴール・完了条件・役割・名前 だけ');
  assert.equal(fw.calls.slice(before).some((c) => c.method === 'PATCH'), false, '拒否した更新は書き込まない');
  assert.equal((await tool(send, t, 'kairos_update', { id: hex('2'), fields: { 名前: '改名' } })).isError, false, 'Projects の 名前 は書ける');
  assert.equal((await tool(send, t, 'kairos_update', { id: hex('2'), fields: { ステータス: '完了' } })).isError, false);
  assert.equal((await tool(send, t, 'kairos_update', { id: hex('2'), fields: { 対応ゴール: 'テスト' } })).isError, false, 'Projects の 対応ゴール は書ける');
});

test('tools: 空にする更新は列の型どおりの形で送り、選択肢にない値は断る', async () => {
  const { send, fw } = setup();
  const { tokens } = await connect(send);
  const t = tokens.access_token;
  const ok = await tool(send, t, 'kairos_update', { id: hex('1'), fields: { 期日: null, ラベル: null, AIセッション: 'https://claude.ai/chat/abc', ステータス: '人対応', 説明: 'あ'.repeat(4000) } });
  assert.equal(ok.isError, false, ok.text);
  const patch = fw.calls.filter((c) => c.method === 'PATCH').at(-1).body.properties;
  assert.deepEqual(patch['期日'], { date: null });
  assert.deepEqual(patch['ラベル'], { multi_select: [] });
  assert.deepEqual(patch['AIセッション'], { url: 'https://claude.ai/chat/abc' });
  assert.deepEqual(patch['ステータス'], { status: { name: '人対応' } });
  assert.equal(patch['説明'].rich_text.length, 3, '1900 字ずつに分けて、長い説明を切り捨てない');
  const bad = await tool(send, t, 'kairos_update', { id: hex('1'), fields: { ステータス: '存在しない' } });
  assert.equal(bad.isError, true);
  assert.match(bad.text, /選択肢/);
  assert.equal((await tool(send, t, 'kairos_update', { id: hex('1'), fields: { 無い列: 'x' } })).isError, true);
});

test('tools: 本文追記は見出し・箇条書き・長い行を落とさずブロックにする', async () => {
  const { send, fw } = setup();
  const { tokens } = await connect(send);
  const long = 'あ'.repeat(2500);
  const r = await tool(send, tokens.access_token, 'kairos_append_body', { id: hex('1'), markdown: `## 結果\n- 一つ目\n1. 手順\n- [x] 済み\n\n${long}` });
  assert.equal(r.isError, false, r.text);
  const blocks = fw.calls.at(-1).body.children;
  assert.deepEqual(blocks.map((b) => b.type), ['heading_2', 'bulleted_list_item', 'numbered_list_item', 'to_do', 'paragraph']);
  assert.equal(blocks[3].to_do.checked, true);
  assert.equal(blocks[4].paragraph.rich_text.map((x) => x.text.content).join('').length, 2500);
  assert.equal((await tool(send, tokens.access_token, 'kairos_append_body', { id: hex('1'), markdown: '   \n\n' })).isError, true);
});

test('tools: kairos_query は columns で絞っても where と open_only を全プロパティで判定する', async () => {
  const { send } = setup();
  const { tokens } = await connect(send);
  const q = async (args) => JSON.parse((await tool(send, tokens.access_token, 'kairos_query', { database: 'tasks', ...args })).text);
  const byProj = await q({ where: { 関連プロジェクト: hex('9') }, columns: ['名前'] });
  assert.deepEqual(byProj.map((r) => r['名前']).sort(), ['終わった', '開いている']);
  const open = await q({ open_only: true, columns: ['名前'] });
  assert.deepEqual(open.map((r) => r['名前']).sort(), ['別PJ', '開いている']);
  const both = await q({ open_only: true, where: { 関連プロジェクト: hex('9') }, columns: ['名前'] });
  assert.deepEqual(both.map((r) => r['名前']), ['開いている']);
  assert.deepEqual(Object.keys(both[0]).sort(), ['id', '名前'], 'columns に無い列は返さない');
  const byStatus = await q({ where: { ステータス: '進行中' }, columns: ['名前'] });
  assert.deepEqual(byStatus.map((r) => r['名前']), ['別PJ']);
});
