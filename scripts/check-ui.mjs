import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
const dir = await mkdtemp(join(tmpdir(), 'kairos-ui-check-'));
try {
  const html = await readFile('src/app.html', 'utf8');
  const path = join(dir, 'app.js');
  await writeFile(path, [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m=>m[1]).join('\n'));
  execFileSync(process.execPath,['--check',path],{stdio:'inherit'});
} finally { await rm(dir,{recursive:true,force:true}); }
