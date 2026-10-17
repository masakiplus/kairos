import { readFile, writeFile, mkdir, open, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';

export const collections = {
  tasks: 'TASKS_DATA_SOURCE_ID', projects: 'PROJECTS_DATA_SOURCE_ID',
  roles: 'ROLES_DATA_SOURCE_ID', decisions: 'DECISIONS_DATA_SOURCE_ID',
  habits: 'HABITS_DATA_SOURCE_ID', habit_log: 'HABIT_LOG_DATA_SOURCE_ID',
};

// No destructive endpoints, Notion writes, deployment, or read-source switch.
export async function copyNotion({ api, save, progress = () => {}, delay = () => pause(350), sources }) {
  for (const [coll, key] of Object.entries(collections)) {
    if (!/^[a-f0-9-]{32,36}$/i.test(sources[key] || '')) throw new Error(`Missing/invalid ${key}`);
  }
  const report = { started: new Date().toISOString(), collections: {} };
  await save('before.json', await api('stats'));
  await api('init', {});
  for (const [coll, key] of Object.entries(collections)) {
    const entry = report.collections[coll] = { queried: 0, bodies: 0, exported: 0, issues: [] };
    const seenCursors = new Set();
    let cursor;
    do {
      const query = new URLSearchParams({ coll, ds: sources[key], ...(cursor ? { cursor } : {}) });
      const page = await api(`props?${query}`, {});
      if (!Number.isInteger(page.n) || page.n < 0) throw new Error(`Invalid props response: ${coll}`);
      entry.queried += page.n;
      cursor = page.next;
      if (cursor && seenCursors.has(cursor)) throw new Error(`Repeated Notion cursor: ${coll}`);
      if (cursor) seenCursors.add(cursor);
      await save('report.json', report);
      progress(`${coll}: properties ${entry.queried}`);
      await delay();
    } while (cursor);
    const seenBodies = new Set();
    while (true) {
      const pending = await api(`pending?coll=${coll}&n=20`);
      if (!Array.isArray(pending.ids)) throw new Error(`Invalid pending response: ${coll}`);
      if (!pending.ids.length) break;
      for (const id of pending.ids) {
        if (!/^[a-f0-9]{32}$/i.test(id) || seenBodies.has(id)) throw new Error(`Body did not advance: ${coll}`);
        seenBodies.add(id);
        const result = await api(`body?id=${id}`, {});
        entry.bodies++;
        if (result.error || result.truncated || result.missing || Object.values(result.lossy || {}).some(n => n > 0)) {
          entry.issues.push({ id, ...result });
        }
        await save('report.json', report);
        progress(`${coll}: bodies ${entry.bodies}, issues ${entry.issues.length}`);
        await delay();
      }
    }
    // Save every exported page as private JSON; never use remote filenames as paths.
    let after, pageIndex = 0;
    const seenAfter = new Set();
    do {
      const query = new URLSearchParams({ coll, n: '50', ...(after ? { after } : {}) });
      const page = await api(`export?${query}`);
      if (!Array.isArray(page.files)) throw new Error(`Invalid export response: ${coll}`);
      await save(`${coll}-${String(++pageIndex).padStart(5, '0')}.json`, page);
      entry.exported += page.files.length;
      after = page.next;
      if (after && seenAfter.has(after)) throw new Error(`Repeated D1 cursor: ${coll}`);
      if (after) seenAfter.add(after);
    } while (after);
  }
  report.stats = await api('stats');
  report.finished = new Date().toISOString();
  if (!Array.isArray(report.stats.by) || !report.stats.conv) throw new Error('Invalid stats response');
  report.copy_ok = Object.values(report.collections).some(c => c.queried > 0)
    && Object.entries(report.collections).every(([coll, c]) => {
    const rows = (report.stats.by || []).filter(r => r.collection === coll);
    return c.queried === c.exported && c.queried === rows.reduce((n, r) => n + r.n, 0)
      && rows.every(r => r.body_status === 'done') && !c.issues.length;
  }) && !report.stats.conv?.errors && !report.stats.conv?.truncated
    && !report.stats.conv?.missing_texts && !Object.values(report.stats.conv?.lossy || {}).some(n => n > 0);
  // copy_ok is not proof of full Notion fidelity or attachment durability.
  await save('report.json', report);
  return report;
}

async function main() {
  const [configPath, outputPath] = process.argv.slice(2);
  if (!configPath || !outputPath || !process.env.APP_TOKEN) {
    throw new Error('Usage: node --env-file=.dev.vars scripts/copy-notion-to-d1.mjs <github-vars.json> <private-output-dir> (APP_TOKEN required)');
  }
  const config = Object.fromEntries(JSON.parse(await readFile(configPath, 'utf8')).map(v => [v.name, v.value]));
  const origin = new URL(config.PUBLIC_URL);
  if (origin.protocol !== 'https:' || origin.hostname !== 'tasks-pwa.masaki-saito.workers.dev'
    || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
    throw new Error('Unexpected Worker destination; refusing to send APP_TOKEN');
  }
  const dir = resolve(outputPath);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const lockPath = join(dir, '.copy.lock');
  const lock = await open(lockPath, 'wx', 0o600);
  try {
    const api = async (path, body) => {
      const response = await fetch(new URL(`/api/lab/${path}`, origin), {
        method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(180000),
        headers: { Authorization: `Bearer ${process.env.APP_TOKEN}`, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      // Do not print response bodies: upstream failures may include private Notion text.
      if (!response.ok) throw new Error(`${path.split('?')[0]}: HTTP ${response.status}`);
      const result = await response.json();
      if (result.error && !path.startsWith('body?')) throw new Error(`${path.split('?')[0]}: API error`);
      return result;
    };
    const report = await copyNotion({ api, sources: config,
      save: (name, value) => writeFile(join(dir, name), JSON.stringify(value, null, 2), { mode: 0o600 }),
      progress: message => console.log(message),
    });
    console.log(`Copy finished. copy_ok=${report.copy_ok}; private report: ${join(dir, 'report.json')}`);
    if (!report.copy_ok) process.exitCode = 2;
  } finally { await lock.close(); await rm(lockPath); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
