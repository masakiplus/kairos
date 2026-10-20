// Kairos MCP コネクタ (2026-10-19)。claude.ai などの MCP クライアントが OAuth でつなぐ入口。設計は docs/mcp.md。
//
// 方針:
// - 状態を持たない。client_id・認可コード・アクセストークン・リフレッシュトークンは、APP_TOKEN から導いた鍵で HMAC 署名した文字列
//   (D1 を読み書きしない)。APP_TOKEN を替える、または秘密 MCP_EPOCH を替えると、発行済みの MCP トークンは全部無効になる。
// - MCP のトークンでは /api/* を直接は呼べない。使えるのは下の tools だけ。削除する道具は置かない。
// - tools は Worker 自身の API (/api/*) を内部呼び出しで使う。APP_TOKEN は Worker の外へ出ない。
// - 認可の同意は人が行う: 既存の Kairos Cookie がある端末なら「許可」ボタンだけ、無ければ APP_TOKEN を入力。

const ENC = new TextEncoder();
const VERSION = "1.0.0";
const PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const ACCESS_TTL = 60 * 60; // 秒
const REFRESH_TTL = 60 * 60 * 24 * 60;
const CODE_TTL = 60;
const AREQ_TTL = 60 * 10;
const MAX_TEXT = 80000;
const MAX_BODY = 200000;
const SCOPE = "kairos";

// 同意後にコードを返してよい先。claude.ai / claude.com の MCP コールバックと、検査用のループバックだけ
const REDIRECTS = [
  /^https:\/\/claude\.ai\/api\/mcp\/auth_callback$/,
  /^https:\/\/claude\.com\/api\/mcp\/auth_callback$/,
  /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?\/[\w\-./]*$/,
];
const ORIGINS = [/^https:\/\/(www\.)?claude\.(ai|com)$/, /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/];

const nowSec = () => Math.floor(Date.now() / 1000);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ---------- 署名 ----------
const b64u = (buf) => {
  let s = "";
  for (const x of new Uint8Array(buf)) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const unb64u = (s) => {
  const t = String(s).replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(t + "=".repeat((4 - (t.length % 4)) % 4)), (c) => c.charCodeAt(0));
};

async function hmacKey(env, usages) {
  const base = await crypto.subtle.importKey("raw", ENC.encode(String(env.APP_TOKEN)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const raw = await crypto.subtle.sign("HMAC", base, ENC.encode("kairos-mcp-oauth-v1:" + (env.MCP_EPOCH ?? "")));
  return crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, usages);
}

async function sign(env, payload) {
  const body = b64u(ENC.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(env, ["sign"]), ENC.encode(body));
  return body + "." + b64u(sig);
}

// 種類 (typ) と期限 (exp, 秒) まで確かめる。code を access として使い回す、のような取り違えを防ぐ
async function verify(env, token, typ) {
  try {
    const [body, sig, extra] = String(token ?? "").split(".");
    if (!body || !sig || extra !== undefined || body.length > 4000) return null;
    if (!(await crypto.subtle.verify("HMAC", await hmacKey(env, ["verify"]), unb64u(sig), ENC.encode(body)))) return null;
    const p = JSON.parse(new TextDecoder().decode(unb64u(body)));
    if (p.typ !== typ) return null;
    if (p.exp && p.exp < nowSec()) return null;
    return p;
  } catch {
    return null;
  }
}

// ---------- 応答の部品 ----------
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, Accept, Mcp-Session-Id, MCP-Protocol-Version",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Expose-Headers": "WWW-Authenticate, Mcp-Session-Id",
};
const jsonRes = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...extra } });

function htmlPage(title, body, status = 200) {
  const css =
    "body{font-family:-apple-system,system-ui,sans-serif;max-width:520px;margin:0 auto;padding:24px 16px;line-height:1.6;color:#1a1a1a;background:#fff}" +
    "@media(prefers-color-scheme:dark){body{color:#eee;background:#161616}input{background:#222;color:#eee}}" +
    "h1{font-size:20px}button{font-size:16px;padding:12px 20px;margin:6px 8px 6px 0;border-radius:8px;border:1px solid #888;background:transparent;color:inherit}" +
    "button.p{background:#0b57d0;border-color:#0b57d0;color:#fff}input{font-size:16px;padding:10px;width:100%;box-sizing:border-box;border-radius:8px;border:1px solid #888}.e{color:#c5221f}small{opacity:.7}";
  return new Response(`<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${css}</style><body>${body}</body></html>`, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Frame-Options": "DENY",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
    },
  });
}

function redirectTo(target, params, status = 302) {
  const u = new URL(target);
  for (const [k, v] of Object.entries(params)) if (v !== null && v !== undefined && v !== "") u.searchParams.set(k, v);
  return new Response(null, { status, headers: { Location: u.toString(), "Cache-Control": "no-store" } });
}

