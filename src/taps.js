// ---- ボタンのタップ計測 (2026-10-20) ----
let tapsReady = null;
function tapsInit(env) {
  if (!env.DB) return null;
  return (tapsReady ||= env.DB.prepare("CREATE TABLE IF NOT EXISTS tap_counts(day TEXT NOT NULL, key TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(day,key))").run().catch((e) => { tapsReady = null; throw e; }));
}
export async function tapsAdd(env, body) {
  if (!env.DB) return { ok: true, stored: 0 };
  const day = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
  const items = (Array.isArray(body.items) ? body.items : []).slice(0, 50)
    .map((x) => ({ k: String(x && x.k || "").trim().slice(0, 60), n: Math.max(1, Math.min(50, Math.floor(Number(x && x.n) || 1))) }))
    .filter((x) => /^[\w:#?=&.,\-\u3040-\u30ff\u4e00-\u9fff]+$/.test(x.k));
  if (!items.length) return { ok: true, stored: 0 };
  await tapsInit(env);
  await env.DB.batch(items.map((x) => env.DB.prepare("INSERT INTO tap_counts(day,key,n) VALUES(?,?,?) ON CONFLICT(day,key) DO UPDATE SET n=n+excluded.n").bind(day, x.k, x.n)));
  return { ok: true, stored: items.length };
}
export async function tapsReport(env, days) {
  if (!env.DB) return { days, total: 0, keys: [] };
  await tapsInit(env);
  const d = Math.max(1, Math.min(365, days)), since = new Date(Date.now() + 9 * 3600000 - (d - 1) * 86400000).toISOString().slice(0, 10);
  const r = await env.DB.prepare("SELECT key, SUM(n) AS n, COUNT(DISTINCT day) AS days FROM tap_counts WHERE day>=? GROUP BY key ORDER BY n DESC").bind(since).all();
  const keys = (r.results || []).map((x) => ({ key: x.key, n: x.n, days: x.days }));
  return { since, days: d, total: keys.reduce((a, x) => a + x.n, 0), keys };
}

