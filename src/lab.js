/**
 * D1 移行の実験 (B2 速さ・F3 往復) — 2026-10-17
 *
 * Notion を正本のまま、Notion → D1 (docs / links) へ写し、D1 から読む速さと
 * 「D1 → MD ファイル → D1」の往復で中身が欠けないかを確かめるための口。本番の画面は使わない。
 * すべて /api/lab/* (Kairos と同じ認証)。D1 のバインディング名は DB。
 *
 *   POST /api/lab/init                         表を作る (何度呼んでもよい)
 *   POST /api/lab/props?coll=tasks[&ds=…][&cursor=…]  属性だけ 100 件ずつ写す (本文は後で)
 *   GET  /api/lab/pending?coll=…&n=…           本文がまだの id
 *   POST /api/lab/body?id=…                    1 ページの本文を Notion ブロック → MD にして写す
 *   GET  /api/lab/stats                         件数・変換の欠け
 *   GET  /api/lab/list?view=today|can|project   D1 から一覧 (速さ比べ用。絞り込みは簡易)
 *   GET  /api/lab/doc?id=…                      1 件 (本文つき)
 *   GET  /api/lab/export?coll=…&after=…&n=…     MD ファイルとして書き出す
 *   POST /api/lab/import-md                     MD ファイルを読み込んで docs_rt に入れる (往復用)
 *   GET  /api/lab/compare                       docs と docs_rt の一致を数える
 */

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS docs (id TEXT PRIMARY KEY, collection TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', parent_id TEXT,
     props TEXT NOT NULL DEFAULT '{}', body_md TEXT NOT NULL DEFAULT '', created TEXT, updated TEXT, version INTEGER NOT NULL DEFAULT 1,
     body_status TEXT NOT NULL DEFAULT 'pending', conv TEXT)`,
  `CREATE INDEX IF NOT EXISTS docs_coll ON docs(collection, body_status)`,
  `CREATE TABLE IF NOT EXISTS docs_rt (id TEXT PRIMARY KEY, collection TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', parent_id TEXT,
     props TEXT NOT NULL DEFAULT '{}', body_md TEXT NOT NULL DEFAULT '', created TEXT, updated TEXT, version INTEGER NOT NULL DEFAULT 1,
     body_status TEXT NOT NULL DEFAULT 'pending', conv TEXT)`,
  `CREATE TABLE IF NOT EXISTS links (from_id TEXT NOT NULL, to_id TEXT NOT NULL, kind TEXT NOT NULL, PRIMARY KEY (from_id, to_id, kind))`,
  `CREATE INDEX IF NOT EXISTS links_to ON links(to_id)`,
];

const nid = (s) => String(s || "").replace(/-/g, "").toLowerCase();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Notion 呼び出し (429/5xx は待って再試行)。ctx.calls で 1 回の呼び出しあたりの数を数える */
async function nget(env, ctx, path, init = {}) {
  for (let k = 0; k < 5; k++) {
    ctx.calls++;
    const res = await fetch(`https://api.notion.com/v1${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${env.NOTION_TOKEN}`, "Notion-Version": "2025-09-03", "Content-Type": "application/json" },
    });
    if (res.status === 429 || res.status >= 500) {
      await sleep(Math.min(8000, 1000 * (parseFloat(res.headers.get("Retry-After") || "1") || 1) * (k + 1)));
      continue;
    }
    const text = await res.text();
    if (!res.ok) throw new Error(`Notion ${path} -> ${res.status}: ${text.slice(0, 200)}`);
    return JSON.parse(text);
  }
  throw new Error(`Notion ${path} -> retries`);
}

// ---------- Notion → MD ----------
/** rich_text → MD インライン。ctx.mentions にページ参照を集め、ctx.texts に検証用の素の文字列を集める */
function rtMd(rich, ctx) {
  return (rich || []).map((x) => {
    let t = String(x.plain_text ?? "");
    if (ctx && t.trim()) ctx.texts.push(t);
    if (x.type === "equation") return `$${t}$`;
    const a = x.annotations || {};
    if (a.code) t = "`" + t + "`";
    if (a.bold) t = `**${t}**`;
    if (a.italic) t = `*${t}*`;
    if (a.strikethrough) t = `~~${t}~~`;
    let href = x.href || null;
    if (x.type === "mention") {
      const m = x.mention || {};
      const pid = m.page?.id || m.database?.id;
      if (pid) { href = `notion:${nid(pid)}`; ctx?.mentions.add(nid(pid)); }
      if (m.date) return t;
    }
    return href ? `[${t}](${href})` : t;
  }).join("");
}