const oauthError = (error, description, status = 400) => jsonRes({ error, error_description: description }, status, { Pragma: "no-cache" });

// ---------- OAuth ----------
const authServerMeta = (o) => ({
  issuer: o,
  authorization_endpoint: o + "/authorize",
  token_endpoint: o + "/oauth/token",
  registration_endpoint: o + "/oauth/register",
  response_types_supported: ["code"],
  grant_types_supported: ["authorization_code", "refresh_token"],
  code_challenge_methods_supported: ["S256"],
  token_endpoint_auth_methods_supported: ["none"],
  scopes_supported: [SCOPE],
});
const resourceMeta = (o) => ({ resource: o + "/mcp", authorization_servers: [o], bearer_methods_supported: ["header"], scopes_supported: [SCOPE], resource_name: "Kairos" });

async function register(req, env) {
  const text = await req.text();
  if (text.length > 8000) return oauthError("invalid_client_metadata", "too large");
  let m;
  try { m = JSON.parse(text); } catch { return oauthError("invalid_client_metadata", "JSON が読めません"); }
  const uris = Array.isArray(m.redirect_uris) ? m.redirect_uris.map(String) : [];
  if (!uris.length || uris.length > 5) return oauthError("invalid_redirect_uri", "redirect_uris は 1〜5 件");
  const bad = uris.filter((u) => !REDIRECTS.some((re) => re.test(u)));
  if (bad.length) return oauthError("invalid_redirect_uri", "許可していない redirect_uri: " + bad.join(", ").slice(0, 200));
  const name = String(m.client_name ?? "MCP client").slice(0, 80);
  const iat = nowSec();
  const client_id = await sign(env, { typ: "client", ru: uris, name, iat });
  return jsonRes(
    { client_id, client_id_issued_at: iat, client_name: name, redirect_uris: uris, grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none", scope: SCOPE },
    201,
    { Pragma: "no-cache" }
  );
}

function consentPage({ areq, clientName, human, error }) {
  const ask = human
    ? ""
    : `<p><label>Kairos のトークン (APP_TOKEN)<br><input type="password" name="token" autocomplete="current-password" required></label></p>`;
  return htmlPage(
    "Kairos への接続",
    `<h1>Kairos に接続しますか？</h1>` +
      `<p><b>${esc(clientName)}</b> が、あなたのタスク・判断・習慣を読み書きできるようになります。タスクの削除はできません。</p>` +
      (error ? `<p class="e">${esc(error)}</p>` : "") +
      `<form method="post" action="/authorize"><input type="hidden" name="areq" value="${esc(areq)}">${ask}` +
      `<button class="p" name="decision" value="allow">許可する</button><button name="decision" value="deny" formnovalidate>やめる</button></form>` +
      `<p><small>心当たりがなければ「やめる」を押してください。あとで取り消すときは、Kairos の MCP_EPOCH を替えます（docs/mcp.md）。</small></p>`,
    error ? 401 : 200
  );
}

async function authorizeGet(req, env, url, deps) {
  const q = url.searchParams;
  const clientId = q.get("client_id") ?? "";
  const client = await verify(env, clientId, "client");
  if (!client) return htmlPage("エラー", "<p>client_id が正しくありません。コネクタを登録し直してください。</p>", 400);
  const ru = q.get("redirect_uri") ?? "";
  if (!client.ru.includes(ru)) return htmlPage("エラー", "<p>redirect_uri が登録と一致しません。</p>", 400);
  const state = (q.get("state") ?? "").slice(0, 512);
  const fail = (error, description) => redirectTo(ru, { error, error_description: description, state });
  if (q.get("response_type") !== "code") return fail("unsupported_response_type", "response_type=code のみ");
  const ch = q.get("code_challenge") ?? "";
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(ch) || (q.get("code_challenge_method") ?? "") !== "S256") return fail("invalid_request", "PKCE (S256) が必要です");
  const resource = q.get("resource");
  if (resource && resource !== url.origin && resource !== url.origin + "/mcp") return fail("invalid_target", "resource が違います");
  const areq = await sign(env, { typ: "areq", cid: clientId, ru, ch, st: state, exp: nowSec() + AREQ_TTL });
  return consentPage({ areq, clientName: client.name, human: deps.authed(req) });
}

