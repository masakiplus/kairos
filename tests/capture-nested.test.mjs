import test from 'node:test';
import assert from 'node:assert/strict';
import {fillOne, parseArgs} from '../scripts/capture-nested.mjs';

test('fillOne: cursor を追い、返る入れ子を下まで呼び、添付は capture-asset へ回す', async () => {
  const calls = [];
  const kairos = async (method, path) => {
    calls.push(method + ' ' + path);
    if (path === '/api/storage/capture-nested?id=t1') return {n: 100, next: 'c1', children: [], assets: [], pages: []};
    if (path === '/api/storage/capture-nested?id=t1&cursor=c1') return {n: 3, next: null, children: ['T2-X'], assets: ['img'], pages: ['sub']};
    if (path.startsWith('/api/storage/capture-nested')) return {n: 1, next: null, children: [], assets: [], pages: []};
    if (path.startsWith('/api/storage/capture-asset')) throw Object.assign(new Error('HTTP 409'), {status: 409});
    throw new Error('unexpected ' + path);
  };
  const r = await fillOne(kairos, 't1', {delay: async () => {}});
  assert.deepEqual(calls, ['POST /api/storage/capture-nested?id=t1', 'POST /api/storage/capture-nested?id=t1&cursor=c1', 'POST /api/storage/capture-nested?id=t2x', 'POST /api/storage/capture-asset?id=img']);
  assert.equal(r.blocks, 104); assert.equal(r.nested, 2); assert.equal(r.assets, 1);
  assert.equal(r.assetErrors.length, 1, '添付の失敗は記録して続ける');
  assert.deepEqual(r.pages, ['sub']);
});

test('parseArgs', () => {
  assert.deepEqual(parseArgs(['/tmp/x', 'apply', '--confirm', '--coll=daily', '--limit=5']), {dir: '/tmp/x', phase: 'apply', opt: {confirm: true, coll: 'daily', limit: '5'}});
});