const LOSSY = new Set(["child_database", "unsupported", "synced_block", "column_list", "column", "table_of_contents", "breadcrumb", "template", "link_to_page", "audio", "video", "file", "pdf", "image", "embed"]);

async function blocksMd(env, ctx, id, indent) {
  const lines = [];
  let cursor;
  let num = 0;
  do {
    const r = await nget(env, ctx, `/blocks/${id}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ""}`);
    for (const b of r.results || []) {
      const t = b.type, v = b[t] || {};
      ctx.blocks++;
      ctx.types[t] = (ctx.types[t] || 0) + 1;
      if (LOSSY.has(t)) ctx.lossy[t] = (ctx.lossy[t] || 0) + 1;
      const pad = "  ".repeat(indent);
      const text = rtMd(v.rich_text, ctx);
      let line = null, childIndent = indent + 1, wrapEnd = null;
      if (t !== "numbered_list_item") num = 0;
      switch (t) {
        case "paragraph": line = text; childIndent = indent + 1; break;
        case "heading_1": line = `# ${text}`; break;
        case "heading_2": line = `## ${text}`; break;
        case "heading_3": line = `### ${text}`; break;
        case "heading_4": line = `#### ${text}`; break;
        case "bulleted_list_item": line = `- ${text}`; break;
        case "numbered_list_item": num++; line = `${num}. ${text}`; break;
        case "to_do": line = `- [${v.checked ? "x" : " "}] ${text}`; break;
        case "quote": line = `> ${text}`; break;
        case "callout": line = `> [!note] ${v.icon?.emoji ? v.icon.emoji + " " : ""}${text}`; break;
        case "toggle": line = `<details><summary>${text}</summary>\n`; wrapEnd = "</details>"; childIndent = indent; break;
        case "divider": line = "---"; break;
        case "code": {
          const src = (v.rich_text || []).map((x) => x.plain_text).join("");
          line = "```" + (v.language && v.language !== "plain text" ? v.language : "") + "\n" + src + "\n```";
          break;
        }
        case "equation": line = `$$${v.expression || ""}$$`; break;
        case "child_page": line = `[[${v.title || ""}]](notion:${nid(b.id)})`; ctx.children.push({ id: nid(b.id), title: v.title || "" }); break;
        case "child_database": line = `<!-- child_database ${nid(b.id)} ${v.title || ""} -->`; break;
        case "link_to_page": { const pid = v.page_id || v.database_id; line = `[→](notion:${nid(pid)})`; if (pid) ctx.mentions.add(nid(pid)); break; }
        case "bookmark": case "embed": case "link_preview": line = `<${v.url || ""}>`; break;
        case "image": case "file": case "pdf": case "video": case "audio": {
          const u = v.external?.url || v.file?.url || "";
          const cap = rtMd(v.caption, ctx) || v.name || t;
          line = t === "image" ? `![${cap}](${u})` : `[${cap}](${u})`;
          ctx.files.push(u);
          break;
        }
        case "table": {
          const rows = [];
          let c2;
          do {
            const rr = await nget(env, ctx, `/blocks/${b.id}/children?page_size=100${c2 ? `&start_cursor=${c2}` : ""}`);
            for (const row of rr.results || []) {
              ctx.blocks++; ctx.types.table_row = (ctx.types.table_row || 0) + 1;
              rows.push((row.table_row?.cells || []).map((cell) => rtMd(cell, ctx).replace(/\|/g, "\\|").replace(/\n/g, "<br>")));
            }
            c2 = rr.has_more ? rr.next_cursor : null;
          } while (c2);
          if (rows.length) {
            const w = Math.max(...rows.map((r) => r.length));
            const fmt = (r) => "| " + Array.from({ length: w }, (_, i) => r[i] ?? "").join(" | ") + " |";
            line = [fmt(rows[0]), "|" + " --- |".repeat(w), ...rows.slice(1).map(fmt)].join("\n" + pad);
          } else line = "";
          break;
        }
        case "synced_block": case "column_list": case "column": line = null; childIndent = indent; break;
        case "table_of_contents": case "breadcrumb": line = `<!-- ${t} -->`; break;
        default: line = `<!-- ${t} -->`;
      }
      if (line !== null) lines.push(pad + line.replace(/\n/g, "\n" + pad));
      if (b.has_children && t !== "child_page" && t !== "child_database" && t !== "table") {
        if (ctx.calls > ctx.budget) { ctx.truncated = true; lines.push(pad + "  <!-- truncated -->"); }
        else lines.push(...(await blocksMd(env, ctx, b.id, childIndent)));
      }
      if (wrapEnd) lines.push(pad + wrapEnd);
    }
    cursor = r.has_more ? r.next_cursor : null;
    if (cursor && ctx.calls > ctx.budget) { ctx.truncated = true; lines.push("<!-- truncated -->"); break; }
  } while (cursor);
  return lines;
}