async function authorizePost(req, env, url, deps) {
  if (req.headers.get("Origin") !== url.origin) return htmlPage("エラー", "<p>不正なリクエストです。</p>", 403);
  let form;
  try { form = await req.formData(); } catch { return htmlPage("エラー", "<p>フォームが読めません。</p>", 400); }
  const areqRaw = String(form.get("areq") ?? "");
  const a = await verify(env, areqRaw, "areq");
  if (!a) return htmlPage("エラー", "<p>接続の手続きの有効期限が切れました。コネクタからもう一度つないでください。</p>", 400);
  if (form.get("decision") !== "allow") return redirectTo(a.ru, { error: "access_denied", error_description: "user denied", state: a.st });
  const human = deps.authed(req) || deps.safeEq(String(form.get("token") ?? ""), env.APP_TOKEN);
  if (!human) {
    const client = await verify(env, a.cid, "client");
    return consentPage({ areq: areqRaw, clientName: client?.name ?? "MCP client", human: false, error: "トークンが違います。" });
  }
  const code = await sign(env, { typ: "code", cid: a.cid, ru: a.ru, ch: a.ch, exp: nowSec() + CODE_TTL });
  return redirectTo(a.ru, { code, state: a.st }, 303);
}

async function issueTokens(env, cid) {
  const t = nowSec();
  return jsonRes(
    {
      access_token: await sign(env, { typ: "access", cid, exp: t + ACCESS_TTL }),
      token_type: "Bearer",
      expires_in: ACCESS_TTL,
      refresh_token: await sign(env, { typ: "refresh", cid, exp: t + REFRESH_TTL }),
      scope: SCOPE,
    },
    200,
    { Pragma: "no-cache" }
  );
}

async function tokenPost(req, env) {
  let p = {};
  try {
    p = (req.headers.get("Content-Type") ?? "").includes("json") ? await req.json() : Object.fromEntries(await req.formData());
  } catch {
    return oauthError("invalid_request", "本文が読めません");
  }
  const bad = (d) => oauthError("invalid_grant", d);
  if (p.grant_type === "authorization_code") {
    const c = await verify(env, p.code, "code");
    if (!c) return bad("code が無効か、期限切れです");
    if (!p.client_id || p.client_id !== c.cid) return bad("client_id が一致しません");
    if (!p.redirect_uri || p.redirect_uri !== c.ru) return bad("redirect_uri が一致しません");
    const v = String(p.code_verifier ?? "");
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(v)) return bad("code_verifier が不正です");
    if (b64u(await crypto.subtle.digest("SHA-256", ENC.encode(v))) !== c.ch) return bad("PKCE の検証に失敗しました");
    return issueTokens(env, c.cid);
  }
  if (p.grant_type === "refresh_token") {
    const r = await verify(env, p.refresh_token, "refresh");
    if (!r || (p.client_id && p.client_id !== r.cid)) return bad("refresh_token が無効か、期限切れです");
    return issueTokens(env, r.cid);
  }
  return oauthError("unsupported_grant_type", "authorization_code か refresh_token");
}

// ---------- tools に使う部品 ----------
const clean = (s) => String(s ?? "").replace(/-/g, "").toLowerCase();
const normName = (s) => String(s ?? "").toLowerCase().replace(/[\s_-]/g, "");
const ID_RE = /^[0-9a-f-]{32,36}$/i;

function reqId(id) {
  if (!ID_RE.test(String(id ?? ""))) throw new Error("id は 32 桁の 16 進（ハイフン可）で指定してください");
  return clean(id);
}

async function api(ctx, method, path, body) {
  const res = await ctx.call(method, path, body);
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text.slice(0, 300) }; }
  if (!res.ok) throw new Error(`Kairos ${method} ${path.split("?")[0]}: HTTP ${res.status} ${(data.error ?? text).toString().slice(0, 300)}`);
  return data;
}

async function sources(ctx) {
  if (!ctx.src) {
    const r = await api(ctx, "GET", "/api/storage/sources");
    ctx.src = new Map((r.sources ?? []).map((s) => [normName(s.collection), clean(s.id)]));
  }
  return ctx.src;
}

async function dsOf(ctx, name) {
  const want = normName(name), src = await sources(ctx);
  if (src.has(want)) return src.get(want);
  for (const [n, ds] of src) if (n.startsWith(want) || want.startsWith(n)) return ds;
  throw new Error(`DB が見つかりません: ${name}（候補: ${[...src.keys()].join(", ")}）`);
}

async function collectionOf(ctx, ds) {
  for (const [n, id] of await sources(ctx)) if (id === clean(ds)) return n;
  return "";
}

async function schemaOf(ctx, ds) {
  ctx.schemas ??= new Map();
  if (!ctx.schemas.has(ds)) ctx.schemas.set(ds, (await api(ctx, "GET", `/api/data/data_sources/${ds}`)).properties ?? {});
  return ctx.schemas.get(ds);
}

