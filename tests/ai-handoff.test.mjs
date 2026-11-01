import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';

const html = readFileSync(new URL('../src/app.html', import.meta.url), 'utf8');
const part = (from, to) => html.slice(html.indexOf(from), html.indexOf(to));
const helpers = part('  // ---- AI app routing (', '  // ---- end AI app routing ----');
const ui = part('  // ---- AI handoff UI ----', '  // ---- end AI handoff UI ----');
const go = part('  function goClaude(', '  // ---- AI handoff UI ----');
const aiHref = html.match(/  function aiHref\(.*\n/)[0];
const task = { id:'a'.repeat(32), name:'日本語 <タスク> & "題名"', url:'https://www.notion.so/test' };
function harness({ saved, android = false, mac = false, clipboard = async () => {} } = {}) {
  const nodes = new Map(), listeners = [], calls = [], store = new Map(saved ? [['kairos_ai_app', saved]] : []);
  const node = (key) => {
    if (!nodes.has(key)) nodes.set(key, { value:'', textContent:'', open:false, hidden:true,
      showModal() { this.open = true; }, close() { this.open = false; },
      focus() { this.focused = true; }, select() { this.selected = true; } });
    return nodes.get(key);
  };
  const context = {
    history:{state:null,pushState(s){this.state=s;},back(){}}, URL, isAndroid:android, isMac:mac, ICONS:{claude:'claude-icon'},
    localStorage:{getItem:k=>store.get(k),setItem:(k,v)=>store.set(k,v)},
    $:node, document:{addEventListener:(...args)=>listeners.push(args)},
    navigator:{clipboard:{writeText:clipboard}}, location:{href:'unchanged'},
    markAi:(...args)=>calls.push(['mark', ...args]), copyPrompt:()=>calls.push(['copy']),
    render:()=>calls.push(['render']), openSheet:()=>calls.push(['sheet']), closeSheet:()=>calls.push(['close']),
    todayStr:'2026-10-17', lastSig:'old', sheetTask:task, task,
  };
  runInNewContext(helpers + aiHref + go + ui, context);
  const run = code => runInNewContext(code, context);
  return {run, context, node, calls, store, listeners};
}
const decode = href => JSON.parse(decodeURIComponent(href.slice('#ai-handoff='.length)));

test('既定はClaude。AndroidのintentとMacの既存起動方法を維持', () => {
  for (const [opts, prefix] of [[{},'https://claude.ai/new?q='],[{android:true},'intent://claude.ai/new?q='],[{mac:true},'claude://claude.ai/new?q=']]) {
    const h = harness(opts);
    assert.equal(h.run('aiProvider'), 'claude');
    assert.ok(h.run('claudeHref(task,"run")').startsWith(prefix));
    assert.match(h.run('taskPrompt(task,"run")'), /read_conversation/);
  }
  assert.equal(harness({saved:'invalid'}).run('aiProvider'), 'claude');
});

test('ChatGPT / Antigravityに同じタスク・先行順・更新依頼を渡す', () => {
  const h = harness();
  h.context.chain = [{name:'先行',url:'https://www.notion.so/predecessor'}];
  for (const provider of ['chatgpt','antigravity']) {
    h.run(`aiProvider = "${provider}"`);
    const d = decode(h.run('aiHref(task,"run",chain)'));
    assert.equal(d.provider, provider);
    assert.ok(d.prompt.includes(task.name)); assert.ok(d.prompt.includes(task.url));
    assert.ok(d.prompt.includes('先行（https://www.notion.so/predecessor）'));
    assert.match(d.prompt, /重複実行しない/); assert.doesNotMatch(d.prompt, /read_conversation|立っています/);
    assert.match(decode(h.run('aiHref(task,"update",chain)')).prompt, /内容を見直して更新/);
    assert.match(decode(h.run('aiHref(task,"update",chain)')).prompt, /サブタスク基準に当たれば、確認せずにサブタスクに分けて/);
  }
});

test('役割・見直し・PJの任意の依頼文も選択したアプリへ', () => {
  const h = harness({saved:'chatgpt'});
  assert.equal(decode(h.run('claudeLink("役割とプロジェクトを見直す")')).prompt, '役割とプロジェクトを見直す');
});

test('他社のセッションをClaudeへ変換せず、選択したAIと一致する時だけ再開', () => {
  const h = harness({mac:true});
  h.context.task = {...task, aiSession:'https://claude.ai/chat/example'};
  assert.ok(h.run('aiHref(task)').startsWith('claude://claude.ai/chat/'));
  h.run('aiProvider="chatgpt"');
  assert.equal(decode(h.run('aiHref(task)')).session, null);
  h.context.task.aiSession = 'https://chatgpt.com/c/example';
  assert.equal(decode(h.run('aiHref(task)')).session, h.context.task.aiSession);
  assert.equal(h.run('sessionHref(task.aiSession)'), h.context.task.aiSession);
  assert.equal(decode(h.run('claudeHref(task,"run")')).session, null, '新しいチャットには既存セッションを引き継がない');
  h.run('aiProvider="claude"');
  assert.ok(h.run('aiHref(task)').startsWith('claude://claude.ai/new?'));
  for (const url of ['javascript:alert(1)','https://claude.ai.evil.test/chat/1','http://chatgpt.com/c/1','https://user:password@chatgpt.com/c/1']) {
    h.context.bad = url; assert.equal(h.run('sessionHref(bad)'), '#');
  }
});

test('別AIへのタップとスワイプでは処理中のAPI更新も外部送信もしない', () => {
  const h = harness({saved:'chatgpt'});
  h.run('goClaude(task, aiHref(task))');
  assert.equal(h.node('#aiHandoff').open, true);
  assert.equal(h.context.location.href, 'unchanged');
  assert.equal(h.calls.length, 0);
  assert.equal(h.node('#aiOpen').href, 'https://chatgpt.com/');
  assert.doesNotMatch(h.node('#aiOpen').href, /codex|q=/);
});

test('キャプチャで既存の処理中onclickより先に受け渡しを開く', () => {
  const h = harness({saved:'antigravity'}), flags = [];
  const [, handler, capture] = h.listeners.find(([name])=>name==='click');
  assert.equal(capture, true);
  handler({target:{closest:()=>({getAttribute:()=>h.run('aiHref(task)')})},
    preventDefault:()=>flags.push('prevent'),stopImmediatePropagation:()=>flags.push('stop')});
  assert.deepEqual(flags,['prevent','stop']); assert.equal(h.calls.length,0);
  assert.equal(h.node('#aiOpen').href,'https://antigravity.google/');
  assert.match(h.node('#aiHandoffHelp').textContent,/Mac/);
});

test('コピー成功と失敗を区別し、失敗時は手動コピーできる', async () => {
  for (const fail of [false,true]) {
    let copied;
    const h = harness({saved:'chatgpt', clipboard:async text=>{if(fail) throw Error('denied'); copied=text;}});
    h.run('openAiHandoff(aiHref(task))');
    await h.node('#aiCopy').onclick();
    if (fail) {
      assert.match(h.node('#aiCopyStatus').textContent,/コピーできませんでした/);
      assert.equal(h.node('#aiHandoffText').selected,true);
    } else {
      assert.equal(copied,h.node('#aiHandoffText').value);
      assert.match(h.node('#aiCopyStatus').textContent,/コピーしました/);
    }
    assert.equal(h.calls.length,0);
  }
});

test('選択だけを保存し依頼文を保存しない。リンクを再描画する', () => {
  const h = harness(); h.node('#aiProvider').value='chatgpt'; h.node('#aiProvider').onchange();
  assert.equal(h.run('aiProvider'),'chatgpt'); assert.equal(h.store.get('kairos_ai_app'),'chatgpt');
  assert.equal(h.store.size,1); assert.equal(h.context.lastSig,''); assert.deepEqual(h.calls,[['render']]);
});

test('保存済みの別AIチャットを開くだけでは処理中にしない', () => {
  const handler = html.match(/    const rs = .*\n/)[0];
  for (const provider of ['claude', 'chatgpt', 'antigravity']) {
    const calls = [], link = {};
    const context = {
      $: () => ({querySelector: () => link}), t: {aiSession: provider},
      sessionProvider: value => value,
      markAi: () => calls.push('mark'), setTimeout: () => {},
    };
    runInNewContext(handler, context);
    link.onclick?.();
    assert.equal(calls.length, provider === 'claude' ? 1 : 0);
  }
});

test('D1モードの依頼文はD1の正本と認証付きAPIを示し、Notionの更新を求めない',()=>{
 const h=harness({saved:'chatgpt'});
 h.context.window={KAIROS_STORAGE:'d1'};h.context.location.origin='https://kairos.test';
 h.context.task={...task,url:'https://kairos.test/?page='+task.id};
 const d=decode(h.run('aiHref(task)'));
 assert.match(d.prompt,/【保存先: Kairos D1】/);
 assert.match(d.prompt,/Notionのコピーを更新しない/);
 assert.match(d.prompt,/https:\/\/kairos.test\/api\/storage\/agent/);
 assert.doesNotMatch(d.prompt,/Notionを更新できる場合/);
 assert.equal((d.prompt.match(/【保存先: Kairos D1】/g)||[]).length,1);
});

test('Macは日本語・改行を保持する依頼文付きリンク、既存チャットは継続',()=>{
 const h=harness({saved:'chatgpt',mac:true});
 h.run('openAiHandoff(aiHref(task))');
 assert.equal(decodeURIComponent(h.node('#aiOpen').href.split('?prompt=')[1]),h.node('#aiHandoffText').value);
 assert.ok(h.node('#aiOpen').href.startsWith('codex://new?prompt='));
 assert.equal(h.node('#aiOpen').target,'_self');
 assert.equal(h.node('#aiShare').hidden,true);
 h.context.task={...task,aiSession:'https://chatgpt.com/c/example'};
 h.run('openAiHandoff(aiHref(task))');
 assert.equal(h.node('#aiOpen').href,'https://chatgpt.com/c/example');
 assert.equal(h.node('#aiOpen').target,'_blank');
 assert.equal(h.calls.length,0);
});

test('Androidは共有対応時だけ表示し、取消・失敗を成功としない',async()=>{
 const h=harness({saved:'chatgpt',android:true});
 h.run('openAiHandoff(aiHref(task))');
 assert.equal(h.node('#aiShare').hidden,true);
 let received;
 h.context.navigator.share=async data=>{received=data.text;};
 h.run('openAiHandoff(aiHref(task))');
 assert.equal(h.node('#aiShare').hidden,false);
 await h.node('#aiShare').onclick();
 assert.equal(received,h.node('#aiHandoffText').value);
 assert.equal(h.node('#aiOpen').href,'https://chatgpt.com/');
 for(const name of ['AbortError','NotAllowedError']){
  h.context.navigator.share=async()=>{const e=new Error();e.name=name;throw e;};
  await h.node('#aiShare').onclick();
  assert.match(h.node('#aiCopyStatus').textContent,name==='AbortError'?/キャンセル/:/共有できませんでした/);
 }
 assert.equal(h.calls.length,0);
 h.run('aiProvider="antigravity";openAiHandoff(aiHref(task))');
 assert.equal(h.node('#aiShare').hidden,true);
});

test('更新の続き（前回のセッション）の文面にもサブタスク基準を含める', () => {
  // aiPrompt は harness に読み込んでいないので、関数の本体を source から確かめる
  const body = html.slice(html.indexOf('function aiPrompt('), html.indexOf('function copyPrompt('));
  assert.match(body, /サブタスク基準に当たれば確認せずに分けて/);
});