// ---------- 属性 ----------
function propsOf(page) {
  const props = {}, rels = [], computed = {};
  let title = "";
  for (const [k, p] of Object.entries(page.properties || {})) {
    const t = p.type;
    switch (t) {
      case "title": title = (p.title || []).map((x) => x.plain_text).join(""); break;
      case "rich_text": props[k] = rtMd(p.rich_text, null); break;
      case "select": props[k] = p.select?.name ?? null; break;
      case "status": props[k] = p.status?.name ?? null; break;
      case "multi_select": props[k] = (p.multi_select || []).map((o) => o.name); break;
      case "date": props[k] = p.date ? (p.date.end ? { start: p.date.start, end: p.date.end } : p.date.start) : null; break;
      case "checkbox": props[k] = !!p.checkbox; break;
      case "number": props[k] = p.number; break;
      case "url": case "email": case "phone_number": props[k] = p[t] ?? null; break;
      case "people": props[k] = (p.people || []).map((u) => u.id); break;
      case "files": props[k] = (p.files || []).map((f) => f.external?.url || f.name); break;
      case "relation":
        props[k] = (p.relation || []).map((r) => nid(r.id));
        for (const r of p.relation || []) rels.push({ to: nid(r.id), kind: `rel:${k}` });
        if (p.has_more) props[`${k}__more`] = true;
        break;
      case "formula": computed[k] = p.formula?.[p.formula?.type] ?? null; break;
      case "rollup": computed[k] = p.rollup?.[p.rollup?.type] ?? null; break;
      default: break; // created_time 等は列で持つ
    }
  }
  if (Object.keys(computed).length) props._computed = computed;
  return { title, props, rels };
}

/** キーを並べ替えた JSON (比較を安定させる) */
function canon(v) {
  if (Array.isArray(v)) return "[" + v.map(canon).join(",") + "]";
  if (v && typeof v === "object") return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canon(v[k])).join(",") + "}";
  return JSON.stringify(v ?? null);
}

// ---------- MD ファイル (書き出しと読み込み) ----------
const FM_KEYS = ["id", "collection", "title", "parent_id", "created", "updated", "version", "props"];
function toMdFile(row) {
  const fm = ["---",
    `id: ${row.id}`, `collection: ${row.collection}`, `title: ${JSON.stringify(row.title)}`,
    `parent_id: ${row.parent_id ?? ""}`, `created: ${row.created ?? ""}`, `updated: ${row.updated ?? ""}`,
    `version: ${row.version}`, `props: ${row.props}`, "---", ""].join("\n");
  return fm + row.body_md;
}
function parseMdFile(text) {
  if (!text.startsWith("---\n")) throw new Error("no frontmatter");
  const end = text.indexOf("\n---\n", 4);
  if (end < 0) throw new Error("frontmatter not closed");
  const head = text.slice(4, end), body = text.slice(end + 5);
  const o = {};
  for (const line of head.split("\n")) {
    const i = line.indexOf(": ");
    const k = i < 0 ? line.replace(/:$/, "") : line.slice(0, i), v = i < 0 ? "" : line.slice(i + 2);
    if (!FM_KEYS.includes(k)) continue;
    o[k] = v;
  }
  return {
    id: o.id, collection: o.collection, title: JSON.parse(o.title || '""'), parent_id: o.parent_id || null,
    created: o.created || null, updated: o.updated || null, version: parseInt(o.version || "1", 10),
    props: canon(JSON.parse(o.props || "{}")), body_md: body,
  };
}