function plain(p) {
  const t = p?.type, v = p?.[t];
  if (t === "title" || t === "rich_text") return (v ?? []).map((x) => x.plain_text ?? x.text?.content ?? "").join("") || null;
  if (t === "select" || t === "status") return v?.name ?? null;
  if (t === "multi_select") return (v ?? []).map((x) => x.name);
  if (t === "date") return v ? (v.end ? `${v.start}〜${v.end}` : v.start) : null;
  if (t === "relation") return (v ?? []).map((x) => x.id);
  if (t === "people") return (v ?? []).map((x) => x.name ?? x.id);
  if (t === "formula") { const val = v?.[v?.type]; return val && typeof val === "object" ? val.start : val; }
  if (t === "rollup") return v?.type === "array" ? (v.array ?? []).length : v?.[v?.type];
  return v;
}

function flat(page, { cols, truncate = 0 } = {}) {
  const out = { id: page.id };
  if (page.icon?.emoji) out.icon = page.icon.emoji;
  for (const [name, p] of Object.entries(page.properties ?? {})) {
    if (cols && !cols.includes(name)) continue;
    let val = plain(p);
    if (val === null || val === undefined || val === "" || val === false || (Array.isArray(val) && !val.length)) continue;
    if (truncate && typeof val === "string" && val.length > truncate) val = val.slice(0, truncate) + "…";
    out[name] = val;
  }
  return out;
}

const CLEARED = { title: [], rich_text: [], select: null, status: null, multi_select: [], date: null, relation: [], number: null, checkbox: false, url: null };

function toProp(schema, name, val) {
  const def = schema[name];
  if (!def) throw new Error(`プロパティがありません: ${name}（kairos_schema で確認できます）`);
  const t = def.type;
  if (!(t in CLEARED)) throw new Error(`${name}（${t}）は書けません（計算列など）`);
  if (val === null) return { [t]: CLEARED[t] };
  const opts = (def[t]?.options ?? []).map((o) => o.name);
  if (t === "title" || t === "rich_text") {
    const s = String(val), parts = [];
    for (let i = 0; i < s.length; i += 1900) parts.push({ type: "text", text: { content: s.slice(i, i + 1900) } });
    return { [t]: parts };
  }
  if (t === "select" || t === "status") {
    if (opts.length && !opts.includes(val)) throw new Error(`${name} に選択肢 ${JSON.stringify(val)} はありません（${opts.join("、")}）`);
    return { [t]: { name: String(val) } };
  }
  if (t === "multi_select") {
    const vals = Array.isArray(val) ? val : [val], badOpts = vals.filter((x) => !opts.includes(x));
    if (badOpts.length) throw new Error(`${name} に選択肢 ${JSON.stringify(badOpts)} はありません（${opts.join("、")}）`);
    return { [t]: vals.map((name2) => ({ name: String(name2) })) };
  }
  if (t === "date") return { date: typeof val === "object" ? val : { start: String(val) } };
  if (t === "relation") {
    const ids = (Array.isArray(val) ? val : [val]).map((x) => {
      const m = String(x).replace(/-/g, "").toLowerCase().match(/[0-9a-f]{32}/);
      if (!m) throw new Error(`${name} の ID が読めません: ${x}`);
      return { id: m[0] };
    });
    return { relation: ids };
  }
  if (t === "number") { const n = Number(val); if (!Number.isFinite(n)) throw new Error(`${name} は数値で指定してください`); return { number: n }; }
  if (t === "checkbox") return { checkbox: val === true || String(val).toLowerCase() === "true" };
  return { url: String(val) };
}

const MD_PREFIXES = [["### ", "heading_3"], ["## ", "heading_2"], ["# ", "heading_1"], ["- [ ] ", "to_do"], ["- [x] ", "to_do"], ["- ", "bulleted_list_item"], ["* ", "bulleted_list_item"], ["> ", "quote"]];

function mdBlocks(md) {
  const blocks = [];
  for (const line of String(md ?? "").split(/\r?\n/)) {
    const s = line.replace(/\s+$/, "");
    if (!s.trim()) continue;
    const t = s.trimStart();
    let typ = "paragraph", text = s;
    const hit = MD_PREFIXES.find(([p]) => t.startsWith(p));
    if (hit) { typ = hit[1]; text = t.slice(hit[0].length); }
    else { const m = s.match(/^\s*\d+\.\s+(.*)/); if (m) { typ = "numbered_list_item"; text = m[1]; } }
    const rich = [];
    for (let i = 0; i < text.length || !rich.length; i += 1900) rich.push({ type: "text", text: { content: text.slice(i, i + 1900) } });
    const b = { object: "block", type: typ, [typ]: { rich_text: rich } };
    if (typ === "to_do") b[typ].checked = t.startsWith("- [x] ");
    blocks.push(b);
  }
  return blocks;
}

