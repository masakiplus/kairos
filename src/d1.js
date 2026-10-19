// D1 is the source of truth in DATA_BACKEND=d1. Notion is used only by explicit
// migration endpoints while the backend is still notion; there is no read fallback.
import { nget, completeRelations } from './lab.js';
export const collectionVars = {tasks:'TASKS_DATA_SOURCE_ID',projects:'PROJECTS_DATA_SOURCE_ID',roles:'ROLES_DATA_SOURCE_ID',decisions:'DECISIONS_DATA_SOURCE_ID',habits:'HABITS_DATA_SOURCE_ID',habit_log:'HABIT_LOG_DATA_SOURCE_ID'};
export const cleanId = x => String(x || '').replace(/-/g,'').toLowerCase();
// 6つの中核コレクション以外(Sessions・Daily など)を登録できる。名前は小文字英数字と _ だけ(予約語は不可)。
export const reservedCollections = new Set(['pages','nested',...Object.keys(collectionVars)]);
export const isExtraName = n => /^[a-z][a-z0-9_]{1,31}$/.test(n || '') && !reservedCollections.has(n);
// データソース ID から collection 名を引く。中核は環境変数、それ以外は entity_schemas に登録された名前。
export async function isExtraEntity(env,id) {
 const row=await env.DB.prepare('SELECT collection FROM entities WHERE id=?').bind(id).first();
 return !!row && !(row.collection in collectionVars) && !['pages','nested'].includes(row.collection);
}
export async function collectionOfSource(env,source) {
 const s=cleanId(source);
 const core=Object.entries(collectionVars).find(([,key])=>cleanId(env[key])===s)?.[0];
 if(core)return core;
 const row=await env.DB.prepare('SELECT collection FROM entity_schemas WHERE id=?').bind(s).first();
 return row?.collection || null;
}
const schema = [
 `CREATE TABLE IF NOT EXISTS entities(id TEXT PRIMARY KEY, ds TEXT, collection TEXT NOT NULL, payload TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1)`,
 `CREATE INDEX IF NOT EXISTS entities_ds ON entities(ds)`,
 `CREATE INDEX IF NOT EXISTS entities_revision ON entities(revision)`,
 `CREATE TABLE IF NOT EXISTS entity_schemas(id TEXT PRIMARY KEY, collection TEXT NOT NULL, payload TEXT NOT NULL)`,
 `CREATE TABLE IF NOT EXISTS entity_links(from_id TEXT NOT NULL, prop TEXT NOT NULL, to_id TEXT NOT NULL, PRIMARY KEY(from_id,prop,to_id))`,
 `CREATE INDEX IF NOT EXISTS entity_links_to ON entity_links(to_id)`,
 `CREATE TABLE IF NOT EXISTS entity_children(parent_id TEXT NOT NULL, id TEXT NOT NULL, position INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(parent_id,id))`,
 `CREATE TABLE IF NOT EXISTS entity_bodies(id TEXT PRIMARY KEY, complete INTEGER NOT NULL DEFAULT 0)`,
 `CREATE TABLE IF NOT EXISTS entity_body_versions(id TEXT PRIMARY KEY, updated TEXT)`,
 `CREATE TABLE IF NOT EXISTS entity_databases(id TEXT PRIMARY KEY, payload TEXT NOT NULL)`,
 `CREATE TABLE IF NOT EXISTS entity_assets(id TEXT PRIMARY KEY, mime TEXT, size INTEGER, name TEXT, complete INTEGER NOT NULL DEFAULT 0)`,
 `CREATE TABLE IF NOT EXISTS entity_asset_chunks(id TEXT NOT NULL, part INTEGER NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY(id,part))`,
 `CREATE TABLE IF NOT EXISTS storage_control(key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
 `INSERT OR IGNORE INTO storage_control VALUES('rev','0')`,
];
export async function initD1(env) {for(const sql of schema) await env.DB.prepare(sql).run();}
const rt = a => (a || []).map(x=>x.plain_text ?? x.text?.content ?? '').join('');
const sourceIds = new WeakMap();
export async function d1Environment(env) {
 let cached=sourceIds.get(env.DB);
 if(!cached || Date.now()-cached.at>5000) {cached={at:Date.now(),promise:env.DB.batch([env.DB.prepare('SELECT id,collection FROM entity_schemas'),env.DB.prepare("SELECT value FROM storage_control WHERE key='presence_page_id'")])};sourceIds.set(env.DB,cached);}
 const [sources,presence]=await cached.promise,copy={...env};
 for(const row of sources.results || [])if(collectionVars[row.collection])copy[collectionVars[row.collection]]=row.id;
 if(presence.results?.[0])copy.PRESENCE_PAGE_ID=presence.results[0].value;
 return copy;
}
const jsonPath = key => '$.properties.'+JSON.stringify(key);
function normalizeProperty(value, definition={}) {
 const type=value.type || definition.type || Object.keys(value).find(k=>k!=='id');
 const p={...value,type,id:definition.id || value.id};
 if(type==='title'||type==='rich_text') p[type]=(value[type] || []).map(x=>({...x,type:x.type || 'text',plain_text:x.plain_text ?? x.text?.content ?? '',annotations:x.annotations || {}}));
 if(type==='relation') {p.relation=(value.relation || []).map(x=>({id:x.id}));p.has_more=false;}
 return p;
}
function normalizeBlock(input) {
 const b=structuredClone(input),type=b.type || Object.keys(b).find(k=>['paragraph','heading_1','heading_2','heading_3','bulleted_list_item','numbered_list_item','to_do','quote','callout','toggle','code','divider','table','table_row','image','file','pdf'].includes(k));
 if(!type)throw new Error('Block type required');
 b.type=type;b.id ||= crypto.randomUUID();const v=b[type] || (b[type]={});
 for(const key of ['rich_text','caption'])if(v[key])v[key]=v[key].map(x=>({...x,type:x.type || 'text',plain_text:x.plain_text ?? x.text?.content ?? '',annotations:x.annotations || {}}));
 if(v.cells)v.cells=v.cells.map(cell=>cell.map(x=>({...x,type:x.type || 'text',plain_text:x.plain_text ?? x.text?.content ?? ''})));
 b.has_children=!!v.children?.length || !!b.has_children;return b;
}
function blockStatements(env,parent,inputs,start=0) {
 const blocks=inputs.map(normalizeBlock),stmts=[];
 const append=(pid,list,offset)=>list.forEach((b,i)=>{stmts.push(env.DB.prepare('INSERT INTO entity_children VALUES(?,?,?,?)').bind(pid,cleanId(b.id),offset+i,JSON.stringify(b)));const children=b[b.type]?.children || [];if(children.length){stmts.push(env.DB.prepare('INSERT OR REPLACE INTO entity_bodies VALUES(?,1)').bind(cleanId(b.id)));append(cleanId(b.id),children.map(normalizeBlock),0);}});
 append(parent,blocks,start);return {blocks,stmts};
}
async function storePage(env,page,coll,ds,existing,extra) {
 if(existing?.payload === JSON.stringify(page) && existing.collection === coll && existing.ds === cleanId(ds)) return;
 const stmts=[env.DB.prepare(`INSERT INTO entities(id,ds,collection,payload) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET ds=excluded.ds,collection=excluded.collection,payload=excluded.payload,revision=entities.revision+1`).bind(cleanId(page.id),cleanId(ds),coll,JSON.stringify(page))];
 for(const [name,p] of Object.entries(page.properties || {})) if(p.type==='relation') {
  stmts.push(env.DB.prepare('DELETE FROM entity_links WHERE from_id=? AND prop=?').bind(cleanId(page.id),name));
  for(const rel of p.relation || []) stmts.push(env.DB.prepare('INSERT OR IGNORE INTO entity_links VALUES(?,?,?)').bind(cleanId(page.id),name,cleanId(rel.id)));
 }
 if(extra) await env.DB.batch([...stmts,...extra]);
 else for(let i=0;i<stmts.length;i+=50) await env.DB.batch(stmts.slice(i,i+50));
}
export async function loadState(env,only=null) {
 const baseNames=[...Object.keys(collectionVars),'pages','nested'],scope=only?'e.ds=?':'e.collection IN ('+baseNames.map(()=>'?').join(',')+')',scopeArgs=only?[only]:baseNames; const [pages,links,schemas]=await env.DB.batch([
  env.DB.prepare('SELECT e.id,e.ds,e.collection,e.payload FROM entities e WHERE '+scope+' ORDER BY e.rowid').bind(...scopeArgs),
  env.DB.prepare('SELECT l.from_id,l.prop,l.to_id FROM entity_links l JOIN entities e ON e.id=l.from_id WHERE '+scope).bind(...scopeArgs),
  env.DB.prepare('SELECT id,payload FROM entity_schemas'),
 ]);
 const rows=new Map((pages.results || []).map(r=>[r.id,{...r,page:JSON.parse(r.payload)}]));
 const rels=new Map();for(const l of links.results || []) {const key=l.from_id+'|'+l.prop;if(!rels.has(key)) rels.set(key,[]);rels.get(key).push(l.to_id);}
 const ids=new Map([...rows].map(([id,r])=>[id,r.page.id]));
 for(const [id,r] of rows) for(const [name,p] of Object.entries(r.page.properties || {})) if(p.type==='relation') {const current=rels.get(id+'|'+name) || [],present=new Set(current),prior=(p.relation || []).map(x=>cleanId(x.id)),known=new Set(prior);p.relation=[...prior.filter(x=>present.has(x)),...current.filter(x=>!known.has(x))].map(x=>({id:ids.get(x) || x}));p.has_more=false;}
 const today=new Date(Date.now()+9*3600000).toISOString().slice(0,10);
 const inWeek=new Date(Date.parse(today+'T00:00:00Z')+7*86400000).toISOString().slice(0,10);
 const successorsById=new Map();
 for(const r of rows.values()) if(r.collection==='tasks') for(const p of r.page.properties?.['先行タスク']?.relation || []) {const key=cleanId(p.id);if(!successorsById.has(key))successorsById.set(key,[]);successorsById.get(key).push(r);}
 for(const r of rows.values()) if(r.collection==='tasks') {
  const p=r.page.properties;
  const blocked=(p['先行タスク']?.relation || []).filter(x=>rows.get(cleanId(x.id))?.page.properties?.['完了']?.checkbox!==true).length;
  // Reverse edges are also derived so imported one-sided relations remain visible.
  const successors=successorsById.get(cleanId(r.page.id)) || [];
  const successorIds=new Set(successors.map(x=>cleanId(x.page.id))),priorSuccessors=(p['後続タスク']?.relation || []).filter(x=>successorIds.has(cleanId(x.id))),knownSuccessors=new Set(priorSuccessors.map(x=>cleanId(x.id)));
  p['後続タスク']={...(p['後続タスク'] || {}),type:'relation',relation:[...priorSuccessors,...successors.filter(x=>!knownSuccessors.has(cleanId(x.page.id))).map(x=>({id:x.page.id}))],has_more:false};
  p['先行未完了数']={...(p['先行未完了数'] || {}),type:'rollup',rollup:{type:'number',number:blocked}};
  const start=p['開始日']?.date?.start?.slice(0,10),due=p['期日']?.date?.start?.slice(0,10);
  const ready=blocked?'先行待ち':!start||start<=today?'着手可':'待機';
  const excluded=(p['親アイテム']?.relation || []).length>0&&p['種類']?.select?.name==='購入';
  const dueClass=!due?'⑤日付なし':due<today?'①期限切れ':due===today?'②今日':due<=inWeek?'③今週':'④先';
  // （画面）の2列は Notion では UTC 基準だった。D1 では JST の値に揃える (2026-10-18)
  for(const [name,value] of Object.entries({'着手可否':ready,'着手可否（画面）':ready,'期限区分':dueClass,'期限区分（画面）':dueClass,'前倒し候補':ready==='着手可'&&!excluded&&(!due||(due>today&&due<=inWeek))?'候補':''})) if(name in p || !name.includes('（画面）')) p[name]={...(p[name] || {}),type:'formula',formula:{type:'string',string:value}};
  r.page.url=(env.KAIROS_ORIGIN || '')+'/?page='+r.id;
 }
 // Decisions の式 (検証待ち・判断可否) は取り込み時の値のまま止まるので、ここで JST の今日から計算する (2026-10-18)
 for(const r of rows.values()) if(r.collection==='decisions') {
  const p=r.page.properties || {};
  const state=p['状態']?.select?.name,verify=p['検証日']?.date?.start?.slice(0,10),result=p['検証結果']?.select?.name,start=p['開始日']?.date?.start;
  if('検証待ち' in p) p['検証待ち']={...p['検証待ち'],type:'formula',formula:{type:'string',string:state==='決着'&&verify&&!result&&verify<=today?'検証待ち':''}};
  if('判断可否' in p) p['判断可否']={...p['判断可否'],type:'formula',formula:{type:'string',string:!start||Date.now()>=Date.parse(start.length<=10?start+'T00:00:00+09:00':start)?'判断可':'判断待ち'}};
 }
 for(const r of rows.values()) r.page.url=(env.KAIROS_ORIGIN || '')+'/?page='+cleanId(r.page.id);
 return {rows,schemas:new Map((schemas.results || []).map(r=>[r.id,JSON.parse(r.payload)]))};
}
// The screen starts several requests together. Share one short-lived snapshot to
// avoid parsing the entire archive once per tab-count request in the same isolate.
const snapshots = new WeakMap();
// After the 1s window, reuse the parsed snapshot while a cheap fingerprint of the
// stored rows is unchanged (2026-10-18: a full reload per request made D1 lists ~1s).
// Every write path bumps entities.revision or replaces rows (new rowid), so any write
// from another isolate changes the fingerprint. The JST date is included because
// derived values (期限区分・着手可否・前倒し候補) depend on it. The fingerprint is taken
// before loading, so a write racing the load forces one extra reload, never a stale hit.
// One counter row that every write bumps (see revDB). Reading it costs 1 row, unlike the
// earlier aggregate fingerprint (~15k rows per request), which exhausted the free daily
// read quota on 2026-10-18.
const FINGERPRINT = "SELECT value FROM storage_control WHERE key='rev'";
async function fingerprint(env){const r=await env.DB.prepare(FINGERPRINT).first();if(!r)return null;return String(r.value)+'|'+new Date(Date.now()+9*3600000).toISOString().slice(0,10);}
const WRITE_SQL=/^\s*(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER)\b/i;
const BUMP="INSERT INTO storage_control(key,value) VALUES('rev','1') ON CONFLICT(key) DO UPDATE SET value=CAST(value AS INTEGER)+1";
const revProxies=new WeakMap();
/** Wrap a D1 binding so every write (run() of a write statement, or a batch containing one)
 *  also bumps storage_control.rev in the same batch. Other isolates compare that one row to
 *  decide whether their parsed snapshot is still current. */
export function revDB(db){
 if(!db||db.__rev)return db;
 if(revProxies.has(db))return revProxies.get(db);
 const tag=(st,write)=>new Proxy(st,{get(t,k){
  if(k==='__write')return write;
  if(k==='__raw')return t;
  if(k==='bind')return (...v)=>tag(t.bind(...v),write);
  if(k==='run'&&write)return async()=>{const out=await db.batch([t,db.prepare(BUMP)]);return out[0];};
  const v=t[k];return typeof v==='function'?v.bind(t):v;}});
 const proxy=new Proxy(db,{get(t,k){
  if(k==='__rev')return true;
  if(k==='prepare')return sql=>tag(t.prepare(sql),WRITE_SQL.test(sql)&&!/storage_control/i.test(sql.slice(0,60)));
  if(k==='batch')return async stmts=>{const raw=stmts.map(s=>s?.__raw||s);if(!stmts.some(s=>s?.__write))return t.batch(raw);const out=await t.batch([...raw,t.prepare(BUMP)]);return out.slice(0,raw.length);};
  const v=t[k];return typeof v==='function'?v.bind(t):v;}});
 revProxies.set(db,proxy);return proxy;
}
function requestState(env) {
 const current=snapshots.get(env.DB),now=Date.now();
 if(current&&(current.pending||now-current.at<1000))return current.promise;
 const entry={at:now,pending:true};
 entry.promise=(async()=>{
  const fp=await fingerprint(env).catch(()=>null);
  entry.fp=fp;
  if(fp&&current&&current.fp===fp){entry.reused=true;return current.promise;}
  return loadState(env);
 })();
 snapshots.set(env.DB,entry);
 entry.promise.then(()=>{entry.pending=false;entry.at=Date.now();},()=>snapshots.delete(env.DB));return entry.promise;
}
function invalidate(env){env.__d1State=null;snapshots.delete(env.DB);}
async function freshPage(env,id) {
 const row=await env.DB.prepare('SELECT collection,payload FROM entities WHERE id=?').bind(id).first();
 if(!row)throw new Error('D1 page not found');
 const page=JSON.parse(row.payload),p=page.properties || {};
 const links=(await env.DB.prepare("SELECT l.prop,l.to_id,json_extract(t.payload,'$.id') target_id FROM entity_links l LEFT JOIN entities t ON t.id=l.to_id WHERE l.from_id=? ORDER BY l.rowid").bind(id).all()).results;
 for(const [name,value] of Object.entries(p))if(value.type==='relation') {
  const current=links.filter(l=>l.prop===name),byId=new Map(current.map(l=>[l.to_id,l.target_id || l.to_id])),old=(value.relation || []).map(r=>cleanId(r.id));
  value.relation=[...old.filter(k=>byId.has(k)),...current.map(l=>l.to_id).filter(k=>!old.includes(k))].map(k=>({id:byId.get(k)}));value.has_more=false;
 }
 if(row.collection==='tasks') {
  const blocked=await env.DB.prepare(`SELECT COUNT(*) n FROM entity_links l LEFT JOIN entities p ON p.id=l.to_id WHERE l.from_id=? AND l.prop='先行タスク' AND COALESCE(json_extract(p.payload,'$.properties."完了".checkbox'),0)!=1`).bind(id).first();
  const successors=(await env.DB.prepare("SELECT json_extract(e.payload,'$.id') id FROM entity_links l JOIN entities e ON e.id=l.from_id WHERE l.to_id=? AND l.prop='先行タスク' AND e.collection='tasks' ORDER BY l.rowid").bind(id).all()).results;
  const prior=p['後続タスク']?.relation || [],successorMap=new Map(successors.map(r=>[cleanId(r.id),r.id])),known=new Set(prior.map(r=>cleanId(r.id)));
  p['後続タスク']={type:'relation',relation:[...prior.filter(r=>successorMap.has(cleanId(r.id))),...successors.filter(r=>!known.has(cleanId(r.id)))],has_more:false};
  const today=new Date(Date.now()+9*3600000).toISOString().slice(0,10),week=new Date(Date.parse(today+'T00:00:00Z')+7*86400000).toISOString().slice(0,10),start=p['開始日']?.date?.start?.slice(0,10),due=p['期日']?.date?.start?.slice(0,10);
  const ready=blocked.n?'先行待ち':!start||start<=today?'着手可':'待機',excluded=(p['親アイテム']?.relation || []).length>0&&p['種類']?.select?.name==='購入';
  p['先行未完了数']={type:'rollup',rollup:{type:'number',number:blocked.n}};
  for(const [name,value] of Object.entries({'着手可否':ready,'期限区分':!due?'⑤日付なし':due<today?'①期限切れ':due===today?'②今日':due<=week?'③今週':'④先','前倒し候補':ready==='着手可'&&!excluded&&(!due||(due>today&&due<=week))?'候補':''}))p[name]={type:'formula',formula:{type:'string',string:value}};
 }
 page.url=(env.KAIROS_ORIGIN || '')+'/?page='+id;return page;
}
function propertyValue(p) {
 if(!p) return null;
 switch(p.type) {
 case 'title':case 'rich_text':return rt(p[p.type]);
 case 'select':case 'status':return p[p.type]?.name ?? null;
 case 'multi_select':return (p.multi_select || []).map(x=>x.name);
 case 'relation':return (p.relation || []).map(x=>cleanId(x.id));
 case 'date':return p.date?.start ?? null;
 case 'formula':return p.formula?.[p.formula.type] ?? null;
 case 'rollup':return p.rollup?.[p.rollup.type] ?? null;
 default:return p[p.type] ?? null;
 }
}
export function matches(page,f) {
 if(!f) return true;
 if(f.and) return f.and.every(x=>matches(page,x));if(f.or) return f.or.some(x=>matches(page,x));
 const type=Object.keys(f).find(k=>k!=='property'&&k!=='timestamp');
 let condition=f[type],value=f.timestamp?page[f.timestamp]:propertyValue(page.properties?.[f.property]);
 if(type==='formula') condition=condition[Object.keys(condition)[0]];
 for(const [op,expected] of Object.entries(condition || {})) {
  const empty=value==null||value===''||(Array.isArray(value)&&!value.length);
  const date=type==='date'||f.timestamp;
  const a=date?String(value || '').slice(0,10):value;
  const b=type==='relation'?cleanId(expected):date?String(expected).slice(0,10):expected;
  let ok;
  switch(op){
   case 'equals':ok=a===b;break;case 'does_not_equal':ok=a!==b;break;
   case 'is_empty':ok=empty===expected;break;case 'is_not_empty':ok=!empty===expected;break;
   case 'contains':ok=Array.isArray(a)?a.includes(b):String(a || '').toLocaleLowerCase().includes(String(b).toLocaleLowerCase());break;
   case 'does_not_contain':ok=Array.isArray(a)?!a.includes(b):!String(a || '').toLocaleLowerCase().includes(String(b).toLocaleLowerCase());break;
   case 'on_or_after':case 'greater_than_or_equal_to':ok=!empty&&a>=b;break;
   case 'on_or_before':case 'less_than_or_equal_to':ok=!empty&&a<=b;break;
   case 'after':case 'greater_than':ok=!empty&&a>b;break;case 'before':case 'less_than':ok=!empty&&a<b;break;
   default:throw new Error('Unsupported D1 filter: '+op);
  }
  if(!ok) return false;
 }
 return true;
}
function paged(items,args) {
 const offset=args.start_cursor?Number(String(args.start_cursor).replace(/^d1:/,'')):0;
 if(!Number.isSafeInteger(offset)||offset<0)throw new Error('Invalid D1 cursor');
 const size=Math.min(100,Math.max(1,Number(args.page_size)||100)),end=offset+size;
 return {object:'list',results:items.slice(offset,end),has_more:end<items.length,next_cursor:end<items.length?'d1:'+end:null};
}
// 中核以外(sessions など)の行は共有スナップショットに載せず、対象のデータソースを触る要求のときだけ足す (2026-10-20)
async function extraTargetDs(env,state,pathname,args,method) {
 let ds=null,m;
 if((m=pathname.match(/^\/data_sources\/([^/]+)/)))ds=cleanId(m[1]);
 else if((m=pathname.match(/^\/pages\/([^/]+)$/))){const id=cleanId(m[1]);if(state.rows.has(id))return null;ds=(await env.DB.prepare('SELECT ds FROM entities WHERE id=?').bind(id).first())?.ds || null;}
 else if(pathname==='/pages'&&method==='POST')ds=cleanId(args.parent?.data_source_id);
 if(!ds)return null;
 const core=Object.values(collectionVars).map(k=>cleanId(env[k]));
 return core.includes(ds)?null:ds;
}
export async function d1Notion(env,path,init={}) {
 const url=new URL('https://d1.local'+path),method=init.method || 'GET';
 const args=init.body?JSON.parse(init.body):Object.fromEntries(url.searchParams);
 let state=/^\/blocks\//.test(url.pathname)?null:await (env.__d1State ||= requestState(env));
 if(state){const xds=await extraTargetDs(env,state,url.pathname,args,method);if(xds){const ex=await loadState(env,xds);state={rows:new Map([...state.rows,...ex.rows]),schemas:state.schemas};}}
 if(env.D1_READ_ONLY&&((method==='PATCH')||(method==='POST'&&url.pathname==='/pages')))throw new Error('D1 preview is read only');
 let m;
 if((m=url.pathname.match(/^\/data_sources\/([^/]+)(\/query)?$/))) {
  const ds=cleanId(m[1]);
  if(!state.schemas.has(ds))throw new Error('D1 data source is not migrated');
  if(!m[2])return state.schemas.get(ds);
  let rows=[...state.rows.values()].filter(r=>r.ds===ds&&!r.page.archived&&!r.page.in_trash).map(r=>r.page).filter(p=>matches(p,args.filter));
  rows.sort((a,b)=>{for(const s of args.sorts || []) {const x=s.timestamp?a[s.timestamp]:propertyValue(a.properties?.[s.property]),y=s.timestamp?b[s.timestamp]:propertyValue(b.properties?.[s.property]);let cmp=x==null?(y==null?0:1):y==null?-1:typeof x==='number'||typeof x==='boolean'?Number(x)-Number(y):String(x).localeCompare(String(y),'ja');if(cmp)return s.direction==='descending'?-cmp:cmp;}return 0;});
  return paged(rows,args);
 }
 if((m=url.pathname.match(/^\/pages\/([^/]+)$/))) {
  const id=cleanId(m[1]),row=state.rows.get(id);if(!row)throw new Error('D1 page not found');
  if(method==='GET')return row.page;
  if(method!=='PATCH')throw new Error('Unsupported D1 page operation');
  if(row.collection==='roles'&&Object.keys(args.properties || {}).some(k=>k!=='今週の目標'))throw new Error('Roles only allow 今週の目標');
  if(row.collection==='projects'&&Object.keys(args.properties || {}).some(k=>k!=='ステータス'))throw new Error('Projects only allow ステータス');
  const definition=state.schemas.get(row.ds)?.properties || {},stmts=[],paths=[],values=[];
  for(const key of Object.keys(args))if(!['properties','icon'].includes(key))throw new Error('Unsupported D1 page field: '+key);
  if('icon' in args){paths.push('?,json(?)');values.push('$.icon',JSON.stringify(args.icon ?? null));}
  for(const [name,input] of Object.entries(args.properties || {})) {
   const p=normalizeProperty(input,definition[name] || row.page.properties?.[name]);
   if(['formula','rollup'].includes(p.type))throw new Error('Computed properties are read only');
   paths.push('?,json(?)');values.push(jsonPath(name),JSON.stringify(p));
   if(p.type==='relation') {
    if(name==='先行タスク') {
     const seen=new Set();
     const visit=target=>{target=cleanId(target);if(target===id)throw new Error('Dependency cycle');if(seen.has(target))return;seen.add(target);for(const r of state.rows.get(target)?.page.properties?.['先行タスク']?.relation || [])visit(r.id);};
     for(const r of p.relation)visit(r.id);
    }
    const reciprocal=definition[name]?.relation?.dual_property?.synced_property_name;
    const targetDS=definition[name]?.relation?.data_source_id;
    stmts.push(env.DB.prepare('DELETE FROM entity_links WHERE from_id=? AND prop=?').bind(id,name));
    if(reciprocal)stmts.push(env.DB.prepare('DELETE FROM entity_links WHERE to_id=? AND prop=?').bind(id,reciprocal));
    for(const rel of p.relation) {
     const target=state.rows.get(cleanId(rel.id));if(!target)throw new Error('Relation target is not migrated');
     if(targetDS&&target.ds!==cleanId(targetDS))throw new Error('Relation data source mismatch');
     stmts.push(env.DB.prepare('INSERT OR IGNORE INTO entity_links VALUES(?,?,?)').bind(id,name,cleanId(rel.id)));
     if(reciprocal) stmts.push(env.DB.prepare('INSERT OR IGNORE INTO entity_links VALUES(?,?,?)').bind(cleanId(rel.id),reciprocal,id));
    }
   }
  }
  if(paths.length)stmts.unshift(env.DB.prepare(`UPDATE entities SET payload=json_set(payload,${paths.join(',')},'$.last_edited_time',?), revision=revision+1 WHERE id=?`).bind(...values,new Date().toISOString(),id));
  if(stmts.length)await env.DB.batch(stmts);
  invalidate(env); return freshPage(env,id);
 }
 if(path==='/pages'&&method==='POST') {
  const ds=cleanId(args.parent?.data_source_id),definition=state.schemas.get(ds);if(!definition)throw new Error('Unknown D1 data source');
  const props={};for(const [name,def] of Object.entries(definition.properties || {})) {
   const defaults={title:[],rich_text:[],relation:[],multi_select:[],checkbox:false};
   props[name]=normalizeProperty(args.properties?.[name] || {[def.type]:defaults[def.type] ?? null},def);
  }
  const id=crypto.randomUUID(),now=new Date().toISOString();
  const page={object:'page',id,created_time:now,last_edited_time:now,archived:false,in_trash:false,icon:args.icon || null,parent:args.parent,properties:props,url:'/api/page/'+cleanId(id)};
  const coll=(await collectionOfSource(env,ds)) || 'pages';
  const extra=[env.DB.prepare('INSERT INTO entity_bodies VALUES(?,1)').bind(cleanId(id)),env.DB.prepare('INSERT INTO entity_body_versions VALUES(?,?)').bind(cleanId(id),now),...blockStatements(env,cleanId(id),args.children || []).stmts];
  for(const [name,p] of Object.entries(props))if(p.type==='relation')for(const rel of p.relation){const target=state.rows.get(cleanId(rel.id));if(!target)throw new Error('Relation target is not migrated');const reciprocal=definition.properties[name]?.relation?.dual_property?.synced_property_name;if(reciprocal)extra.push(env.DB.prepare('INSERT OR IGNORE INTO entity_links VALUES(?,?,?)').bind(cleanId(rel.id),reciprocal,cleanId(id)));}
  await storePage(env,page,coll,ds,undefined,extra);
  invalidate(env); return freshPage(env,cleanId(id));
 }
 if((m=url.pathname.match(/^\/blocks\/([^/]+)\/children$/))) {
  const parent=cleanId(m[1]);
  const body=await env.DB.prepare('SELECT complete FROM entity_bodies WHERE id=?').bind(parent).first();
  if(!body?.complete)throw new Error('D1 body has not been migrated');
  const rows=await env.DB.prepare('SELECT payload FROM entity_children WHERE parent_id=? ORDER BY position,id').bind(parent).all();
  if(method==='GET'){const assets=await env.DB.prepare('SELECT id FROM entity_assets WHERE complete=1').all();const saved=new Set((assets.results || []).map(a=>a.id));return paged((rows.results || []).map(r=>{const b=JSON.parse(r.payload);if(saved.has(cleanId(b.id))) {const v=b[b.type],href=(env.KAIROS_ORIGIN || '')+'/api/storage/files/'+cleanId(b.id);if(v.file)v.file.url=href;else v.external={url:href};}return b;}),args);}
  if(method==='PATCH') {
   const offset=(rows.results || []).length,{blocks,stmts}=blockStatements(env,parent,args.children || [],offset);
   stmts.push(env.DB.prepare("UPDATE entities SET payload=json_set(payload,'$.last_edited_time',?),revision=revision+1 WHERE id=?").bind(new Date().toISOString(),parent));
   await env.DB.batch(stmts);
   invalidate(env);
   return {results:blocks};
  }
 }
 throw new Error('Unsupported D1 operation: '+method+' '+url.pathname);
}

export async function storageRoute(req,env,url,json) {
 const path=url.pathname,ctx={calls:0};
 if(path==='/api/storage/agent')return json({backend:env.DATA_BACKEND || 'notion',authentication:'Existing Kairos HttpOnly cookie or Authorization: Bearer APP_TOKEN. Never put credentials in URLs or prompts.',sources:'/api/storage/sources',read:'GET /api/data/pages/:id',query:'POST /api/data/data_sources/:id/query',update:'PATCH /api/data/pages/:id {properties:{...}}',create:'POST /api/data/pages {parent:{data_source_id},properties:{...}}',body:'GET or PATCH /api/data/blocks/:id/children; PATCH appends Notion-shaped blocks',rules:['Do not update Notion: D1 is the source of truth.','Complete tasks through POST /api/tasks/:id/done so completion date and status are set together.','Use POST /api/tasks/:id/restore for undo.','Preserve existing body and reasons. Never claim an operation succeeded unless the API succeeded.','Roles: change 今週の目標 only. Projects: change ステータス only.','AI handoff (§11): a task handed to AI has AI処理開始 set. Write this chat URL to AIセッション first. When finished, stopped or failed, clear AI処理開始 (POST /api/tasks/:id/done clears it automatically; otherwise POST /api/tasks/:id/ai-clear).','If a human is needed and work stops, POST /api/tasks/:id/human so ステータス becomes 人対応 and AI処理開始 is cleared.','To clear a property through PATCH /api/data/pages/:id use the typed shape, e.g. {date:null}, {select:null}, {multi_select:[]}; a bare null is rejected.'],mcp:'/mcp (OAuth connector for claude.ai; see docs/mcp.md)',note:'External Notion jobs must be migrated explicitly; they are not synchronized.'});
 if(path==='/api/storage/sources'){const core=Object.entries(collectionVars).map(([collection,key])=>({collection,id:env[key]}));const extra=(await env.DB.prepare("SELECT id,collection FROM entity_schemas WHERE collection NOT IN ('nested','pages') ORDER BY collection").all()).results.filter(r=>!collectionVars[r.collection]).map(r=>({collection:r.collection,id:r.id}));return json({sources:[...core,...extra]});}
 if(path==='/api/storage/audit') {
  const pending=(await env.DB.prepare('SELECT e.id FROM entities e LEFT JOIN entity_bodies b ON b.id=e.id WHERE COALESCE(b.complete,0)=0').all()).results;
  const children=(await env.DB.prepare(`SELECT c.id FROM entity_children c LEFT JOIN entity_bodies b ON b.id=c.id WHERE json_extract(c.payload,'$.has_children')=1 AND json_extract(c.payload,'$.type') NOT IN ('child_page','child_database') AND COALESCE(b.complete,0)=0`).all()).results;
  const partial=(await env.DB.prepare(`SELECT DISTINCT e.id FROM entities e,json_each(e.payload,'$.properties') p WHERE json_extract(p.value,'$.type')='relation' AND json_extract(p.value,'$.has_more')=1`).all()).results;
  const assets=(await env.DB.prepare(`SELECT c.id FROM entity_children c LEFT JOIN entity_assets a ON a.id=c.id WHERE json_extract(c.payload,'$.type') IN ('pdf','file','image','audio','video') AND COALESCE(a.complete,0)=0`).all()).results;
  const outdated=(await env.DB.prepare(`SELECT e.id FROM entities e LEFT JOIN entity_body_versions b ON b.id=e.id WHERE b.updated IS NULL OR b.updated!=json_extract(e.payload,'$.last_edited_time')`).all()).results;
  const sources=(await env.DB.prepare('SELECT collection,COUNT(*) n FROM entities GROUP BY collection').all()).results;
  const state=await requestState(env),formulaDiffs=[];
  for(const [id,row] of state.rows)if(row.collection==='tasks') {const original=JSON.parse(row.payload).properties || {},fields=['着手可否','期限区分','前倒し候補','先行未完了数'].filter(name=>propertyValue(original[name])!==propertyValue(row.page.properties[name]));if(fields.length)formulaDiffs.push({id,fields});}
  return json({backend:env.DATA_BACKEND || 'notion',sources,pendingRoots:pending.map(r=>r.id),pendingChildren:children.map(r=>r.id),partialRelations:partial.map(r=>r.id),pendingAssets:assets.map(r=>r.id),outdatedBodies:outdated.map(r=>r.id),formulaDiffs,ready:![pending,children,partial,assets,outdated].some(a=>a.length)});
 }
 const fileMatch=path.match(/^\/api\/storage\/files\/([a-f0-9]{32})$/);
 if(fileMatch&&req.method==='GET') {
  const asset=await env.DB.prepare('SELECT * FROM entity_assets WHERE id=? AND complete=1').bind(fileMatch[1]).first();
  if(!asset)return json({error:'file not found'},404);
  let part=0;
  const stream=new ReadableStream({async pull(controller){try{const row=await env.DB.prepare('SELECT bytes FROM entity_asset_chunks WHERE id=? AND part=?').bind(fileMatch[1],part++).first();if(!row){controller.close();return;}controller.enqueue(new Uint8Array(row.bytes));}catch(e){controller.error(e);}}});
  return new Response(stream,{headers:{'Content-Type':asset.mime || 'application/octet-stream','Content-Length':String(asset.size),'Content-Disposition':"attachment; filename*=UTF-8''"+encodeURIComponent(asset.name || 'attachment'),'X-Content-Type-Options':'nosniff','Cache-Control':'private, no-store'}});
 }
 if(path==='/api/storage/status') {
  const counts=await env.DB.prepare('SELECT collection,COUNT(*) n FROM entities GROUP BY collection').all();
  const bodies=await env.DB.prepare('SELECT complete,COUNT(*) n FROM entity_bodies GROUP BY complete').all();
  const ids=url.searchParams.has('manifest')?(await env.DB.prepare('SELECT id FROM entities ORDER BY id').all()).results.map(r=>r.id):undefined;
  const pending=(await env.DB.prepare('SELECT e.id FROM entities e LEFT JOIN entity_bodies b ON b.id=e.id WHERE COALESCE(b.complete,0)=0').all()).results.length;
  return json({backend:env.DATA_BACKEND || 'notion',entities:counts.results,bodies:bodies.results,pending,ids});
 }
 if(env.DATA_BACKEND==='d1') {
  // 切替後も中核6つは取り込み禁止(D1 側の更新を Notion で上書きしないため)。追加コレクションの取り込みだけ許す。
  const qc=url.searchParams.get('coll'),qid=cleanId(url.searchParams.get('id'));
  const extraOk=req.method==='POST' && (((path==='/api/storage/capture' || path==='/api/storage/capture-source') && isExtraName(qc)) || (path==='/api/storage/capture-body' && await isExtraEntity(env,qid)));
  if(!extraOk)return json({error:'Migration is disabled after D1 cutover'},409);
 }
 if(req.method!=='POST')return json({error:'POST required'},405);
 if(path==='/api/storage/init'){await initD1(env);return json({ok:true});}
 if(path==='/api/storage/complete-empty') {
  const condition=`FROM entities e JOIN docs d ON d.id=e.id WHERE d.body_status='done' AND json_extract(d.conv,'$.blocks')=0 AND d.updated=json_extract(e.payload,'$.last_edited_time')`;
  await env.DB.batch([env.DB.prepare('INSERT OR IGNORE INTO entity_bodies SELECT e.id,1 '+condition),env.DB.prepare('INSERT OR IGNORE INTO entity_body_versions SELECT e.id,d.updated '+condition)]);
  return json({ids:(await env.DB.prepare('SELECT e.id '+condition).all()).results.map(r=>r.id)});
 }
 const coll=url.searchParams.get('coll'),extraDs=url.searchParams.get('ds'),id=cleanId(url.searchParams.get('id')),ds=collectionVars[coll]?env[collectionVars[coll]]:(isExtraName(coll)&&/^[a-f0-9-]{32,36}$/i.test(extraDs || '')?cleanId(extraDs):undefined);
 if(path==='/api/storage/capture') {
  if(!ds)return json({error:'Invalid collection'},400);  if(!collectionVars[coll]){const known=await collectionOfSource(env,ds);if(known&&known!==coll)return json({error:'Source already registered as '+known},409);}
  if(!url.searchParams.get('cursor')) {
   const definition=await nget(env,ctx,'/data_sources/'+ds);
   await env.DB.prepare('INSERT OR REPLACE INTO entity_schemas VALUES(?,?,?)').bind(cleanId(ds),coll,JSON.stringify(definition)).run();
  }
  const data=await nget(env,ctx,'/data_sources/'+ds+'/query',{method:'POST',body:JSON.stringify({page_size:25,...(url.searchParams.get('cursor')?{start_cursor:url.searchParams.get('cursor')}:{})})});
  const ids=data.results.map(p=>cleanId(p.id));
  const old=ids.length?new Map((await env.DB.prepare('SELECT id,ds,collection,payload FROM entities WHERE id IN ('+ids.map(()=>'?').join(',')+')').bind(...ids).all()).results.map(r=>[r.id,r])):new Map();
  for(const page of data.results || []) {await completeRelations(env,ctx,page);await storePage(env,page,coll,ds,old.get(cleanId(page.id)));}
  return json({n:data.results.length,next:data.has_more?data.next_cursor:null});
 }
 if(path==='/api/storage/capture-page') {
  const page=await completeRelations(env,ctx,await nget(env,ctx,'/pages/'+id));
  const source=page.parent?.data_source_id || '',existing=await env.DB.prepare('SELECT collection FROM entities WHERE id=?').bind(id).first(),collection=(await collectionOfSource(env,source)) || existing?.collection || 'pages';
  await storePage(env,page,collection,source);
  if(id===cleanId(env.PRESENCE_PAGE_ID))await env.DB.prepare("INSERT OR REPLACE INTO storage_control VALUES('presence_page_id',?)").bind(id).run();
  return json({id:page.id});
 }
 if(path==='/api/storage/capture-database') {
  const database=await nget(env,ctx,'/databases/'+id);
  await env.DB.prepare('INSERT OR REPLACE INTO entity_databases VALUES(?,?)').bind(id,JSON.stringify(database)).run();
  return json({sources:(database.data_sources || []).map(s=>s.id)});
 }
 if(path==='/api/storage/capture-source') {
  const source=url.searchParams.get('ds');
  if(!/^[a-f0-9-]{32,36}$/i.test(source || ''))return json({error:'Invalid source'},400);
  const wanted=url.searchParams.get('coll'),known=await collectionOfSource(env,source);if(wanted&&!isExtraName(wanted)&&wanted!==known)return json({error:'Invalid collection name'},400);if(wanted&&known&&wanted!==known)return json({error:'Source already registered as '+known},409);const collection=known||(wanted&&isExtraName(wanted)?wanted:'nested');
  if(!url.searchParams.get('cursor')){const definition=await nget(env,ctx,'/data_sources/'+source);await env.DB.prepare('INSERT OR REPLACE INTO entity_schemas VALUES(?,?,?)').bind(cleanId(source),collection,JSON.stringify(definition)).run();}
  const data=await nget(env,ctx,'/data_sources/'+source+'/query',{method:'POST',body:JSON.stringify({page_size:25,...(url.searchParams.get('cursor')?{start_cursor:url.searchParams.get('cursor')}:{})})});
  for(const page of data.results || []){await completeRelations(env,ctx,page);await storePage(env,page,collection,source);}
  return json({ids:data.results.map(p=>p.id),next:data.has_more?data.next_cursor:null});
 }
 if(path==='/api/storage/capture-asset') {
  const row=await env.DB.prepare('SELECT payload FROM entity_children WHERE id=? LIMIT 1').bind(id).first();
  if(!row)return json({error:'Unknown block'},404);
  let block=JSON.parse(row.payload);
  if(block[block.type]?.file) {block=await nget(env,ctx,'/blocks/'+id);await env.DB.prepare('UPDATE entity_children SET payload=? WHERE id=?').bind(JSON.stringify(block),id).run();}
  const value=block[block.type],source=value?.file?.url || value?.external?.url;
  const allowed=u=>u.protocol==='https:'&&['amazonaws.com','notion.so','notion-static.com','notionusercontent.com'].some(h=>u.hostname===h||u.hostname.endsWith('.'+h));
  let target=new URL(source);
  if(!allowed(target))return json({error:'External attachment needs separate review'},409);
  // Workers reject redirect:'error'. Follow at most 3 redirects by hand and keep every hop on the allowed hosts (2026-10-18).
  let response;
  for(let hop=0;;hop++){
   response=await fetch(target,{redirect:'manual'});
   if(response.status<300||response.status>=400)break;
   const next=response.headers.get('location');
   if(!next||hop>=3)throw new Error('Attachment redirect not followed: '+response.status);
   target=new URL(next,target);
   if(!allowed(target))return json({error:'Attachment redirected to an unreviewed host'},409);
  }
  if(!response.ok)throw new Error('Attachment download failed: '+response.status);
  const reader=response.body.getReader();let size=0,part=0;
  await env.DB.batch([env.DB.prepare('INSERT OR REPLACE INTO entity_assets VALUES(?,?,?,?,0)').bind(id,response.headers.get('content-type'),0,value.name || block.type),env.DB.prepare('DELETE FROM entity_asset_chunks WHERE id=?').bind(id)]);
  while(true){const {value:chunk,done}=await reader.read();if(done)break;size+=chunk.byteLength;if(size>32*1024*1024){await reader.cancel();throw new Error('Attachment exceeds 32 MiB');}for(let offset=0;offset<chunk.byteLength;offset+=128*1024){const bytes=chunk.slice(offset,offset+128*1024);await env.DB.prepare('INSERT INTO entity_asset_chunks VALUES(?,?,?)').bind(id,part++,bytes.buffer).run();}}
  await env.DB.prepare('UPDATE entity_assets SET complete=1,size=? WHERE id=?').bind(size,id).run();
  return json({id,size,parts:part});
 }
 if(path==='/api/storage/capture-body') {
  if(!/^[a-f0-9]{32}$/.test(id))return json({error:'Invalid id'},400);
  const cursor=url.searchParams.get('cursor');
  if(!cursor) {
   const row=await env.DB.prepare('SELECT e.payload,d.updated,d.conv,d.body_status FROM entities e LEFT JOIN docs d ON d.id=e.id WHERE e.id=?').bind(id).first();
   if(row&&row.body_status==='done'&&JSON.parse(row.conv || '{}').blocks===0&&row.updated===JSON.parse(row.payload).last_edited_time) {
    await env.DB.batch([env.DB.prepare('INSERT OR REPLACE INTO entity_bodies VALUES(?,1)').bind(id),env.DB.prepare('INSERT OR REPLACE INTO entity_body_versions VALUES(?,?)').bind(id,row.updated)]);
    return json({n:0,next:null,children:[],pages:[],assets:[],databases:[],emptyVerified:true});
   }
  }
  if(!cursor){const e=await env.DB.prepare('SELECT payload FROM entities WHERE id=?').bind(id).first();await env.DB.batch([env.DB.prepare('DELETE FROM entity_children WHERE parent_id=?').bind(id),env.DB.prepare('INSERT OR REPLACE INTO entity_bodies VALUES(?,0)').bind(id),env.DB.prepare('INSERT OR REPLACE INTO entity_body_versions VALUES(?,?)').bind(id,e?JSON.parse(e.payload).last_edited_time:null)]);}
  const prior=await env.DB.prepare('SELECT COUNT(*) n FROM entity_children WHERE parent_id=?').bind(id).first();
  const data=await nget(env,ctx,`/blocks/${id}/children?page_size=100${cursor?'&start_cursor='+encodeURIComponent(cursor):''}`);
  const stmts=(data.results || []).map((b,i)=>env.DB.prepare('INSERT OR REPLACE INTO entity_children VALUES(?,?,?,?)').bind(id,cleanId(b.id),prior.n+i,JSON.stringify(b)));
  if(!data.has_more)stmts.push(env.DB.prepare('UPDATE entity_bodies SET complete=1 WHERE id=?').bind(id));
  for(let i=0;i<stmts.length;i+=50)await env.DB.batch(stmts.slice(i,i+50));
  return json({n:data.results.length,next:data.has_more?data.next_cursor:null,children:data.results.filter(b=>b.has_children&&!['child_page','child_database'].includes(b.type)).map(b=>b.id),pages:data.results.filter(b=>b.type==='child_page').map(b=>b.id),assets:data.results.filter(b=>['pdf','file','image','audio','video'].includes(b.type)).map(b=>b.id),databases:data.results.filter(b=>b.type==='child_database').map(b=>b.id)});
 }
 return json({error:'not found'},404);
}
