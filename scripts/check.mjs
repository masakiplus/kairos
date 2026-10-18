import { readdir, readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const temp = await mkdtemp(join(tmpdir(), 'kairos-check-'));
try {
  for (const name of await readdir('src')) {
    if (!name.endsWith('.js')) continue;
    const path = join(temp, name + '.mjs');
    await writeFile(path, await readFile(join('src', name)));
    execFileSync(process.execPath, ['--check', path], { stdio: 'inherit' });
  }
  const html = await readFile('src/app.html', 'utf8');
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const path = join(temp, 'app.js');
  await writeFile(path, scripts.join('\n'));
  execFileSync(process.execPath, ['--check', path], { stdio: 'inherit' });
} finally {
  await rm(temp, { recursive: true, force: true });
}