function blockText(b) {
  const t = b.type, v = b[t] ?? {};
  const txt = (v.rich_text ?? []).map((x) => x.plain_text ?? x.text?.content ?? "").join("");
  const pre = { heading_1: "# ", heading_2: "## ", heading_3: "### ", bulleted_list_item: "- ", numbered_list_item: "1. ", to_do: v.checked ? "- [x] " : "- [ ] ", quote: "> " }[t] ?? "";
  if (t === "child_page") return `[子ページ] ${v.title ?? ""} (${b.id})`;
  if (t === "child_database") return `[子DB] ${v.title ?? ""} (${b.id})`;
  return txt || pre ? pre + txt : `[${t}]`;
}

async function bodyMd(ctx, id, depth = 0) {
  const lines = [];
  let cursor = null;
  for (let guard = 0; guard < 20; guard++) {
    const r = await api(ctx, "GET", `/api/data/blocks/${id}/children?page_size=100${cursor ? "&start_cursor=" + encodeURIComponent(cursor) : ""}`);
    for (const b of r.results ?? []) {
      lines.push("  ".repeat(depth) + blockText(b));
      if (b.has_children && !["child_page", "child_database"].includes(b.type) && depth < 2) {
        try { lines.push(...(await bodyMd(ctx, b.id, depth + 1))); } catch { /* 子ブロックが読めなくても本文は返す */ }
      }
    }
    if (!r.has_more) break;
    cursor = r.next_cursor;
  }
  return lines;
}

async function queryAll(ctx, ds, maxRows = 1000) {
  const out = [];
  let cursor = null;
  for (let guard = 0; guard < 20 && out.length < maxRows; guard++) {
    const r = await api(ctx, "POST", `/api/data/data_sources/${ds}/query`, { page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) });
    out.push(...(r.results ?? []));
    if (!r.has_more) break;
    cursor = r.next_cursor;
  }
  return out;
}

const isOpen = (row) => {
  if ("完了" in row) return !row["完了"];
  const st = row["状態"] ?? row["ステータス"];
  return !["決着", "完了", "見送り", "アーカイブ", "終了"].includes(st);
};

// 規約 (/api/storage/agent の rules)。Roles は 今週の目標、Projects は ステータス／対応ゴール／完了条件／役割／名前 だけ。タスクの完了は done 経由
async function guardUpdate(ctx, ds, fields) {
  const coll = await collectionOf(ctx, ds), keys = Object.keys(fields);
  const only = { roles: ["今週の目標"], projects: ["ステータス", "対応ゴール", "完了条件", "役割", "名前"] }[coll];
  if (only) {
    const bad = keys.filter((k) => !only.includes(k));
    if (bad.length) throw new Error(`${coll} で変えてよいのは ${only.join("、")} だけです（${bad.join("、")} は不可）`);
  }
  if (coll === "tasks" && (keys.includes("完了") || keys.includes("完了日") || fields["ステータス"] === "完了"))
    throw new Error("タスクの完了は kairos_task_action の done で行ってください（完了・完了日・ステータスを一緒に更新します）");
  return coll;
}

const RULES = [
  "Kairos の D1 が正本。Notion は更新しない。",
  "タスクの完了は kairos_task_action の done で行う（完了日とステータスが一緒に入り、AI処理開始も空になる）。",
  "既存の本文・理由行は残す。本文への追記は kairos_append_body を使う。",
  "操作が成功したか、ツールの結果で確かめてから報告する。失敗したら失敗と伝える。",
  "Roles で変えてよいのは 今週の目標 だけ。Projects で変えてよいのは ステータス・対応ゴール・完了条件・役割・名前 だけ。",
  "タスクの 説明 は「なぜ: …」「何を: …」の2行だけ（留意は 何を の行に足す）。出所・根拠・手順・経過は本文（kairos_create の body／kairos_append_body）に書く。例外は機械が読み書きする行（完了・見送り・重複・待ちの理由行、[棚卸し …] マーカー、スレッド URL や wallet_txn:<id> のような重複判定の鍵）だけ。",
  "AIに渡されたタスクは、終わるとき AI処理開始 を空にする（done なら自動。止まるなら kairos_task_action の human か ai_clear）。人の手が要って止まるなら human（ステータス=人対応）。",
];

const INSTRUCTIONS =
  "Kairos は齋藤さんのタスク・プロジェクト・役割・判断・習慣の正本（Cloudflare D1）です。" +
  "一覧は kairos_list_tasks、探すのは kairos_search_tasks、1件の詳細と本文は kairos_get。" +
  "規約:\n- " + RULES.join("\n- ");

const ID_PROP = { type: "string", description: "ページ ID（32 桁の 16 進、ハイフン可）" };
const DB_PROP = { type: "string", description: "中核は tasks / projects / roles / decisions / habits / habitlog。追加の DB（sessions, daily, dreamtime, proposals, blog_neta など）は DB 名で指定。対象の DB" };
const READ = { readOnlyHint: true, openWorldHint: false };
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