// ---------- 簡易の一覧 (速さ比べ用) ----------
function jstToday() { return new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10); }
const dstr = (v) => (v && typeof v === "object" ? v.start : v) || null;

async function labList(env, view) {
  const t0 = Date.now();
  const r = await env.DB.prepare(
    `SELECT id, title, props FROM docs WHERE collection = 'tasks' AND json_extract(props, '$."完了"') = 0`
  ).all();
  const tDb = Date.now() - t0;
  const today = jstToday();
  const tasks = [];
  for (const row of r.results || []) {
    const p = JSON.parse(row.props);
    const due = dstr(p["期日"])?.slice(0, 10) || null, start = dstr(p["開始日"])?.slice(0, 10) || null;
    const t = { id: row.id, name: row.title, due, start, status: p["ステータス"], env: p["実行環境"] || [], project: (p["関連プロジェクト"] || []).length };
    const dd = due ? Math.round((Date.parse(due) - Date.parse(today)) / 86_400_000) : null;
    if (view === "today" && !((due && due <= today) || (start && start <= today && !due))) continue;
    if (view === "can" && !(t.status !== "待ち" && (!start || start <= today) && (dd === null || (dd >= 1 && dd <= 7)))) continue;
    if (view === "project" && !t.project) continue;
    tasks.push(t);
  }
  return { view, today, tasks, n: tasks.length, scanned: (r.results || []).length, ms_db: tDb, ms_total: Date.now() - t0 };
}

