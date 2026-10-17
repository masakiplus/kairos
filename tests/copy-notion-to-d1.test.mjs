import test from 'node:test';
import assert from 'node:assert/strict';
import { copyNotion, collections } from '../scripts/copy-notion-to-d1.mjs';

function harness({ issue = false, repeat = false, surplus = false } = {}) {
  const calls = [], saved = new Map(), props = new Map(), pending = new Set();
  const id = 'a'.repeat(32);
  const sources = Object.fromEntries(Object.values(collections).map(k => [k, id]));
  const stats = { by: Object.keys(collections).map(collection => ({collection, body_status:'done', n:surplus ? 3 : 2})), conv:{errors:0,truncated:0,missing_texts:0,lossy: issue ? {image:1} : {}} };
  const api = async (path, body) => {
    calls.push({path,body});
    const url = new URL(path, 'https://test/'), name = url.pathname.slice(1), coll = url.searchParams.get('coll');
    if (name === 'stats') return stats;
    if (name === 'init') return {ok:true};
    if (name === 'props') {
      props.set(coll, (props.get(coll) || 0) + 1);
      return {n:1,next:repeat || props.get(coll) === 1 ? 'cursor-2' : null};
    }
    if (name === 'pending') {
      if (pending.has(coll)) return {ids:[]};
      pending.add(coll); return {ids:[id]};
    }
    if (name === 'body') return {id,lossy: issue ? {image:1} : {}};
    if (name === 'export') return {files:[{name:'ignored.md',text:'one'},{name:'ignored2.md',text:'two'}],next:null};
    throw new Error(`unexpected ${path}`);
  };
  return {calls,saved,sources,api,save:async (name, value) => saved.set(name,structuredClone(value)),delay:async () => {}};
}

test('全6DBをページ分割してコピーし、本文・件数を確認して保存する', async () => {
  const h = harness(), report = await copyNotion(h);
  assert.equal(report.copy_ok,true);
  assert.equal(report.collections.habit_log.queried,2);
  assert.equal(report.collections.habit_log.bodies,1);
  assert.equal(h.saved.get('report.json').copy_ok,true);
  assert.equal(h.calls.filter(c=>c.path.startsWith('props?')).length,12);
  assert.ok(h.calls.filter(c=>c.path.startsWith('props?')).every(c=>c.path.includes('ds=')));
  assert.ok(h.calls.every(c=>!/reset|import|\/done|\/ai/.test(c.path)));
});

test('変換欠落またはコピー件数の不一致を成功にしない', async () => {
  for (const opts of [{issue:true},{surplus:true}]) {
    const h = harness(opts), report = await copyNotion(h);
    assert.equal(report.copy_ok,false);
    assert.ok(h.saved.has('habit_log-00001.json'));
  }
});

test('同じNotionカーソルの繰り返しを停止する', async () => {
  const h = harness({repeat:true});
  await assert.rejects(copyNotion(h), /Repeated Notion cursor/);
  assert.equal(h.calls.filter(c=>c.path.startsWith('props?')).length,2);
});

test('途中のAPI障害を成功にせず、次のDBに進まない', async () => {
  const h = harness(), original = h.api;
  h.api = async (path, body) => {
    if (path.startsWith('body?')) throw new Error('body: HTTP 503');
    return original(path,body);
  };
  await assert.rejects(copyNotion(h), /HTTP 503/);
  assert.ok(h.saved.has('report.json'));
  assert.ok(!h.calls.some(c=>c.path.includes('coll=projects')));
});