const TOOLS = [
  {
    name: "kairos_rules",
    title: "Kairos の操作規約を読む",
    description: "Kairos の操作規約（正本は D1、完了は done 経由、など）と、API 側の最新の規約を返す。操作の前に一度読む。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: READ,
    run: async (_a, ctx) => ({ mcpRules: RULES, api: await api(ctx, "GET", "/api/storage/agent") }),
  },
  {
    name: "kairos_list_tasks",
    title: "タスクの一覧（画面別）",
    description: "Kairos の画面と同じ一覧を返す。view: today=今日やる, can=今日できる, phone=スマホで, doing=着手中, project=PJ別, delegated=委任。",
    inputSchema: { type: "object", properties: { view: { type: "string", enum: ["today", "can", "phone", "doing", "project", "delegated"], default: "today" } }, additionalProperties: false },
    annotations: READ,
    run: async (a, ctx) => api(ctx, "GET", `/api/tasks?view=${encodeURIComponent(a.view ?? "today")}`),
  },
  {
    name: "kairos_search_tasks",
    title: "タスクを検索",
    description: "名前・説明に語を含むタスクを探す。include_done=true で完了済みも含める。",
    inputSchema: { type: "object", properties: { query: { type: "string", minLength: 1, maxLength: 100 }, include_done: { type: "boolean", default: false } }, required: ["query"], additionalProperties: false },
    annotations: READ,
    run: async (a, ctx) => api(ctx, "GET", `/api/search?q=${encodeURIComponent(String(a.query).slice(0, 100))}${a.include_done ? "&all=1" : ""}`),
  },
  {
    name: "kairos_get",
    title: "ページ 1 件（プロパティと本文）",
    description: "タスク・判断・PJ など 1 件のプロパティを返す。include_body=true で本文を Markdown 風に付ける。",
    inputSchema: { type: "object", properties: { id: ID_PROP, include_body: { type: "boolean", default: true } }, required: ["id"], additionalProperties: false },
    annotations: READ,
    run: async (a, ctx) => {
      const id = reqId(a.id), out = flat(await api(ctx, "GET", `/api/data/pages/${id}`));
      if (a.include_body !== false) out.body = (await bodyMd(ctx, id)).join("\n");
      return out;
    },
  },
  {
    name: "kairos_query",
    title: "DB の行を一覧",
    description: "tasks / projects / roles / decisions / habits / habitlog の行を返す。open_only=true で未完了だけ。where は {プロパティ名: 値} の完全一致（配列プロパティは含む）。columns で列を絞る。",
    inputSchema: {
      type: "object",
      properties: {
        database: DB_PROP,
        open_only: { type: "boolean", default: false },
        where: { type: "object", additionalProperties: { type: "string" } },
        columns: { type: "array", items: { type: "string" } },
        limit: { type: "integer", minimum: 1, maximum: 500, default: 100 },
      },
      required: ["database"],
      additionalProperties: false,
    },
    annotations: READ,
    run: async (a, ctx) => {
      const ds = await dsOf(ctx, a.database), cols = a.columns?.length ? a.columns : undefined;
      let rows = (await queryAll(ctx, ds)).map((p) => flat(p, { cols, truncate: cols ? 0 : 600 }));
      for (const [k, v] of Object.entries(a.where ?? {})) rows = rows.filter((r) => (Array.isArray(r[k]) ? r[k].includes(v) : String(r[k]) === v));
      if (a.open_only) rows = rows.filter(isOpen);
      return rows.slice(0, a.limit ?? 100);
    },
  },
  {
    name: "kairos_schema",
    title: "DB のプロパティと選択肢",
    description: "DB のプロパティ名・型・選択肢を返す。更新や作成の前に、書ける名前と選択肢を確かめるのに使う。",
    inputSchema: { type: "object", properties: { database: DB_PROP }, required: ["database"], additionalProperties: false },
    annotations: READ,
    run: async (a, ctx) =>
      Object.entries(await schemaOf(ctx, await dsOf(ctx, a.database))).map(([name, p]) => ({
        name, type: p.type, ...(["select", "multi_select", "status"].includes(p.type) ? { options: (p[p.type]?.options ?? []).map((o) => o.name) } : {}),
      })),
  },
  {
    name: "kairos_create",
    title: "ページを作る",
    description: "tasks / decisions / habitlog に 1 件作る。fields は {プロパティ名: 値}（日付は YYYY-MM-DD か ISO 日時、複数選択・リレーションは配列）。icon（絵文字）は tasks で必須。body は Markdown 風の本文。",
    inputSchema: {
      type: "object",
      properties: { database: DB_PROP, fields: { type: "object" }, icon: { type: "string" }, body: { type: "string" } },
      required: ["database", "fields"],
      additionalProperties: false,
    },
    annotations: WRITE,
    run: async (a, ctx) => {
      if (["roles", "projects", "habits"].includes(normName(a.database))) throw new Error("この DB には作れません（Roles / Projects / Habits は更新だけ）");
      const ds = await dsOf(ctx, a.database), schema = await schemaOf(ctx, ds);
      const props = Object.fromEntries(Object.entries(a.fields).map(([k, v]) => [k, toProp(schema, k, v)]));
      const payload = { parent: { data_source_id: ds }, properties: props };
      if (a.icon) payload.icon = { type: "emoji", emoji: a.icon };
      if (a.body) payload.children = mdBlocks(a.body);
      const out = await api(ctx, "POST", "/api/data/pages", payload);
      return { ok: true, id: out.id, name: plain(out.properties?.["名前"] ?? { type: "title", title: [] }) };
    },
  },
  {
    name: "kairos_update",
    title: "プロパティを更新",
    description: "1 件の一部のプロパティを更新する。fields は {プロパティ名: 値}。null で空にする。選択肢にない値は作らずエラーにする。タスクの完了は不可（kairos_task_action の done）。Roles は 今週の目標、Projects は ステータス・対応ゴール・完了条件・役割・名前 だけ。",
    inputSchema: { type: "object", properties: { id: ID_PROP, fields: { type: "object" }, icon: { type: "string" } }, required: ["id", "fields"], additionalProperties: false },
    annotations: { ...WRITE, idempotentHint: true },
    run: async (a, ctx) => {
      const id = reqId(a.id), page = await api(ctx, "GET", `/api/data/pages/${id}`);
      const ds = clean(page.parent?.data_source_id ?? "");
      if (!ds) throw new Error("このページの所属 DB が分かりません");
      await guardUpdate(ctx, ds, a.fields);
      const schema = await schemaOf(ctx, ds);
      const payload = { properties: Object.fromEntries(Object.entries(a.fields).map(([k, v]) => [k, toProp(schema, k, v)])) };
      if (a.icon) payload.icon = { type: "emoji", emoji: a.icon };
      const out = await api(ctx, "PATCH", `/api/data/pages/${id}`, payload);
      return { ok: true, id: out.id, name: plain(out.properties?.["名前"] ?? { type: "title", title: [] }) };
    },
  },
  {
    name: "kairos_append_body",
    title: "本文の末尾に追記",
    description: "ページ本文の末尾に Markdown 風のテキストを足す（見出し #, 箇条書き -, 番号 1., チェック - [ ], 引用 >）。既存の本文は消さない。",
    inputSchema: { type: "object", properties: { id: ID_PROP, markdown: { type: "string", minLength: 1, maxLength: 60000 } }, required: ["id", "markdown"], additionalProperties: false },
    annotations: { ...WRITE, idempotentHint: false },
    run: async (a, ctx) => {
      const id = reqId(a.id), blocks = mdBlocks(a.markdown);
      if (!blocks.length) throw new Error("追記する本文が空です");
      for (let i = 0; i < blocks.length; i += 90) await api(ctx, "PATCH", `/api/data/blocks/${id}/children`, { children: blocks.slice(i, i + 90) });
      return { ok: true, id, blocks: blocks.length };
    },
  },
  {
    name: "kairos_task_action",
    title: "タスクの 1 タップ操作",
    description: "done=完了, skip=見送り, reopen=未完了に戻す, human=人対応で止める（ステータス=人対応、AI処理開始を空に）, ai_clear=AI処理開始を空にする。note は理由 1 行（説明欄の先頭に残る）。",
    inputSchema: {
      type: "object",
      properties: { id: ID_PROP, action: { type: "string", enum: ["done", "skip", "reopen", "human", "ai_clear"] }, note: { type: "string", maxLength: 200 } },
      required: ["id", "action"],
      additionalProperties: false,
    },
    annotations: { ...WRITE, idempotentHint: true },
    run: async (a, ctx) => {
      const id = reqId(a.id), action = a.action === "ai_clear" ? "ai-clear" : a.action;
      if (!["done", "skip", "reopen", "human", "ai-clear"].includes(action)) throw new Error("action が不正です");
      const note = String(a.note ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
      const res = await api(ctx, "POST", `/api/tasks/${id}/${action}${note && (action === "done" || action === "skip") ? "?note=" + encodeURIComponent(note) : ""}`, {});
      return { ok: true, action: a.action, ...res };
    },
  },
];

const TOOL_LIST = TOOLS.map(({ name, title, description, inputSchema, annotations }) => ({ name, title, description, inputSchema, annotations }));

async function callTool(name, args, deps) {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return null;
  const ctx = { call: deps.call };
  try {
    let text = JSON.stringify(await tool.run(args && typeof args === "object" ? args : {}, ctx), null, 1);
    if (text.length > MAX_TEXT) text = text.slice(0, MAX_TEXT) + `\n…（${text.length - MAX_TEXT} 文字省略。columns や limit、where で絞ってください）`;
    return { content: [{ type: "text", text }] };
  } catch (e) {
    return { isError: true, content: [{ type: "text", text: String(e?.message ?? e) }] };
  }
}

// ---------- MCP (Streamable HTTP, 状態なし・JSON 応答) ----------
async function rpc(msg, deps) {
  if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return { jsonrpc: "2.0", id: msg?.id ?? null, error: { code: -32600, message: "Invalid Request" } };
  const hasId = msg.id !== undefined && msg.id !== null;
  const reply = (result) => (hasId ? { jsonrpc: "2.0", id: msg.id, result } : null);
  const fail = (code, message) => (hasId ? { jsonrpc: "2.0", id: msg.id, error: { code, message } } : null);
  switch (msg.method) {
    case "initialize": {
      const want = msg.params?.protocolVersion;
      return reply({
        protocolVersion: PROTOCOLS.includes(want) ? want : "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "kairos", title: "Kairos（タスク・判断・習慣）", version: VERSION },
        instructions: INSTRUCTIONS,
      });
    }
    case "ping": return reply({});
    case "tools/list": return reply({ tools: TOOL_LIST });
    case "tools/call": {
      const out = await callTool(msg.params?.name, msg.params?.arguments, deps);
      return out ? reply(out) : fail(-32602, `Unknown tool: ${msg.params?.name}`);
    }
    default:
      return msg.method.startsWith("notifications/") ? null : fail(-32601, `Method not found: ${msg.method}`);
  }
}

async function mcpEndpoint(req, env, url, deps) {
  const origin = req.headers.get("Origin");
  if (origin && !ORIGINS.some((re) => re.test(origin))) return jsonRes({ error: "forbidden origin" }, 403);
  const challenge = (error) => `Bearer resource_metadata="${url.origin}/.well-known/oauth-protected-resource"${error ? `, error="${error}"` : ""}`;
  const bearer = (req.headers.get("Authorization") ?? "").match(/^Bearer\s+(.+)$/i)?.[1];
  if (!bearer) return jsonRes({ error: "unauthorized" }, 401, { ...CORS, "WWW-Authenticate": challenge() });
  if (!(await verify(env, bearer, "access"))) return jsonRes({ error: "invalid_token" }, 401, { ...CORS, "WWW-Authenticate": challenge("invalid_token") });
  if (req.method !== "POST") return jsonRes({ error: "method not allowed" }, 405, { ...CORS, Allow: "POST, OPTIONS" });
  const text = await req.text();
  if (text.length > MAX_BODY) return jsonRes({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Request too large" } }, 413, CORS);
  let msg;
  try { msg = JSON.parse(text); } catch { return jsonRes({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400, CORS); }
  if (Array.isArray(msg)) {
    if (!msg.length || msg.length > 20) return jsonRes({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid batch" } }, 400, CORS);
    const out = (await Promise.all(msg.map((m) => rpc(m, deps)))).filter(Boolean);
    return out.length ? jsonRes(out, 200, CORS) : new Response(null, { status: 202, headers: CORS });
  }
  const out = await rpc(msg, deps);
  return out ? jsonRes(out, 200, CORS) : new Response(null, { status: 202, headers: CORS });
}

// ---------- ルーター ----------
export const isMcpPath = (path) => path === "/mcp" || path === "/authorize" || path.startsWith("/oauth/") || path.startsWith("/.well-known/oauth-");

// deps: { call(method, path, body) → Response (Worker 自身の API を内部で呼ぶ), authed(req) → boolean (Kairos Cookie 等), safeEq(a, b) }
export async function mcpRoute(req, env, url, deps) {
  const path = url.pathname;
  if (req.method === "OPTIONS" && (path === "/mcp" || path.startsWith("/oauth/") || path.startsWith("/.well-known/"))) return new Response(null, { status: 204, headers: CORS });
  if (path.startsWith("/.well-known/oauth-protected-resource") && req.method === "GET") return jsonRes(resourceMeta(url.origin), 200, CORS);
  if (path.startsWith("/.well-known/oauth-authorization-server") && req.method === "GET") return jsonRes(authServerMeta(url.origin), 200, CORS);
  if (path === "/oauth/register" && req.method === "POST") return register(req, env);
  if (path === "/authorize" && req.method === "GET") return authorizeGet(req, env, url, deps);
  if (path === "/authorize" && req.method === "POST") return authorizePost(req, env, url, deps);
  if (path === "/oauth/token" && req.method === "POST") return tokenPost(req, env);
  if (path === "/mcp") return mcpEndpoint(req, env, url, deps);
  return jsonRes({ error: "not found" }, 404);
}