// ---------- ルーター ----------
export async function labRoute(req, env, url, json) {
  const path = url.pathname;
  if (!env.DB) return json({ error: "D1 binding DB がない" }, 500);
  const q = (k) => url.searchParams.get(k);
  const DS = {
    tasks: env.TASKS_DATA_SOURCE_ID, projects: env.PROJECTS_DATA_SOURCE_ID, decisions: env.DECISIONS_DATA_SOURCE_ID,
    roles: env.ROLES_DATA_SOURCE_ID, habits: env.HABITS_DATA_SOURCE_ID,
  };

  if (path === "/api/lab/init" && req.method === "POST") {
    for (const s of SCHEMA) await env.DB.prepare(s).run();
    return json({ ok: true });
  }

  if (path === "/api/lab/props" && req.method === "POST") {
    const coll = q("coll"), ds = q("ds") || DS[coll];
    if (!coll || !ds) return json({ error: "coll / ds が要る" }, 400);
    const ctx = { calls: 0 };
    const t0 = Date.now();
    const r = await nget(env, ctx, `/data_sources/${ds}/query`, { method: "POST", body: JSON.stringify({ page_size: 100, ...(q("cursor") ? { start_cursor: q("cursor") } : {}) }) });
    const stmts = [];
    for (const page of r.results || []) {
      const { title, props, rels } = propsOf(page);
      const id = nid(page.id);
      const parent = page.parent?.type === "page_id" ? nid(page.parent.page_id) : null;
      stmts.push(env.DB.prepare(
        `INSERT INTO docs (id, collection, title, parent_id, props, created, updated, body_status) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'pending')
         ON CONFLICT(id) DO UPDATE SET collection = ?2, title = ?3, parent_id = ?4, props = ?5, created = ?6, updated = ?7,
           body_status = CASE WHEN docs.updated = ?7 THEN docs.body_status ELSE 'pending' END`
      ).bind(id, coll, title, parent, canon(props), page.created_time, page.last_edited_time));
      stmts.push(env.DB.prepare(`DELETE FROM links WHERE from_id = ? AND kind LIKE 'rel:%'`).bind(id));
      for (const l of rels) stmts.push(env.DB.prepare(`INSERT OR IGNORE INTO links (from_id, to_id, kind) VALUES (?, ?, ?)`).bind(id, l.to, l.kind));
    }
    if (stmts.length) await env.DB.batch(stmts);
    return json({ coll, n: (r.results || []).length, next: r.has_more ? r.next_cursor : null, ms: Date.now() - t0 });
  }

  if (path === "/api/lab/pending" && req.method === "GET") {
    const n = Math.min(200, parseInt(q("n") || "50", 10));
    const coll = q("coll");
    const r = await env.DB.prepare(`SELECT id FROM docs WHERE body_status = 'pending' ${coll ? "AND collection = ?1" : ""} ORDER BY id LIMIT ${n}`).bind(...(coll ? [coll] : [])).all();
    return json({ ids: (r.results || []).map((x) => x.id) });
  }

  if (path === "/api/lab/body" && req.method === "POST") {
    const id = nid(q("id"));
    const ctx = { calls: 0, budget: parseInt(q("budget") || "40", 10), blocks: 0, types: {}, lossy: {}, texts: [], mentions: new Set(), children: [], files: [], truncated: false };
    const t0 = Date.now();
    let md;
    try {
      md = (await blocksMd(env, ctx, id, 0)).join("\n");
    } catch (e) {
      await env.DB.prepare(`UPDATE docs SET body_status = 'error', conv = ? WHERE id = ?`).bind(JSON.stringify({ error: String(e.message || e).slice(0, 200) }), id).run();
      return json({ id, error: String(e.message || e) }, 200);
    }
    // 検証: 素の文字列がすべて MD に残っているか (書式記号を足しただけで、文字は落としていないか)
    const missing = ctx.texts.filter((s) => !md.includes(s)).length;
    const conv = { blocks: ctx.blocks, calls: ctx.calls, types: ctx.types, lossy: ctx.lossy, missing, texts: ctx.texts.length, children: ctx.children.length, files: ctx.files.length, truncated: ctx.truncated, ms: Date.now() - t0 };
    const stmts = [
      env.DB.prepare(`UPDATE docs SET body_md = ?, body_status = ?, conv = ? WHERE id = ?`).bind(md, ctx.truncated ? "truncated" : "done", JSON.stringify(conv), id),
      env.DB.prepare(`DELETE FROM links WHERE from_id = ? AND kind IN ('mention', 'child')`).bind(id),
      ...[...ctx.mentions].map((to) => env.DB.prepare(`INSERT OR IGNORE INTO links VALUES (?, ?, 'mention')`).bind(id, to)),
      ...ctx.children.map((c) => env.DB.prepare(`INSERT OR IGNORE INTO links VALUES (?, ?, 'child')`).bind(id, c.id)),
    ];
    await env.DB.batch(stmts);
    return json({ id, ...conv });
  }

  if (path === "/api/lab/stats" && req.method === "GET") {
    const by = await env.DB.prepare(`SELECT collection, body_status, COUNT(*) n, SUM(LENGTH(body_md)) chars FROM docs GROUP BY 1, 2`).all();
    const conv = await env.DB.prepare(`SELECT conv FROM docs WHERE conv IS NOT NULL`).all();
    const agg = { pages: 0, blocks: 0, calls: 0, missing_pages: 0, missing_texts: 0, texts: 0, lossy: {}, truncated: 0, errors: 0, maxCalls: 0, msSum: 0 };
    for (const r of conv.results || []) {
      const c = JSON.parse(r.conv);
      if (c.error) { agg.errors++; continue; }
      agg.pages++; agg.blocks += c.blocks; agg.calls += c.calls; agg.texts += c.texts; agg.missing_texts += c.missing; agg.msSum += c.ms || 0;
      if (c.missing) agg.missing_pages++;
      if (c.truncated) agg.truncated++;
      agg.maxCalls = Math.max(agg.maxCalls, c.calls);
      for (const [k, v] of Object.entries(c.lossy || {})) agg.lossy[k] = (agg.lossy[k] || 0) + v;
    }
    const links = await env.DB.prepare(`SELECT kind, COUNT(*) n FROM links GROUP BY 1 ORDER BY 2 DESC LIMIT 40`).all();
    return json({ by: by.results, conv: agg, links: links.results });
  }

  if (path === "/api/lab/list" && req.method === "GET") return json(await labList(env, q("view") || "today"));

  if (path === "/api/lab/doc" && req.method === "GET") {
    const t0 = Date.now();
    const row = await env.DB.prepare(`SELECT * FROM docs WHERE id = ?`).bind(nid(q("id"))).first();
    const back = await env.DB.prepare(`SELECT from_id, kind FROM links WHERE to_id = ? LIMIT 50`).bind(nid(q("id"))).all();
    return json({ doc: row, backlinks: back.results, ms: Date.now() - t0 });
  }

  if (path === "/api/lab/export" && req.method === "GET") {
    const n = Math.min(500, parseInt(q("n") || "200", 10));
    const coll = q("coll"), after = q("after") || "";
    const r = await env.DB.prepare(`SELECT * FROM docs WHERE id > ?1 ${coll ? "AND collection = ?2" : ""} ORDER BY id LIMIT ${n}`).bind(...(coll ? [after, coll] : [after])).all();
    const rows = r.results || [];
    return json({ files: rows.map((x) => ({ name: `${x.collection}/${x.id}.md`, text: toMdFile(x) })), next: rows.length === n ? rows[rows.length - 1].id : null });
  }

  if (path === "/api/lab/import-md" && req.method === "POST") {
    const body = await req.json();
    const stmts = [], errors = [];
    for (const f of body.files || []) {
      try {
        const d = parseMdFile(f.text ?? f);
        stmts.push(env.DB.prepare(
          `INSERT OR REPLACE INTO docs_rt (id, collection, title, parent_id, props, body_md, created, updated, version, body_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'rt')`
        ).bind(d.id, d.collection, d.title, d.parent_id, d.props, d.body_md, d.created, d.updated, d.version));
      } catch (e) { errors.push(String(e.message || e)); }
    }
    if (stmts.length) await env.DB.batch(stmts);
    return json({ n: stmts.length, errors });
  }

  if (path === "/api/lab/compare" && req.method === "GET") {
    const one = async (sql) => (await env.DB.prepare(sql).first()).n;
    const res = {
      docs: await one(`SELECT COUNT(*) n FROM docs`),
      rt: await one(`SELECT COUNT(*) n FROM docs_rt`),
      missing_in_rt: await one(`SELECT COUNT(*) n FROM docs d LEFT JOIN docs_rt r ON r.id = d.id WHERE r.id IS NULL`),
      title_diff: await one(`SELECT COUNT(*) n FROM docs d JOIN docs_rt r ON r.id = d.id WHERE d.title IS NOT r.title`),
      props_diff: await one(`SELECT COUNT(*) n FROM docs d JOIN docs_rt r ON r.id = d.id WHERE d.props IS NOT r.props`),
      body_diff: await one(`SELECT COUNT(*) n FROM docs d JOIN docs_rt r ON r.id = d.id WHERE d.body_md IS NOT r.body_md`),
      meta_diff: await one(`SELECT COUNT(*) n FROM docs d JOIN docs_rt r ON r.id = d.id WHERE d.collection IS NOT r.collection OR IFNULL(d.parent_id,'') IS NOT IFNULL(r.parent_id,'') OR IFNULL(d.created,'') IS NOT IFNULL(r.created,'') OR IFNULL(d.updated,'') IS NOT IFNULL(r.updated,'') OR d.version IS NOT r.version`),
    };
    const ex = await env.DB.prepare(`SELECT d.id FROM docs d JOIN docs_rt r ON r.id = d.id WHERE d.body_md IS NOT r.body_md OR d.props IS NOT r.props OR d.title IS NOT r.title LIMIT 5`).all();
    res.examples = (ex.results || []).map((x) => x.id);
    return json(res);
  }

  if (path === "/api/lab/reset-rt" && req.method === "POST") {
    await env.DB.prepare(`DELETE FROM docs_rt`).run();
    return json({ ok: true });
  }

  return json({ error: "not found" }, 404);
}
