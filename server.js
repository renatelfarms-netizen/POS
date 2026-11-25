'use strict';
// Multi-shop web server: many shops, each with its own link (site/<shop-link>), data, staff,
// logins and backups. Free to use. Tessa POS, built from the Renatel Shop app.
// - /                 the platform page: sign up a new shop, find your shop
// - /admin            platform admin (you): every shop, pause / open, notes
// - /<link>           a shop's app; its API is /<link>/api/...
// No dependencies. Secrets come from environment variables:
//   SUPABASE_URL, SUPABASE_KEY, SUPABASE_BACKUP_TOKEN   the database (multi-shop functions, see schema.sql).
//                    SUPABASE_KEY is the project's SECRET (service_role) key: the functions refuse the public key.
//   PLATFORM_ADMIN_PASSWORD                             password for /admin
//   PLATFORM_NAME (default Tessa POS), PLATFORM_HOST (optional)
//   BACKUP_DIR (optional) hosting copies, one folder per shop
const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');
// Which shop the current request (or backup job) is for. Every database call carries it.
const ctx = new AsyncLocalStorage();
const T = () => ctx.getStore() || {};
const SID = () => (T().shop || {}).id || '-';
const PLATFORM = process.env.PLATFORM_NAME || 'Tessa POS';
const SITE = process.env.PLATFORM_HOST || 'tessapos.shop';

const PAGE = path.join(__dirname, 'index.html'), LANDING = path.join(__dirname, 'landing.html'), ADMIN = path.join(__dirname, 'admin.html'), LOGIN = path.join(__dirname, 'login.html'), HELP = path.join(__dirname, 'help.html'), REGISTER = path.join(__dirname, 'register.html'), CSS = path.join(__dirname, 'site.css');
const PORT = process.env.PORT || 3000;
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(os.homedir(), 'shop-backups');
const MAX_BODY = 25 * 1024 * 1024;

const HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Strict-Transport-Security': 'max-age=31536000',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()'
};

let cache = null;
function page() {
  if (!cache) cache = fs.readFileSync(PAGE);
  return cache;
}

function send(res, code, obj) {
  res.writeHead(code, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, HEADERS));
  res.end(JSON.stringify(obj));
}

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

// ---- backup code check, with a limit on wrong tries ----
const fails = new Map(); // ip -> {n, until}
function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
}
function codeOK(req) {
  const want = process.env.BACKUP_CODE;
  if (!want) return 'off';
  const ip = clientIp(req), f = fails.get(ip);
  if (f && f.until > Date.now()) return 'wait';
  const got = String(req.headers['x-backup-code'] || '').trim().toUpperCase();
  const ok = crypto.timingSafeEqual(Buffer.from(sha(got)), Buffer.from(sha(want.trim().toUpperCase())));
  if (ok) { fails.delete(ip); return 'ok'; }
  const n = (f ? f.n : 0) + 1;
  fails.set(ip, { n, until: n >= 8 ? Date.now() + 15 * 60000 : 0 });
  return 'bad';
}
setInterval(() => { const t = Date.now(); for (const [k, v] of fails) if (v.until && v.until < t) fails.delete(k); }, 600000).unref();

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const parts = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('too big'), { code: 413 })); req.destroy(); return; }
      parts.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
    req.on('error', reject);
  });
}

const cleanDev = (s) => String(s || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);

function counts(d) {
  const n = (a) => (Array.isArray(a) ? a.length : 0);
  let products = n(d.products), sales = n(d.sales), customers = n(d.customers);
  if (d.__BR && typeof d.__BR === 'object') {
    for (const [k, b] of Object.entries(d.__BR)) {
      if (k !== d.__curB && b && typeof b === 'object') { products += n(b.products); sales += n(b.sales); customers += n(b.customers); }
    }
  }
  return { products, sales, customers, staff: n(d.staff), expenses: n(d.expenses) };
}

// ---- copies on the hosting ----
// One gzip file per backup, plus index.json with the list. Kept outside the website folder.
const bdir = () => path.join(BACKUP_DIR, SID().replace(/[^A-Za-z0-9-]/g, ''));
async function hostIndex() {
  try { return JSON.parse(await fsp.readFile(path.join(bdir(), 'index.json'), 'utf8')); } catch (e) { return []; }
}
const hostQueues = new Map();
function hostSave(dev, name, raw, digest, cnt) {
  const q = hostQueues.get(SID()) || Promise.resolve();
  const job = q.then(() => hostSaveNow(dev, name, raw, digest, cnt));
  hostQueues.set(SID(), job.catch(() => {}));
  return job;
}
async function hostSaveNow(dev, name, raw, digest, cnt) {
  await fsp.mkdir(bdir(), { recursive: true, mode: 0o700 });
  const idx = await hostIndex();
  const lastForDev = idx.filter((x) => x.device === dev).sort((a, b) => b.at.localeCompare(a.at))[0];
  if (lastForDev && lastForDev.sha256 === digest) return { skipped: true };
  const at = new Date().toISOString();
  const file = at.replace(/[:.]/g, '-') + '__' + dev + '__' + digest.slice(0, 12) + '.json.gz';
  await fsp.writeFile(path.join(bdir(), file), zlib.gzipSync(raw), { mode: 0o600 });
  idx.push({ id: file, at, device: dev, name, sha256: digest, size: Buffer.byteLength(raw), counts: cnt });
  // keep everything from the last 2 days, then the newest of each day for 90 days (per device)
  const now = Date.now(), keep = [], seenDay = new Set();
  for (const x of idx.sort((a, b) => b.at.localeCompare(a.at))) {
    const age = now - Date.parse(x.at), dayKey = x.device + x.at.slice(0, 10);
    const k = age < 2 * 864e5 || (age < 90 * 864e5 && !seenDay.has(dayKey));
    seenDay.add(dayKey);
    if (k) keep.push(x); else await fsp.rm(path.join(bdir(), x.id), { force: true });
  }
  const tmp = path.join(bdir(), 'index.json.tmp');
  await fsp.writeFile(tmp, JSON.stringify(keep), { mode: 0o600 });
  await fsp.rename(tmp, path.join(bdir(), 'index.json'));
  return { saved: true, id: file };
}
async function hostGet(id) {
  if (!/^[A-Za-z0-9_-]+\.json\.gz$/.test(id)) return null;
  const idx = await hostIndex();
  if (!idx.some((x) => x.id === id)) return null;
  return zlib.gunzipSync(await fsp.readFile(path.join(bdir(), id))).toString('utf8');
}

// ---- copies in Supabase (through locked-down database functions) ----
const sbOn = () => !!(process.env.SUPABASE_URL && process.env.SUPABASE_KEY && process.env.SUPABASE_BACKUP_TOKEN);
// Per-shop database functions (schema.sql). Called inside a shop, the shop id is added automatically.
const MT = { shop_db_pull: 'mt_db_pull', shop_db_get: 'mt_db_get', shop_db_put: 'mt_db_put', shop_db_del: 'mt_db_del', shop_ids: 'mt_ids', site_backup_save: 'mt_backup_save', site_backup_list: 'mt_backup_list', site_backup_get: 'mt_backup_get',
  shop_photo_put: 'mt_photo_put', shop_photo_get: 'mt_photo_get', web_acct_get: 'mt_acct_get', web_acct_put: 'mt_acct_put', web_acct_list: 'mt_acct_list',
  site_secret_get: 'mt_ssecret_get', site_secret_set: 'mt_ssecret_set', otp_set: 'mt_otp_set', otp_get: 'mt_otp_get', otp_mark: 'mt_otp_mark',
  web_order_claim: 'mt_order_claim', web_stock_take: 'mt_stock_take', job_once: 'mt_job_once' };
async function sbCall(fn, args, bodyRaw) {
  if (MT[fn]) {
    if (!T().shop) throw new Error('No shop for ' + fn);
    fn = MT[fn];
    if (bodyRaw) bodyRaw = '{"p_shop":' + JSON.stringify(T().shop.id) + ',' + bodyRaw.slice(1);
    else args = Object.assign({ p_shop: T().shop.id }, args);
  }
  const url = process.env.SUPABASE_URL.replace(/\/+$/, '') + '/rest/v1/rpc/' + fn;
  const body = bodyRaw || JSON.stringify(Object.assign({ p_token: process.env.SUPABASE_BACKUP_TOKEN }, args));
  const r = await fetch(url, {
    method: 'POST',
    headers: { apikey: process.env.SUPABASE_KEY, Authorization: 'Bearer ' + process.env.SUPABASE_KEY, 'Content-Type': 'application/json' },
    body,
    signal: AbortSignal.timeout(60000)
  });
  const text = await r.text();
  if (!r.ok) throw new Error('Supabase ' + r.status + ': ' + text.slice(0, 200));
  return text ? JSON.parse(text) : null;
}
function sbSave(dev, name, raw, digest, cnt) {
  // The shop data goes into the request as-is, so it is not parsed and encoded twice.
  const head = JSON.stringify({
    p_token: process.env.SUPABASE_BACKUP_TOKEN, p_device: dev, p_name: name, p_sha: digest,
    p_size: Buffer.byteLength(raw), p_counts: cnt
  });
  return sbCall('site_backup_save', null, head.slice(0, -1) + ',"p_data":' + raw + '}');
}

// Collections the shop page stores (same list as COLS in index.html).
const DB_COLS = new Set(['shop', 'devices', 'mailed', 'students', 'att', 'marks', 'rtabs', 'kot', 'jobs', 'quotes', 'remits', 'notes', 'bshare', 'products', 'customers', 'sales', 'expenses', 'deliveries', 'pos', 'moves', 'log', 'whMoves', 'transfers', 'trReq', 'whItems', 'whPos',
  'accra_products', 'accra_customers', 'accra_sales', 'accra_expenses', 'accra_deliveries', 'accra_pos', 'accra_moves']);

// ---- online backups of the shared shop, made by the server ----
// Every SNAP_MIN minutes, if anything changed, the whole shop is saved on the hosting and in Supabase.
const SNAP_DEV = 'shop', SNAP_FORMAT = 'renatel-shop-docs-1', SNAP_MIN = 10;
// Each shop's documents are kept in memory and only the changes are downloaded (Supabase bandwidth).
// One small call (mt_revs) says which shops changed, so unchanged shops need no download at all.
// fresh = always ask Supabase for changes (restore, admin view); the background jobs may use a copy up to a minute old.
const docCache = new Map(); // shop id -> { rev, docs: Map, at }
const DOC_TTL = 6 * 3600000; // reload a shop in full every 6 hours, just in case
let revSnap = { at: 0, revs: null };
async function shopRevs() {
  if (Date.now() - revSnap.at < 60000) return revSnap.revs;
  let revs = null; try { revs = (await sbCall('mt_revs', {})) || {}; } catch (e) { console.error('shop revs', e.message); }
  revSnap = { at: Date.now(), revs }; return revs;
}
async function allDocs(fresh) {
  const id = SID(); let c = docCache.get(id);
  if (!c || Date.now() - c.at > DOC_TTL) c = { rev: 0, docs: new Map(), at: Date.now() };
  const out = () => [...c.docs.keys()].sort().reduce((o, k) => (o[k] = c.docs.get(k), o), {});
  if (!fresh && docCache.get(id) === c) { const r = await shopRevs(); if (r && +(r[id] || 0) === c.rev) return out(); }
  let since = c.rev, more = true;
  while (more) {
    const j = await sbCall('shop_db_pull', { p_since: since });
    for (const d of j.docs || []) { const k = d.c + '/' + d.id; if (d.x) c.docs.delete(k); else c.docs.set(k, d.d); }
    since = +j.rev || since; more = !!j.more;
  }
  c.rev = since; docCache.set(id, c);
  return out();
}
function docCounts(docs) {
  const n = { products: 0, customers: 0, sales: 0, expenses: 0, staff: 0 };
  for (const [k, d] of Object.entries(docs)) {
    const c = k.split('/')[0].replace(/^accra_/, '');
    if (c === 'products' || c === 'customers') n[c]++;
    else if ((c === 'sales' || c === 'expenses') && d && Array.isArray(d.recs)) n[c] += d.recs.length;
  }
  n.staff = ((docs['shop/main'] || {}).staff || []).length;
  return n;
}
const snapBusy = new Map(), snapLast = new Map(); // shop id -> digest of the last backup saved
function snapshot(label, force) { const k = SID(); if (!snapBusy.has(k)) snapBusy.set(k, snapshotNow(label, force).finally(() => snapBusy.delete(k))); return snapBusy.get(k); }
async function snapshotNow(label, force) {
  const docs = await allDocs(!!force);
  if (!docs['shop/main']) return { skipped: true, reason: 'empty' };
  const digest = sha(JSON.stringify(docs));
  // Nothing changed since the last backup this server made: nothing to upload.
  if (!force && snapLast.get(SID()) === digest) return { skipped: true, same: true };
  const raw = JSON.stringify({ format: SNAP_FORMAT, at: new Date().toISOString(), docs }), cnt = docCounts(docs);
  const out = {};
  // The same backup is never saved twice in a row (hostSave and site_backup_save skip an unchanged copy).
  try { out.hosting = await hostSave(SNAP_DEV, label, raw, digest, cnt); } catch (e) { console.error('hosting backup', e.message); out.hosting = { error: 'Could not save on the hosting.' }; }
  try { out.supabase = await sbSave(SNAP_DEV, label, raw, digest, cnt); } catch (e) { console.error('supabase backup', e.message); out.supabase = { error: 'Could not save in Supabase.' }; }
  if (force && out.hosting.skipped && out.supabase.skipped) out.same = true;
  if (!out.hosting.error && !out.supabase.error) snapLast.set(SID(), digest);
  return out;
}
async function restoreDocs(docs, by) {
  const cur = await allDocs(true); let n = 0;
  docs = Object.assign({}, docs);
  // Everyone is signed out so no device keeps working on the old data.
  const main = JSON.parse(JSON.stringify(docs['shop/main']));
  main.set = Object.assign({}, main.set, { sessEpoch: Date.now() }); docs['shop/main'] = main;
  // The activity trail is never rolled back: it keeps every entry, including what happened after the backup.
  for (const [k, d] of Object.entries(docs)) {
    if (k.startsWith('log/') || JSON.stringify(cur[k]) === JSON.stringify(d)) continue;
    const i = k.indexOf('/'); await sbCall('shop_db_put', { p_col: k.slice(0, i), p_id: k.slice(i + 1), p_data: d }); n++;
  }
  for (const k of Object.keys(cur)) if (!(k in docs) && !k.startsWith('log/')) { const i = k.indexOf('/'); await sbCall('shop_db_del', { p_col: k.slice(0, i), p_id: k.slice(i + 1) }); n++; }
  scClear();
  console.log('restore: ' + n + ' documents changed by ' + by);
  return n;
}
// Automatic backups: every open shop, one after another.
async function backupAll() {
  let shops = []; try { shops = (await sbCall('mt_shop_list', {})) || []; } catch (e) { return console.error('auto backup list', e.message); }
  for (const sh of shops) if (sh.status !== 'suspended') await ctx.run({ shop: sh }, () => snapshot('Automatic')).catch((e) => console.error('auto backup ' + sh.slug, e.message));
}
if (sbOn()) {
  setTimeout(backupAll, 60000).unref();
  setInterval(backupAll, SNAP_MIN * 60000).unref();
}

// ---- activity trail entries written by the server (logins, resets, backups) ----
// They go into the shop's own 'log' collection, so they show in Staff → Activity trail with everything else.
let logQueue = Promise.resolve();
function serverLog(a, d, who) {
  if (!sbOn()) return;
  const day = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Accra' });
  const rec = { ts: Date.now(), sid: who && who.id != null ? who.id : null, who: (who && who.name) || '—', a, d: String(d || '').slice(0, 300) };
  logQueue = logQueue.then(async () => {
    for (let n = 0; n < 20; n++) {
      const id = day + '_server' + process.pid + '_' + n, cur = await sbCall('shop_db_get', { p_col: 'log', p_id: id }); // one document per process
      const recs = (cur && Array.isArray(cur.recs)) ? cur.recs : [];
      if (recs.length >= 300) continue;
      recs.push(Object.assign({ _c: id }, rec));
      await sbCall('shop_db_put', { p_col: 'log', p_id: id, p_data: { recs } });
      return;
    }
  }).catch((e) => console.error('activity log', e.message));
}

// ---- staff login: name + password are checked here against the shared shop's staff list ----
// A correct login returns a signed session token; devices use it for /api/db and backups.
const SESSION_DAYS = 1; // a login lasts one day (or until the browser tab is closed)
const secret = () => sha('mt-session:' + (process.env.SUPABASE_BACKUP_TOKEN || ''));
const b64u = (s) => Buffer.from(s).toString('base64url');
const sign = (body) => crypto.createHmac('sha256', secret()).update(body).digest('base64url');
function makeToken(sid, dev) {
  const body = b64u(JSON.stringify({ sid, dev, shop: SID(), iat: Date.now(), exp: Date.now() + SESSION_DAYS * 864e5 }));
  return body + '.' + sign(body);
}
function readToken(t) {
  const [body, mac] = String(t || '').split('.');
  if (!body || !mac) return null;
  const want = sign(body);
  if (mac.length !== want.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(want))) return null;
  try { const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); return p.exp > Date.now() && p.shop === SID() ? p : null; } catch (e) { return null; }
}
// Staff password hashes (pin) must never reach a browser. Strip them from the shop doc before it is
// sent to a device; the page works from `hasPw` instead, and the server keeps the real hash.
function stripShopDoc(d) {
  if (!d || typeof d !== 'object') return d;
  curFix(d);
  const c = JSON.parse(JSON.stringify(d));
  if (Array.isArray(c.staff)) for (const st of c.staff) if (st && typeof st === 'object' && 'pin' in st) { st.hasPw = !!st.pin; delete st.pin; }
  return c;
}
// Role enforcement for the shop document (staff list + settings). Only an owner may change staff roles,
// permissions, other people's passwords, unlock accounts, add/remove staff, or change the settings below.
// Anyone else's save is rebuilt from the stored copy, keeping only the changes their role allows.
const OWNER_SET = ['rc', 'sessEpoch', 'strongPw', 'valOwner', 'idleMin', 'maxDisc', 'tax', 'methods', 'branches', 'brNames', 'cur', 'reqBuyer', 'smsAuto', 'name'];
const SELF_OK = ['pin', 'mustChange', 'setupDone', 'name', 'email', 'emailOK', 'phone', 'addr', 'ecn', 'ecp', 'look', 'fails', 'nextTry'];
const OTHER_OK = ['fails', 'nextTry'];
function limitShopDoc(inc, cur, me) {
  const out = Object.assign({}, inc);
  const curSet = (cur && cur.set) || {}, set = Object.assign({}, inc.set || {});
  for (const k of OWNER_SET) { if (k in curSet) set[k] = curSet[k]; else delete set[k]; }
  out.set = set;
  const incStaff = new Map((Array.isArray(inc.staff) ? inc.staff : []).filter((x) => x && typeof x === 'object').map((x) => [x.id, x]));
  out.staff = (Array.isArray(cur.staff) ? cur.staff : []).map((old) => {
    const i = incStaff.get(old.id); if (!i) return old; // no removing staff
    const m = JSON.parse(JSON.stringify(old));
    for (const k of (old.id === me.id ? SELF_OK : OTHER_OK)) if (i[k] !== undefined) m[k] = i[k];
    if (i.locked === true) m.locked = true; // wrong tries may lock an account; only an owner can unlock
    return m;
  }); // staff the caller added are dropped: only an owner adds staff
  return out;
}
// Role enforcement for day-to-day data (sales, products, customers, expenses), mirroring the app's own rules:
// delete = owner or 'del' permission; edit a sale = owner, manager or 'edit'; refund = owner or manager;
// change stock by hand = 'stock'; product details = Inventory/Purchases/Warehouse screens; lowering a customer's
// balance = Customers screen (or refund/edit/delete rights). The server keeps the stored values for anything else.
const ROLE_TABS = { owner: ['home', 'sch', 'cour', 'kds', 'sell', 'docs', 'cust', 'del', 'inv', 'po', 'wh', 'web', 'exp', 'rep', 'staff', 'set'],
  manager: ['home', 'sch', 'cour', 'kds', 'sell', 'docs', 'cust', 'del', 'inv', 'po', 'wh', 'exp', 'rep'], accountant: ['home', 'sch', 'docs', 'cust', 'po', 'exp', 'rep'],
  cashier: ['home', 'sch', 'cour', 'sell', 'docs'], warehouse: ['home', 'wh'], stock: ['home', 'inv', 'po'], delivery: ['home', 'del', 'cour'], teacher: ['home', 'sch'],
  waiter: ['home', 'sell'], kitchen: ['home', 'kds'] };
const GRANT_TABS = ['sch', 'cour', 'kds', 'sell', 'docs', 'cust', 'del', 'inv', 'po', 'wh', 'exp', 'rep'];
function powers(s) {
  const tabs = !s ? [] : Array.isArray(s.access) ? ['home', ...s.access.filter((t) => GRANT_TABS.includes(t))] : (ROLE_TABS[s.role] || ROLE_TABS.cashier);
  const t = new Set(tabs), p = (s && s.perms) || {}, mgr = !!s && s.role === 'manager';
  return { t, del: !!p.del, edit: mgr || !!p.edit, refund: mgr, stock: !!p.stock, prod: t.has('inv') || t.has('po') || t.has('wh'), web: !!(p.web && p.web.products) };
}
const DATA_COLS = { sales: 'recs', expenses: 'recs', products: 'one', customers: 'one', deliveries: 'recs', pos: 'recs', transfers: 'recs', trReq: 'recs', whPos: 'recs', whItems: 'one', remits: 'recs', students: 'one' };
// Which screens need which data. Staff only download what their screens use (the owner gets everything).
const SEE = { sales: ['sell', 'docs', 'cust', 'del', 'cour', 'rep'], customers: ['sell', 'docs', 'cust', 'del', 'cour', 'rep'], expenses: ['exp', 'rep', 'po'] };
function canSee(c, s) {
  const base = c.replace(/^accra_/, '');
  if (base === 'log') return !!s && s.role === 'manager';
  if (!SEE[base]) return true;
  const P = powers(s); return SEE[base].some((t) => P.t.has(t));
}
// Pay on delivery: delivery staff turn the 'On delivery' part of a sale into how the customer actually paid, same amount.
function codSwap(o, r) {
  const A = Array.isArray(o.pays) ? o.pays : [], B = Array.isArray(r.pays) ? r.pays : [], sum = (L) => L.reduce((t, p) => t + (+(p && p.amt) || 0), 0);
  if (!A.some((p) => p && p.m === 'On delivery') || B.some((p) => !p || p.m === 'On delivery' || p.m === 'Credit')) return false;
  const rest = B.map((p) => JSON.stringify(p)); for (const p of A.filter((p) => p.m !== 'On delivery')) { const k = rest.indexOf(JSON.stringify(p)); if (k < 0) return false; rest.splice(k, 1); }
  return rest.length <= 1 && Math.abs(sum(A) - sum(B)) < 0.01;
}
// Who may change existing records / add new ones, per collection (deletes and removals always need 'del').
const GEN = { deliveries: { chg: (P) => P.t.has('del') || P.t.has('cour') || P.edit, add: () => true },
  pos: { chg: (P) => P.prod, add: (P) => P.prod }, transfers: { chg: (P) => P.prod, add: (P) => P.prod },
  remits: { chg: (P) => P.del, add: () => true }, trReq: { chg: (P) => P.prod, add: (P) => P.prod }, whPos: { chg: (P) => P.prod, add: (P) => P.prod }, whItems: { chg: (P) => P.prod, add: (P) => P.prod } };
const SALE_LOCK = ['items', 'total', 'sub', 'disc', 'sdisc', 'pays', 'method', 'tend', 'change', 'cust', 'custName', 'by', 'byName', 'ts', 'tax', 'taxRate', 'dfee', 'due'];
const keep = (m, o, k) => { if (o && k in o) m[k] = o[k]; else delete m[k]; };
// Returns the doc to save for a non-owner, or null when the change is not allowed at all.
function limitData(base, inc, cur, P) {
  if (DATA_COLS[base] === 'recs') {
    const old = new Map(((cur && cur.recs) || []).filter((r) => r && typeof r === 'object').map((r) => [r.id, r])), seen = new Set(), out = [];
    for (const r of (Array.isArray(inc.recs) ? inc.recs : [])) {
      if (!r || typeof r !== 'object') continue;
      const o = old.get(r.id); seen.add(r.id);
      if (!o) { if (!GEN[base] || GEN[base].add(P)) out.push(r); continue; } // new records are fine
      if (GEN[base]) { out.push(GEN[base].chg(P) ? r : o); continue; }
      if (base === 'sales') {
        if (P.edit) { out.push(r); continue; }
        const m = Object.assign({}, r); for (const k of SALE_LOCK) keep(m, o, k);
        if ((P.t.has('del') || P.t.has('cour')) && codSwap(o, r)) { m.pays = r.pays; m.method = r.method; }
        if (!P.refund) { // delivery staff may only add a no-money 'Not collected' void when a delivery is cancelled
          const was = Array.isArray(o.refunds) ? o.refunds : [], ids = new Set(was.map((x) => x && x.id));
          const voids = P.t.has('del') ? (Array.isArray(r.refunds) ? r.refunds : []).filter((x) => x && !ids.has(x.id) && x.method === 'Not collected' && !+x.cash && !+x.credit) : [];
          if (was.length || voids.length) m.refunds = was.concat(voids); else delete m.refunds;
        }
        out.push(m);
      } else out.push(P.del ? r : o); // expenses: changing a recorded expense needs 'del'
    }
    if (!P.del) for (const [id, o] of old) if (!seen.has(id)) out.push(o); // records can't be removed without 'del'
    return Object.assign({}, inc, { recs: out.sort((a, b) => (a.ts || 0) - (b.ts || 0)) });
  }
  if (base === 'products') {
    if (!cur) return P.prod ? inc : null; // only stock/inventory staff add products
    let m;
    if (P.prod) m = Object.assign({}, inc);
    else { m = Object.assign({}, cur); for (const k of ['stock', 'lots', 'exp']) if (k in inc) m[k] = inc[k]; if (P.web) for (const k of ['hideOnline', 'img']) if (k in inc) m[k] = inc[k]; }
    const up = (+m.stock || 0) > (+cur.stock || 0);
    if (up && !(P.stock || P.refund || P.edit || P.del || P.prod || P.t.has('del'))) { m.stock = cur.stock; if ('lots' in cur) m.lots = cur.lots; else delete m.lots; } // stock goes up only by receiving, refunds, edits or a stock count
    return m;
  }
  if (base === 'students') { // fee payments already recorded stay as they are unless the person may delete
    if (!cur || P.del) return inc;
    const m = Object.assign({}, inc), mine = Array.isArray(inc.pays) ? inc.pays.filter((x) => x && typeof x === 'object') : [];
    const ids = new Set(mine.map((x) => x.id)), was = Array.isArray(cur.pays) ? cur.pays : [];
    const out = mine.map((x) => was.find((o) => o && o.id === x.id) || x).concat(was.filter((o) => o && !ids.has(o.id)));
    if (out.length || 'pays' in cur) m.pays = out.sort((a, b) => (a.ts || 0) - (b.ts || 0));
    return m;
  }
  if (base === 'whItems') { if (!cur) return P.prod ? inc : null; return P.prod ? inc : cur; }
  if (base === 'customers') {
    if (!cur) return inc;
    const m = Object.assign({}, inc);
    if (!(P.t.has('cust') || P.refund || P.edit || P.del) && (+inc.owed || 0) < (+cur.owed || 0) - 0.004) { m.owed = cur.owed; keep(m, cur, 'due'); } // only Customers staff can lower a balance
    return m;
  }
  return inc;
}
// History the owner relies on to spot problems: the activity trail and stock movements. Non-owners can add to it,
// and the app may trim old entries, but they can't remove or rewrite anything from the last 7 days, or the server's own entries.
const HIST_COLS = new Set(['log', 'moves', 'whMoves']), HIST_KEEP = 7 * 864e5;
const histLocked = (id, r) => /_server/.test(id) || !r || typeof r !== 'object' || !(+r.ts < Date.now() - HIST_KEEP);
function limitHist(id, inc, cur) {
  const seen = new Set(), out = [];
  for (const r of (Array.isArray(inc && inc.recs) ? inc.recs : [])) if (r && typeof r === 'object') out.push(r);
  const key = (r) => JSON.stringify(r), have = new Set(out.map(key));
  for (const o of ((cur && cur.recs) || [])) if (histLocked(id, o) && !have.has(key(o))) out.push(o);
  return Object.assign({}, inc, { recs: out.sort((a, b) => (a.ts || 0) - (b.ts || 0)) });
}
// Fields the screens treat as numbers must be numbers, and status labels plain text, whoever saves them
// (stops a device storing script in a quantity or status that another person's screen then shows).
const NUM_KEYS = new Set(['qty', 'price', 'cost', 'disc', 'sdisc', 'total', 'sub', 'tax', 'taxRate', 'dfee', 'tend', 'change', 'amt', 'cash', 'credit', 'stock', 'min', 'wh', 'owed', 'cod', 'fee', 'q', 'ts', 'sent', 'got', 'paid', 'bal', 'due_amt']);
function cleanDoc(v, depth = 0) {
  if (depth > 8 || !v || typeof v !== 'object') return v;
  if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) v[i] = cleanDoc(v[i], depth + 1); return v; }
  for (const k of Object.keys(v)) {
    const x = v[k];
    if (NUM_KEYS.has(k) && typeof x === 'string' && !/^\s*-?\d*\.?\d+\s*%?\s*$/.test(x)) v[k] = x.trim() === '' ? x : (parseFloat(x) || 0);
    else if (k === 'status' && typeof x === 'string') v[k] = x.replace(/[<>"'&`]/g, '').slice(0, 60);
    else if (x && typeof x === 'object') v[k] = cleanDoc(x, depth + 1);
  }
  return v;
}
const shopCache = new Map(); // shop id -> {at, doc}
const scClear = () => shopCache.delete(SID());
// The currency symbol is shown unescaped on many screens and pages: keep it to plain text.
const curFix = (d) => { if (d && d.set && typeof d.set === 'object' && d.set.cur != null) { const c = String(d.set.cur).replace(/[<>"'&`\\]/g, '').slice(0, 6).trim(); d.set.cur = c || 'GH₵'; } return d; };
async function shopMain(fresh) {
  const c = shopCache.get(SID());
  if (!fresh && c && c.doc && Date.now() - c.at < 15000) return c.doc;
  // 'bg' (background jobs): use the server's copy of the shop if the shop has not changed. Read only.
  if (fresh === 'bg') { const k = docCache.get(SID()); if (k) { const r = await shopRevs(); if (r && +(r[SID()] || 0) === k.rev) return curFix(k.docs.get('shop/main') || null); } }
  const doc = curFix(await sbCall('shop_db_get', { p_col: 'shop', p_id: 'main' }));
  shopCache.set(SID(), { at: Date.now(), doc });
  return doc;
}
// Same name matching and password checks as the shop page (index.html: nmz, findStaff, pwOK).
const nmz = (v) => String(v || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
// A name matches if it is the full name, the same words in any order ("Emmanuel Buckson"),
// or one word of exactly one person's name ("Emmanuel").
function findStaff(staff, v) {
  // Tessa: staff log in with their email. A name still works only for an older account that has no email yet.
  if (String(v || '').includes('@')) { const e = String(v).trim().toLowerCase(); return staff.find((x) => String(x.email || '').trim().toLowerCase() === e) || null; }
  staff = staff.filter((x) => !String(x.email || '').includes('@'));
  const q = nmz(v); if (!q) return null;
  const words = (n) => nmz(n).split(' ').sort().join(' ');
  let L = staff.filter((x) => nmz(x.name) === q);
  if (!L.length) L = staff.filter((x) => words(x.name) === q.split(' ').sort().join(' '));
  if (!L.length && !q.includes(' ')) L = staff.filter((x) => nmz(x.name).split(' ').includes(q));
  if (!L.length) L = staff.filter((x) => nmz(x.name).replace(/ /g, '') === q.replace(/ /g, '') || nmz(x.name).split(' ').reverse().join('') === q.replace(/ /g, ''));
  return L.length === 1 ? L[0] : null;
}
const eq = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
function pwOK(p, stored) {
  stored = String(stored || ''); if (!stored) return Promise.resolve(false);
  if (stored.startsWith('p2$')) {
    const salt = stored.split('$')[1];
    return new Promise((ok) => crypto.pbkdf2(String(p), salt, 150000, 32, 'sha256', (e, k) => ok(!e && eq('p2$' + salt + '$' + k.toString('hex'), stored))));
  }
  return Promise.resolve(eq(sha('renatel:' + p), stored));
}
const loginFails = new Map(); // ip and name -> {n, until}
const hourHits = new Map();
function hourly(key, max, win = 3600e3) { const h = hourHits.get(key) || { n: 0, at: Date.now() }; if (Date.now() - h.at > win) { h.n = 0; h.at = Date.now(); } h.n++; hourHits.set(key, h); return h.n <= max; }
setInterval(() => { const t = Date.now(); for (const [k, v] of hourHits) if (t - v.at > 864e5) hourHits.delete(k); }, 3600e3).unref();
function tooMany(key) { const f = loginFails.get(key); return f && f.until > Date.now() ? Math.ceil((f.until - Date.now()) / 60000) : 0; }
function failed(key, max) { const f = loginFails.get(key) || { n: 0, until: 0 }; f.n++; if (f.n >= max) { f.until = Date.now() + 15 * 60000; f.n = 0; } loginFails.set(key, f); }
setInterval(() => { const t = Date.now(); for (const [k, v] of loginFails) if (v.until && v.until < t) loginFails.delete(k); }, 600000).unref();

// Is the shop open? Paused shops can't log in. Their data is kept.
const fdate = (t) => new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
// Tessa POS is free to use: a shop is either open, or paused by the platform admin.
function planState(sh) { return sh.status === 'suspended' ? 'suspended' : 'active'; }
function shopClosed() {
  const sh = T().shop; if (!sh) return [404, 'Shop not found.'];
  if (planState(sh) === 'suspended') return [403, 'This shop has been paused. Contact ' + PLATFORM + ' to open it again. All your data is kept safe.'];
  return null;
}
async function login(req, res) {
  if (!sbOn()) return send(res, 503, { error: 'The shop database is not set up on the server yet.' });
  { const c = shopClosed(); if (c) return send(res, c[0], { error: c[1], closed: true }); }
  const ip = 'ip:' + clientIp(req);
  let msg; try { msg = JSON.parse(await readBody(req)); } catch (e) { return send(res, 400, { error: 'Not valid data.' }); }
  const name = String(msg && msg.name || '').slice(0, 80), pw = String(msg && msg.password || '').slice(0, 200);
  if (!name || !pw) return send(res, 400, { error: 'Type your email and password.' });
  const nk = SID() + ':name:' + nmz(name);
  const wait = tooMany(ip) || tooMany(nk);
  if (wait) return send(res, 429, { error: 'Too many wrong tries. Wait ' + wait + ' minute' + (wait > 1 ? 's' : '') + ', then try again.' });
  let shop; try { shop = await shopMain(true); } catch (e) { console.error('login', e.message); return send(res, 502, { error: 'Could not reach the shop database. Try again in a moment.' }); }
  if (!shop) return send(res, 404, { error: 'The shop has not been set up yet.', setup: true });
  const s = findStaff(shop.staff || [], name);
  if (!s || !(await pwOK(pw, s.pin))) {
    console.log('login failed: ' + (s ? 'wrong password for ' + s.name : 'no staff member called "' + nmz(name) + '"'));
    serverLog('Failed login', s ? 'wrong password · on ' + SITE : 'name not recognised: “' + name.slice(0, 40) + '” · on ' + SITE, s);
    failed(ip, 20); failed(nk, 6); return send(res, 401, { error: 'That email and password don’t match. Check the email and try again.' }); }
  if (s.locked) { serverLog('Failed login', 'account is locked · on ' + SITE, s); return send(res, 423, { error: s.name + '’s account is locked after too many wrong tries. Ask the owner or a manager to unlock it.' }); }
  loginFails.delete(nk);
  console.log('login ok: ' + s.name);
  const dev = cleanDev(msg.dev);
  return send(res, 200, { ok: true, token: makeToken(s.id, dev), sid: s.id, name: s.name, exp: Date.now() + SESSION_DAYS * 864e5 });
}
const rcNorm = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const pwRule = (p, set) => (set && set.strongPw === false) ? (p.length < 4 ? 'Use at least 4 characters.' : '') : (p.length < 6 || !/[A-Za-z]/.test(p) || !/\d/.test(p) ? 'Use at least 6 characters with both letters and numbers, e.g. kofi2024.' : '');
const mkHash = (p) => new Promise((ok, no) => { const salt = crypto.randomBytes(16).toString('hex'); crypto.pbkdf2(String(p), salt, 150000, 32, 'sha256', (e, k) => e ? no(e) : ok('p2$' + salt + '$' + k.toString('hex'))); });
async function resetPw(req, res) {
  if (!sbOn()) return send(res, 503, { error: 'The shop database is not set up on the server yet.' });
  const ip = 'rc:' + clientIp(req), sk = 'rcs:' + SID(), wait = tooMany(ip) || tooMany(sk); // per shop too: the IP header can be faked
  if (wait) return send(res, 429, { error: 'Too many wrong codes. Wait ' + wait + ' minutes, then try again.' });
  let msg; try { msg = JSON.parse(await readBody(req)); } catch (e) { return send(res, 400, { error: 'Not valid data.' }); }
  const name = String(msg.name || '').slice(0, 80), code = rcNorm(msg.code), pw = String(msg.password || '').slice(0, 200);
  let shop; try { shop = await shopMain(true); } catch (e) { return send(res, 502, { error: 'Could not reach the shop database. Try again in a moment.' }); }
  if (!shop) return send(res, 404, { error: 'The shop has not been set up yet.' });
  const s = findStaff(shop.staff || [], name);
  if (!s) return send(res, 400, { error: 'No staff member with that name. Type the name exactly as the owner added it.' });
  if (!shop.set || !shop.set.rc) return send(res, 400, { error: 'This shop has no recovery code yet. Ask the owner.' });
  if (!code || !(await pwOK('rc:' + code, shop.set.rc))) { console.log('reset failed: wrong recovery code for ' + s.name); serverLog('Failed recovery code', 'on ' + SITE, s); failed(ip, 5); failed(sk, 10); return send(res, 401, { error: 'That recovery code is not right.' }); }
  const rule = pwRule(pw, shop.set); if (rule) return send(res, 400, { error: rule });
  await setPin(shop, s.id, pw);
  console.log('password reset with the recovery code: ' + s.name); serverLog('Password reset', 'with the shop recovery code · on ' + SITE, s);
  return send(res, 200, { ok: true, token: makeToken(s.id, cleanDev(msg.dev)), sid: s.id, name: s.name, exp: Date.now() + SESSION_DAYS * 864e5 });
}
// ---- email from the platform mailbox (sent with each shop's own name) through the Hostinger Mail API ----
// The API key and mailbox id are kept privately in Supabase (site_secrets), read with the server token.
let mailCache = { at: 0, cfg: null };
async function mailCfg() {
  if (mailCache.cfg && Date.now() - mailCache.at < 300000) return mailCache.cfg;
  const get = (n) => sbCall('mt_secret_get', { p_name: n });
  const [token, box, from] = await Promise.all([get('mail_api_token'), get('mail_mailbox_id'), get('mail_from')]);
  mailCache = { at: Date.now(), cfg: token && box ? { token, box, from: from || '' } : null };
  return mailCache.cfg;
}
const emailOK = (e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(e || ''));
const maskEmail = (e) => { const [u, d] = String(e).split('@'); return (u || '').slice(0, 2) + '•••@' + (d || ''); };
async function sendEmail({ to, subject, text, html, attachments }) {
  const cfg = await mailCfg();
  if (!cfg) throw new Error('The shop email is not set up.');
  let shopName = PLATFORM; try { const sh = await shopMain(false); if (sh && sh.set && sh.set.name) shopName = sh.set.name; } catch (e) {}
  const body = { to, subject: String(subject || '').slice(0, 200), displayName: shopName };
  if (text) body.text = text; if (html) body.html = html;
  if (attachments && attachments.length) body.attachments = attachments.map((a) => ({ filename: String(a.filename || 'file').slice(0, 120), content: a.content, contentType: a.contentType || a.mimeType || 'application/octet-stream' }));
  const r = await fetch((process.env.MAIL_API_BASE || 'https://api.mail.hostinger.com') + '/api/v1/mailboxes/' + encodeURIComponent(cfg.box) + '/send', {
    method: 'POST', headers: { Authorization: 'Bearer ' + cfg.token, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(60000)
  });
  const t = await r.text();
  if (!r.ok) { console.error('mail send ' + r.status + ': ' + t.slice(0, 300)); throw new Error('The email could not be sent (' + r.status + ').'); }
  console.log('email sent: "' + body.subject + '" to ' + to.map(maskEmail).join(', '));
  return true;
}
const mailCount = new Map(); // staff id -> {n, since}
function mailAllowed(key) { const m = mailCount.get(key) || { n: 0, since: Date.now() }; if (Date.now() - m.since > 3600e3) { m.n = 0; m.since = Date.now(); } m.n++; mailCount.set(key, m); return m.n <= 40; }
async function setPin(shop, sid, pw) {
  const main = JSON.parse(JSON.stringify(shop)), t = main.staff.find((x) => x.id === sid);
  t.pin = await mkHash(pw); t.fails = 0; t.nextTry = 0; t.locked = false; t.mustChange = false; delete t.rst; t.pwAt = Date.now(); delete t.pwDev;
  await sbCall('shop_db_put', { p_col: 'shop', p_id: 'main', p_data: main }); scClear();
}
// Forgot password: a 6-digit code is sent by SMS to the phone on the staff record (or by email if chosen / no SMS).
// Codes are kept as hashes in Supabase (one-time codes of this shop) so every server process can check them.
async function resetCode(req, res) {
  if (!sbOn()) return send(res, 503, { error: 'The shop database is not set up on the server yet.' });
  const ip = 'em:' + clientIp(req), wait = tooMany(ip);
  if (wait) return send(res, 429, { error: 'Too many tries. Wait ' + wait + ' minutes, then try again.' });
  let msg; try { msg = JSON.parse(await readBody(req)); } catch (e) { return send(res, 400, { error: 'Not valid data.' }); }
  let shop; try { shop = await shopMain(true); } catch (e) { return send(res, 502, { error: 'Could not reach the shop database. Try again in a moment.' }); }
  const s = shop && findStaff(shop.staff || [], String(msg.name || '').slice(0, 80));
  if (!s) { failed(ip, 10); return send(res, 400, { error: 'No staff account has that email. Use the email on your account.' }); }
  const st = store(), nm = (shop.set && shop.set.name) || PLATFORM, ph = st.normPhone(s.phone), smsOk = !!ph && await st.smsReady().catch(() => false);
  const via = msg.via === 'email' ? 'email' : msg.via === 'sms' ? 'sms' : (smsOk ? 'sms' : 'email');
  if (via === 'sms' && !smsOk) return send(res, 400, { error: ph ? 'SMS codes are not set up for this shop yet. Choose “Email me a code” or the recovery code.' : 'No phone number is saved for ' + s.name + '. Choose “Email me a code”, or ask the owner.' });
  if (via === 'email' && !emailOK(s.email)) return send(res, 400, { error: 'No email is saved for ' + s.name + '.' + (smsOk ? ' Choose “Text me a code” instead.' : ' Use the recovery code, or ask the owner or a manager.') });
  if (!hourly('rcsend:' + SID() + ':' + s.id, 6) || !hourly('rcsendd:' + SID() + ':' + s.id, 12, 864e5)) return send(res, 429, { error: 'Too many codes for ' + s.name + ' this hour. Try again later, or use the recovery code.' });
  let code; try { code = await st.otpIssue('staff:' + s.id); } catch (e) { return send(res, e.code || 502, { error: e.message }); }
  failed(ip, 10);
  try {
    if (via === 'sms') await st.sendSms(ph, st.otpSms(nm, code), { free: true }); // reset codes are never blocked by the SMS allowance
    else await sendEmail({ to: [s.email], subject: nm + ' - password reset code: ' + code,
      text: 'Hello ' + s.name + ',\n\nSomeone asked to reset your password for ' + nm + '. Your reset code is:\n\n    ' + code + '\n\nIt expires in 15 minutes. If this wasn’t you, ignore this email and tell the shop owner.\n\n-- \n' + PLATFORM });
  } catch (e) { await sbCall('otp_mark', { p_k: 'staff:' + s.id, p_try: false }).catch(() => {}); console.log('reset code ' + via + ': ' + e.message); return send(res, 502, { error: 'The code could not be sent' + (via === 'sms' ? ' by SMS' : ' by email') + '. Try again, or use the recovery code.' }); }
  const to = via === 'sms' ? ph.slice(0, 3) + '•••' + ph.slice(-3) : maskEmail(s.email);
  serverLog('Reset code ' + (via === 'sms' ? 'sent by SMS' : 'emailed'), 'to ' + to, s);
  return send(res, 200, { ok: true, via, to });
}
async function resetByEmail(req, res) {
  let msg; try { msg = JSON.parse(await readBody(req)); } catch (e) { return send(res, 400, { error: 'Not valid data.' }); }
  let shop; try { shop = await shopMain(true); } catch (e) { return send(res, 502, { error: 'Could not reach the shop database. Try again in a moment.' }); }
  const s = shop && findStaff(shop.staff || [], String(msg.name || '').slice(0, 80));
  if (!s) return send(res, 400, { error: 'That code has expired or was never sent. Send a new code.' });
  const pw = String(msg.password || '').slice(0, 200), rule = pwRule(pw, shop.set);
  if (rule) return send(res, 400, { error: rule });
  const r = await store().otpCheck('staff:' + s.id, msg.code);
  if (r === 'expired') return send(res, 400, { error: 'That code has expired or was never sent. Send a new code.' });
  if (r === 'locked') return send(res, 429, { error: 'Too many wrong codes. Send a new code.' });
  if (r !== 'ok') { serverLog('Failed reset code', r + ' tries left · on ' + SITE, s); return send(res, 401, { error: r > 0 ? 'That code is not right. ' + r + (r === 1 ? ' try' : ' tries') + ' left.' : 'That code is not right, and that was the last try. Send a new code.' }); }
  await setPin(shop, s.id, pw);
  console.log('password reset by code: ' + s.name); serverLog('Password reset', 'with a one-time code · on ' + SITE, s);
  return send(res, 200, { ok: true, token: makeToken(s.id, cleanDev(msg.dev)), sid: s.id, name: s.name, exp: Date.now() + SESSION_DAYS * 864e5 });
}
// Reset a staff member's password when another staff member (owner/manager) approves it in person.
async function resetApprove(req, res) {
  if (!sbOn()) return send(res, 503, { error: 'The shop database is not set up on the server yet.' });
  const ip = 'ap:' + clientIp(req);
  let m; try { m = JSON.parse(await readBody(req)); } catch (e) { return send(res, 400, { error: 'Not valid data.' }); }
  const ak = 'apa:' + SID() + ':' + nmz(String(m && m.approver || '').slice(0, 80)), wait = tooMany(ip) || tooMany(ak); // per approver too: the IP header can be faked
  if (wait) return send(res, 429, { error: 'Too many tries. Wait ' + wait + ' minute' + (wait > 1 ? 's' : '') + ', then try again.' });
  const pw = String(m.password || '').slice(0, 200), aPw = String(m.approverPassword || '').slice(0, 200);
  let shop; try { shop = await shopMain(true); } catch (e) { return send(res, 502, { error: 'Could not reach the shop database. Try again in a moment.' }); }
  if (!shop) return send(res, 404, { error: 'The shop has not been set up yet.' });
  const target = findStaff(shop.staff || [], String(m.name || '').slice(0, 80));
  const appr = findStaff(shop.staff || [], String(m.approver || '').slice(0, 80));
  if (!target) return send(res, 400, { error: 'No staff member with that name.' });
  if (!appr || appr.locked || !(await pwOK(aPw, appr.pin))) { failed(ip, 6); failed(ak, 6); serverLog('Failed approval', 'wrong approver password · on ' + SITE, appr || null); return send(res, 401, { error: 'That approver name and password don’t match.' }); }
  const canApprove = appr.id !== target.id && (appr.role === 'owner' || (appr.role === 'manager' && !['owner', 'manager'].includes(target.role)));
  if (!canApprove) return send(res, 403, { error: appr.name + ' can’t approve this reset.' });
  const rule = pwRule(pw, shop.set); if (rule) return send(res, 400, { error: rule });
  await setPin(shop, target.id, pw);
  serverLog('Password reset', 'approved by ' + appr.name + ' · on ' + SITE, target);
  return send(res, 200, { ok: true, name: target.name, token: makeToken(target.id, cleanDev(m.dev)), sid: target.id, exp: Date.now() + SESSION_DAYS * 864e5 });
}

// Who is calling: a logged-in staff member (session token) or a device with the shop code.
async function caller(req) {
  const h = String(req.headers.authorization || '');
  if (h.startsWith('Bearer ')) {
    const t = readToken(h.slice(7));
    if (!t || !sbOn()) return { err: [401, 'Please log in again.'] };
    { const c = shopClosed(); if (c) return { err: c }; }
    let shop; try { shop = await shopMain(false); } catch (e) { return { err: [502, 'Could not reach the shop database.'] }; }
    const s = shop && (shop.staff || []).find((x) => x.id === t.sid);
    if (!s || s.locked) return { err: [401, 'Please log in again.'] };
    if (shop.set && shop.set.sessEpoch && t.iat < shop.set.sessEpoch) return { err: [401, 'The owner signed out every device. Log in again.'] };
    if (s.pwAt && t.iat < s.pwAt && !(s.pwDev && t.dev === s.pwDev)) return { err: [401, 'Your password was changed. Log in again.'] };
    return { staff: s, dev: t.dev };
  }
  if (!req.headers['x-backup-code']) return { err: [401, 'Please log in.'] };
  const c = codeOK(req);
  if (c === 'off') return { err: [503, 'Online backup is not set up on the server yet.'] };
  if (c === 'wait') return { err: [429, 'Too many wrong codes. Try again in 15 minutes.'] };
  if (c !== 'ok') return { err: [401, 'Wrong shop code.'] };
  return { code: true };
}

// ---- API ----
async function api(req, res, url) {
  if (url.startsWith('/api/store/')) { const c = url === '/api/store/paystack' ? null : shopClosed(); if (c) return send(res, c[0], { error: c[1] }); return store().api(req, res, url); }
  // ---- product photos: the page shrinks the picture first; it is kept on the hosting (PHOTO_DIR), not in Supabase ----
  if (req.method === 'POST' && url === '/api/photo') {
    const who = await caller(req); if (who.err) return send(res, who.err[0], { error: who.err[1] });
    let msg; try { msg = JSON.parse(await readBody(req)); } catch (e) { return send(res, 400, { error: 'Not valid data.' }); }
    const m = String(msg && msg.data || '').match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
    if (!m) return send(res, 400, { error: 'That file is not a photo (use JPG, PNG or WebP).' });
    if (!hourly('photo:' + SID() + ':' + (who.staff ? who.staff.id : 'code'), 300)) return send(res, 429, { error: 'Too many photos this hour. Try again later.' });
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > 1024 * 1024) return send(res, 413, { error: 'The photo is too big. Try a smaller one.' });
    const key = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 24);
    try { await photoWrite(SID(), key, m[1], buf); } catch (e) { console.error('photo save', e.message); return send(res, 502, { error: 'Could not save the photo. Try again.' }); }
    return send(res, 200, { ok: true, key });
  }
  if (req.method === 'POST' && url === '/api/login') return login(req, res);
  if (req.method === 'POST' && url === '/api/reset') return resetPw(req, res);
  if (req.method === 'POST' && url === '/api/reset/code') return resetCode(req, res);
  if (req.method === 'POST' && url === '/api/reset/email') return resetByEmail(req, res);
  if (req.method === 'POST' && url === '/api/reset/approve') return resetApprove(req, res);
  const who = await caller(req);
  if (who.err) return send(res, who.err[0], { error: who.err[1] });
  // Confirm a staff member's password (manager approvals, change-password): the browser no longer holds hashes.
  if (req.method === 'POST' && url === '/api/verify') {
    let msg; try { msg = JSON.parse(await readBody(req)); } catch (e) { return send(res, 400, { error: 'Not valid data.' }); }
    const sid = Number(msg && msg.sid), pw = String(msg && msg.password || '').slice(0, 200);
    const vk = 'vf:' + SID() + ':' + sid, wait = tooMany(vk); // per account: the IP header can be faked
    if (wait) return send(res, 429, { error: 'Too many wrong tries. Wait ' + wait + ' minute' + (wait > 1 ? 's' : '') + ', then try again.' });
    let shop; try { shop = await shopMain(false); } catch (e) { return send(res, 502, { error: 'Could not reach the shop database.' }); }
    const s = shop && (shop.staff || []).find((x) => x.id === sid);
    if (!s || s.locked || !(await pwOK(pw, s.pin))) { failed(vk, 6); return send(res, 401, { error: 'That password is not right.' }); }
    loginFails.delete(vk); return send(res, 200, { ok: true, name: s.name });
  }
  // Restoring or listing backups: shop code, or the owner / a manager logged in.
  const canRestore = who.code || ['owner', 'manager'].includes(who.staff.role);
  if (!canRestore && req.method === 'GET' && (url === '/api/backups' || url.startsWith('/api/backup/hosting/') || url.startsWith('/api/backup/supabase/'))) {
    return send(res, 403, { error: 'Only the owner or a manager can restore backups.' });
  }

  if (req.method === 'GET' && url === '/api/backup/status') {
    return send(res, 200, { ok: true, hosting: true, supabase: sbOn(), shared: sbOn() });
  }

  if (req.method === 'POST' && url === '/api/mail/send') {
    let msg; try { msg = JSON.parse(await readBody(req)); } catch (e) { return send(res, e.code === 413 ? 413 : 400, { error: e.code === 413 ? 'The attachment is too big to email.' : 'Not valid data.' }); }
    const to = (Array.isArray(msg.to) ? msg.to : [msg.to]).map((x) => String(x || '').trim()).filter(Boolean);
    if (!to.length || to.length > 10 || !to.every(emailOK)) return send(res, 400, { error: 'Check the email address.' });
    if (!mailAllowed(SID() + ':' + (who.staff ? 's' + who.staff.id : 'code'))) return send(res, 429, { error: 'Too many emails this hour. Try again later.' });
    if (!hourly('maild:' + SID(), 150, 864e5)) return send(res, 429, { error: 'This shop has sent the most emails allowed today. Try again tomorrow.' });
    const atts = (Array.isArray(msg.attachments) ? msg.attachments : []).slice(0, 5);
    try { await sendEmail({ to, subject: msg.subject, text: String(msg.body || msg.text || '').slice(0, 50000), html: msg.html ? String(msg.html).slice(0, 500000) : undefined, attachments: atts }); return send(res, 200, { ok: true }); }
    catch (e) { return send(res, 502, { error: e.message }); }
  }
  if (req.method === 'GET' && url === '/api/mail/status') {
    try { const c = await mailCfg(); return send(res, 200, { ok: !!c, from: c ? c.from : '' }); } catch (e) { return send(res, 200, { ok: false }); }
  }
  if (req.method === 'GET' && url === '/api/ids') {
    try { return send(res, 200, { ids: await sbCall('shop_ids', { p_n: 50 }) }); }
    catch (e) { console.error('ids', e.message); return send(res, 502, { error: 'Could not reach the shop database.' }); }
  }
  // ---- shared shop database (every logged-in device sees the same data) ----
  if (url === '/api/db' || url.startsWith('/api/db/')) {
    if (!sbOn()) return send(res, 503, { error: 'The shared shop database is not set up on the server yet.' });
    try {
      if (req.method === 'GET' && url === '/api/db') {
        const since = Math.max(0, parseInt(new URL(req.url, 'http://x').searchParams.get('since') || '0', 10) || 0);
        const pulled = await sbCall('shop_db_pull', { p_since: since });
        const own = !!who.code || (who.staff && who.staff.role === 'owner');
        if (pulled && Array.isArray(pulled.docs)) {
          pulled.docs = pulled.docs.filter((doc) => doc && DB_COLS.has(String(doc.c || ''))); // server-only data (online orders, payout account, withdrawals, claims) never goes to devices
          if (!own) pulled.docs = pulled.docs.filter((doc) => doc && canSee(String(doc.c || ''), who.staff));
          for (const doc of pulled.docs) if (doc && doc.c !== 'shop' && doc.d) cleanDoc(doc.d); // numbers stay numbers on every screen
          for (const doc of pulled.docs) if (doc && doc.c === 'shop' && doc.id === 'main') { doc.d = stripShopDoc(doc.d); if (!own && doc.d && doc.d.set && doc.d.set.rc) doc.d.set.rc = 'hidden'; }
        }
        return send(res, 200, pulled);
      }
      if (req.method === 'POST' && (url === '/api/db/put' || url === '/api/db/del')) {
        let msg;
        try { msg = JSON.parse(await readBody(req)); } catch (e) { return send(res, e.code === 413 ? 413 : 400, { error: e.code === 413 ? 'That is too big to save.' : 'Not valid data.' }); }
        const col = String(msg && msg.c || ''), id = String(msg && msg.id || '');
        if (!DB_COLS.has(col) || !/^[A-Za-z0-9_.-]{1,120}$/.test(id)) return send(res, 400, { error: 'Unknown document.' });
        if (url === '/api/db/put' && (!msg.d || typeof msg.d !== 'object' || Array.isArray(msg.d))) return send(res, 400, { error: 'Not valid data.' });
        if (url === '/api/db/put' && col !== 'shop') cleanDoc(msg.d);
        if (url === '/api/db/put' && col === 'shop') curFix(msg.d);
        // The browser never receives staff password hashes, so when it saves shop/main it sends them back empty.
        // Re-attach the stored hash for each staff member the browser did not change. Fail closed: if the current
        // doc can't be read, refuse the write rather than risk blanking every password.
        const owner = !!who.code || (who.staff && who.staff.role === 'owner');
        if (url === '/api/db/del' && col === 'shop' && !owner) return send(res, 403, { error: 'Only the owner can do this.' });
        const base = col.replace(/^accra_/, '');
        if (!owner && HIST_COLS.has(base)) {
          let cur; try { cur = await sbCall('shop_db_get', { p_col: col, p_id: id }); } catch (e) { console.error('hist read', e.message); return send(res, 502, { error: 'Could not save right now. Try again in a moment.' }); }
          if (url === '/api/db/del') { if (cur && (/_server/.test(id) || ((cur.recs || []).some((r) => histLocked(id, r))))) return send(res, 200, { ok: true, kept: true }); } // quietly kept: the app only trims
          else msg.d = limitHist(id, msg.d, cur);
        }
        if (!owner && DATA_COLS[base]) {
          const P = powers(who.staff);
          if (url === '/api/db/del') { if (!P.del) return send(res, 403, { error: 'You don’t have permission to delete this.' }); }
          else {
            let cur; try { cur = await sbCall('shop_db_get', { p_col: col, p_id: id }); } catch (e) { console.error('limit read', e.message); return send(res, 502, { error: 'Could not save right now. Try again in a moment.' }); }
            const lim = limitData(base, msg.d, cur, P);
            if (!lim) return send(res, 403, { error: 'You don’t have permission to add products.' });
            msg.d = lim;
          }
        }
        if (url === '/api/db/put' && col === 'shop' && id === 'main') {
          let cur; try { cur = await sbCall('shop_db_get', { p_col: 'shop', p_id: 'main' }); } catch (e) { console.error('merge read', e.message); return send(res, 502, { error: 'Could not save right now. Try again in a moment.' }); }
          if (!owner) {
            if (!cur) return send(res, 403, { error: 'Only the owner can do this.' });
            msg.d = limitShopDoc(msg.d, cur, who.staff);
          }
          if (msg.d.set && msg.d.set.rc === 'hidden') { if (cur && cur.set && cur.set.rc) msg.d.set.rc = cur.set.rc; else delete msg.d.set.rc; }
          if (cur && Array.isArray(cur.staff)) {
            const old = new Map(cur.staff.map((x) => [x.id, x]));
            for (const st of (Array.isArray(msg.d.staff) ? msg.d.staff : [])) { const o = old.get(st.id); if (o && !st.pin && o.pin) st.pin = o.pin; if (st && typeof st === 'object') delete st.hasPw;
              if (o && st && st.pin && st.pin !== o.pin) { st.pwAt = Date.now(); st.pwDev = who.dev || null; } else if (o && st) { if (o.pwAt) st.pwAt = o.pwAt; else delete st.pwAt; if (o.pwDev) st.pwDev = o.pwDev; else delete st.pwDev; } } // a new password signs out the person's other devices
          }
        }
        const out = url === '/api/db/del' ? await sbCall('shop_db_del', { p_col: col, p_id: id }) : await sbCall('shop_db_put', { p_col: col, p_id: id, p_data: msg.d });
        if (col === 'shop') scClear(); // staff, password or sign-out changes take effect at once
        return send(res, 200, out);
      }
    } catch (e) {
      console.error('shared db', e.message);
      return send(res, 502, { error: 'Could not reach the shop database.' });
    }
    return send(res, 404, { error: 'Not found.' });
  }

  // Backups run on the server (see snapshot below). Devices no longer send their own copies.
  if (req.method === 'POST' && url === '/api/backup') {
    return send(res, 410, { error: 'Backups now run online automatically. Nothing is backed up from devices.' });
  }
  if (req.method === 'POST' && url === '/api/backup/now') {
    if (!canRestore) return send(res, 403, { error: 'Only the owner or a manager can do this.' });
    try { const out = await snapshot('Backed up by ' + (who.staff ? who.staff.name : 'shop code'), true); if (!out.same) serverLog('Online backup made', 'Back up now · hosting and Supabase', who.staff); return send(res, 200, Object.assign({ ok: true }, out)); }
    catch (e) { console.error('backup now', e.message); return send(res, 502, { error: 'Could not make the backup.' }); }
  }
  if (req.method === 'GET' && url === '/api/backups') {
    const list = [];
    for (const x of await hostIndex()) if (x.device === SNAP_DEV) list.push({ source: 'hosting', id: x.id, at: x.at, name: x.name, counts: x.counts, size: x.size, sha256: x.sha256 });
    let supabaseError = null;
    if (sbOn()) {
      try {
        for (const x of (await sbCall('site_backup_list', {})) || []) {
          if (x.device === SNAP_DEV) list.push({ source: 'supabase', id: String(x.id), at: new Date(x.created_at).toISOString(), name: x.device_name, counts: x.counts, size: x.size_bytes, sha256: x.sha256 });
        }
      } catch (e) { console.error('supabase list', e.message); supabaseError = 'Could not reach Supabase.'; }
    }
    list.sort((a, b) => b.at.localeCompare(a.at));
    return send(res, 200, { ok: true, backups: list, supabaseError, every: SNAP_MIN });
  }
  if (req.method === 'POST' && url === '/api/restore') {
    if (!(who.code || (who.staff && who.staff.role === 'owner'))) return send(res, 403, { error: 'Only the owner can restore a backup.' });
    let msg; try { msg = JSON.parse(await readBody(req)); } catch (e) { return send(res, 400, { error: 'Not valid data.' }); }
    try {
      let raw = null; const src = String(msg.source || ''), id = String(msg.id || '');
      if (src === 'hosting') raw = await hostGet(id);
      else if (src === 'supabase' && /^\d+$/.test(id)) { const v = await sbCall('site_backup_get', { p_id: +id }); raw = v ? JSON.stringify(v) : null; }
      if (!raw) return send(res, 404, { error: 'Backup not found.' });
      const snap = JSON.parse(raw);
      if (!snap || snap.format !== SNAP_FORMAT || !snap.docs || !snap.docs['shop/main']) return send(res, 400, { error: 'That backup is from an old device copy and can’t be restored here.' });
      await snapshot('Before restore', true);
      const n = await restoreDocs(snap.docs, who.staff ? who.staff.name : 'shop code');
      serverLog('Restored online backup', 'backup of ' + (snap.at || '?') + ' · ' + n + ' records changed · everyone signed out', who.staff);
      return send(res, 200, { ok: true, changed: n });
    } catch (e) { console.error('restore', e.message); return send(res, 502, { error: 'Could not restore that backup.' }); }
  }

  return send(res, 404, { error: 'Not found.' });
}


// ================= platform: sign up, find a shop, admin =================
const RESERVED = new Set(['api', 'admin', 'app', 'www', 'login', 'signup', 'sign-up', 'register', 'help', 'support', 'static', 'assets', 'icons', 'shop', 'shops', 'about', 'pricing', 'terms', 'privacy', 'contact', 'mail', 'email', 'billing', 'pay', 'account', 'dashboard', 'robots-txt', 'favicon-ico']);
const slugOK = (v) => /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/.test(v) && !v.includes('--') && !RESERVED.has(v);
const slugify = (v) => nmz(v).replace(/ /g, '-').slice(0, 40).replace(/-+$/, '');
const slugCache = new Map(); // slug -> {at, rec}
async function shopBySlug(slug) {
  const c = slugCache.get(slug);
  if (c && Date.now() - c.at < 30000) return c.rec;
  const rec = await sbCall('mt_shop_by_slug', { p_slug: slug });
  slugCache.set(slug, { at: Date.now(), rec: rec || null });
  return rec || null;
}
const pubShop = (r) => ({ id: r.id, slug: r.slug, name: r.name, owner: r.owner_name, email: r.email, phone: r.phone, status: r.status, plan: planState(r), created: r.created_at, note: r.note || '', smsPlan: +r.sms_plan || 0, smsUntil: r.sms_until || null });
const signups = new Map();
function signupAllowed(ip) { const m = signups.get(ip) || { n: 0, since: Date.now() }; if (Date.now() - m.since > 3600e3) { m.n = 0; m.since = Date.now(); } m.n++; signups.set(ip, m); return m.n <= 5; }

async function signup(req, res) {
  if (!sbOn()) return send(res, 503, { error: 'The database is not set up on the server yet.' });
  let m; try { m = JSON.parse(await readBody(req)); } catch (e) { return send(res, 400, { error: 'Not valid data.' }); }
  const t = (v, n) => String(v || '').trim().slice(0, n);
  const name = t(m.shopName, 60), slug = t(m.slug, 40).toLowerCase(), owner = t(m.ownerName, 60), email = t(m.email, 120).toLowerCase(), phone = t(m.phone, 30), pw = String(m.password || '').slice(0, 200);
  const nb = m.branches === 2 ? 2 : 1, br1 = t(m.br1, 40) || 'Main branch', br2 = t(m.br2, 40) || 'Second branch', cur = t(m.cur, 6) || 'GH₵', biz = ['pharmacy', 'school', 'restaurant', 'courier'].includes(m.biz) ? m.biz : 'retail';
  if (name.length < 2) return send(res, 400, { error: 'Type the name of your shop.', f: 'shopName' });
  if (!slugOK(slug)) return send(res, 400, { error: 'The shop link can use small letters, numbers and dashes (3 to 40), e.g. kofi-mart.', f: 'slug' });
  if (owner.length < 2) return send(res, 400, { error: 'Type your full name.', f: 'ownerName' });
  if (!emailOK(email)) return send(res, 400, { error: 'Type a valid email address. Password reset codes are sent there.', f: 'email' });
  const rule = pwRule(pw, {}); if (rule) return send(res, 400, { error: rule, f: 'password' });
  if (!signupAllowed(clientIp(req)) || !hourly('signup:all', 40)) return send(res, 429, { error: 'Too many new shops from this connection. Try again in an hour.' });
  let rec;
  try { rec = await sbCall('mt_shop_create', { p_slug: slug, p_name: name, p_owner: owner, p_email: email, p_phone: phone, p_trial_days: 365 }); }
  catch (e) { console.error('signup', e.message); return send(res, 502, { error: 'Could not create the shop. Try again in a moment.' }); }
  if (!rec || rec.error === 'taken') return send(res, 409, { error: 'That shop link is already used. Try another, e.g. ' + slug + '-' + (2 + crypto.randomInt(98)) + '.', f: 'slug' });
  slugCache.delete(slug); listCache.at = 0;
  return ctx.run({ shop: rec }, async () => {
    const ownerRec = { id: 1, name: owner, role: 'owner', branch: 'both', pin: await mkHash(pw), email, emailOK: true, phone, mustChange: false, setupDone: true };
    const main = { set: { name, phone, email, addr: '', cur, branches: nb, brNames: { kum: br1, acc: br2 }, biz, created: Date.now() }, staff: [ownerRec], suppliers: [], seq: 10 };
    try { await sbCall('shop_db_put', { p_col: 'shop', p_id: 'main', p_data: main }); }
    catch (e) { console.error('signup main', e.message); return send(res, 502, { error: 'The shop was created but could not be opened. Try logging in at /' + slug + '.' }); }
    serverLog('Shop created', name + ' · on ' + PLATFORM, ownerRec);
    console.log('new shop: ' + slug);
    sendEmail({ to: [email], subject: 'Welcome to ' + PLATFORM + ' - your shop ' + name + ' is ready',
      text: 'Hello ' + owner + ',\n\nYour shop "' + name + '" is ready.\n\nYour shop link: ' + (process.env.PLATFORM_HOST ? 'https://' + process.env.PLATFORM_HOST : '') + '/' + slug + '\nLog in with your name (' + owner + ') and the password you chose.\n\n'+PLATFORM+' is free to use.\nAdd your staff in Staff, and your products in Stock.\n\n-- \n' + PLATFORM }).catch((e) => console.error('welcome mail', e.message));
    return send(res, 200, { ok: true, slug, token: makeToken(1, cleanDev(m.dev)), sid: 1, name: owner, exp: Date.now() + SESSION_DAYS * 864e5 });
  });
}

// ---- school: behaviour report a parent opens from an SMS link ----
async function behPage(req, res, code, rec) {
  const h = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let d = null; try { d = await sbCall('shop_db_get', { p_col: 'bshare', p_id: code }); } catch (e) { console.error('beh page', e.message); }
  res.writeHead(d ? 200 : 404, Object.assign({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' }, HEADERS));
  const top = '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Behaviour report · ' + h(rec.name) + '</title><style>body{font-family:system-ui,sans-serif;background:#f6f5f1;color:#1d1d1b;margin:0;padding:16px}.c{max-width:560px;margin:0 auto;background:#fff;border-radius:16px;padding:20px;box-shadow:0 1px 3px #0001}h1{font-size:20px;margin:0}table{width:100%;border-collapse:collapse;margin-top:12px}td{padding:9px 4px;border-bottom:1px solid #eee}.s{font-weight:700;text-align:right;white-space:nowrap}.m{color:#666;font-size:14px}.b{display:inline-block;background:#e7f4ee;color:#0f6e56;border-radius:20px;padding:4px 12px;font-weight:700}.r{background:#fff7ed;border-radius:10px;padding:10px;margin-top:12px}</style></head><body><div class="c">';
  if (!d) return res.end(top + '<h1>' + h(rec.name) + '</h1><p>This report link is not valid any more. Please contact the school.</p></div></body></html>');
  const stars = (n) => '★'.repeat(n) + '☆'.repeat(5 - n), L = ['', 'Poor', 'Fair', 'Good', 'Very good', 'Excellent'];
  res.end(top + '<h1>' + h(d.school || rec.name) + '</h1><p class="m">Behaviour report · ' + h(d.term) + '</p><p style="font-size:18px;margin:14px 0 4px"><b>' + h(d.name) + '</b> · ' + h(d.cls) + '</p>' +
    (d.std ? '<p>Overall: <span class="b">' + h(d.std) + '</span> <span class="m">' + h(d.avg) + ' out of 5</span></p>' : '') +
    '<table>' + (Array.isArray(d.r) ? d.r : []).map((x) => '<tr><td>' + h(x[0]) + '</td><td class="s">' + (x[1] ? '<span style="color:#d97706">' + stars(+x[1]) + '</span> <span class="m">' + L[+x[1]] + '</span>' : '<span class="m">not rated</span>') + '</td></tr>').join('') + '</table>' +
    (d.rec ? '<div class="r"><b>Teacher’s recommendation</b><br>' + h(d.rec) + '</div>' : '') + '<p class="m" style="margin-top:14px">From ' + h(d.by || 'the class teacher') + ' · ' + h(new Date(d.ts || Date.now()).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })) + '. Please contact the school with any questions.</p></div></body></html>');
}

// ---- one login for every shop: email + password take you straight into your own shop ----
let listCache = { at: 0, L: [] };
async function allShops(fresh) {
  if (!fresh && Date.now() - listCache.at < 20000) return listCache.L;
  listCache = { at: Date.now(), L: (await sbCall('mt_shop_list', {})) || [] };
  return listCache.L;
}
const emNorm = (e) => String(e || '').trim().toLowerCase();
// Every staff record (in any shop) saved with this email.
async function byEmail(email, fresh) {
  const e = emNorm(email), out = [];
  for (const sh of await allShops(fresh)) {
    const main = await ctx.run({ shop: sh }, () => shopMain(fresh)).catch(() => null);
    for (const st of (main && main.staff) || []) if (emNorm(st.email) === e) out.push({ shop: sh, staff: st });
  }
  return out;
}
const sess = (sh, st, dev) => ctx.run({ shop: sh }, () => ({ slug: sh.slug, name: sh.name, staff: st.name, role: st.role, token: makeToken(st.id, cleanDev(dev)), sid: st.id, exp: Date.now() + SESSION_DAYS * 864e5 }));
async function emailLogin(req, res) {
  let m; try { m = JSON.parse(await readBody(req)); } catch (e) { return send(res, 400, { error: 'Not valid data.' }); }
  const email = emNorm(m.email).slice(0, 120), pw = String(m.password || '').slice(0, 200);
  if (!emailOK(email)) return send(res, 400, { error: 'Type your email address.', f: 'em' });
  if (!pw) return send(res, 400, { error: 'Type your password.', f: 'pw' });
  const ik = 'eli:' + clientIp(req), ek = 'ele:' + email, w = tooMany(ik) || tooMany(ek);
  if (w) return send(res, 429, { error: 'Too many wrong tries. Wait ' + w + ' minute' + (w > 1 ? 's' : '') + ', then try again.' });
  let M; try { M = await byEmail(email, true); } catch (e) { console.error('email login', e.message); return send(res, 502, { error: 'Could not reach the database. Try again in a moment.' }); }
  const ok = [];
  for (const x of M) if (await pwOK(pw, x.staff.pin)) ok.push(x);
  if (!ok.length) { failed(ik, 20); failed(ek, 6); return send(res, 401, { error: 'That email and password don’t match. Check them and try again.' }); }
  const open = ok.filter((x) => planState(x.shop) !== 'suspended' && !x.staff.locked);
  if (!open.length) { const x = ok[0]; return send(res, 403, { error: x.staff.locked ? 'Your account in ' + x.shop.name + ' is locked after too many wrong tries. Ask the owner or a manager to unlock it.' : x.shop.name + ' has been paused. Contact ' + PLATFORM + ' to open it again. All your data is kept safe.' }); }
  loginFails.delete(ek);
  for (const x of open) ctx.run({ shop: x.shop }, () => serverLog('Logged in with email', 'on ' + SITE + ' login page', x.staff));
  return send(res, 200, { ok: true, shops: open.map((x) => sess(x.shop, x.staff, m.dev)) });
}
// Forgot password: a 6-digit code goes to the email; the new password is set on every account with that email.
const emailCodes = new Map();
async function emailResetCode(req, res) {
  let m; try { m = JSON.parse(await readBody(req)); } catch (e) { return send(res, 400, { error: 'Not valid data.' }); }
  const email = emNorm(m.email).slice(0, 120); if (!emailOK(email)) return send(res, 400, { error: 'Type your email address.' });
  const ik = 'erc:' + clientIp(req); if (tooMany(ik)) return send(res, 429, { error: 'Too many tries. Wait a few minutes.' }); failed(ik, 10);
  if (!hourly('ercd:' + email, 10, 864e5)) return send(res, 429, { error: 'Too many codes for this email today. Try again tomorrow.' });
  const prev = emailCodes.get(email); if (prev && Date.now() - prev.sent < 60000) return send(res, 429, { error: 'A code was sent less than a minute ago. Check your email (and spam).' });
  let M; try { M = await byEmail(email, true); } catch (e) { return send(res, 502, { error: 'Could not reach the database. Try again in a moment.' }); }
  if (M.length) {
    const code = String(100000 + crypto.randomInt(900000));
    emailCodes.set(email, { h: sha('erst:' + code), exp: Date.now() + 15 * 60000, tries: 0, sent: Date.now() });
    const shops = [...new Set(M.map((x) => x.shop.name))].join(', ');
    try { await sendEmail({ to: [email], subject: PLATFORM + ' - password reset code: ' + code, text: 'Hello,\n\nSomeone asked to reset the password for ' + email + ' (' + shops + '). Your reset code is:\n\n    ' + code + '\n\nIt expires in 15 minutes. If this wasn’t you, ignore this email.\n\n-- \n' + PLATFORM }); }
    catch (e) { emailCodes.delete(email); return send(res, 502, { error: 'The code email could not be sent. Try again in a moment.' }); }
    for (const x of M) ctx.run({ shop: x.shop }, () => serverLog('Reset code emailed', 'to ' + maskEmail(email) + ' from the login page', x.staff));
  }
  // Same answer either way, so the page never tells strangers which emails have accounts.
  return send(res, 200, { ok: true, to: maskEmail(email) });
}
async function emailReset(req, res) {
  let m; try { m = JSON.parse(await readBody(req)); } catch (e) { return send(res, 400, { error: 'Not valid data.' }); }
  const email = emNorm(m.email).slice(0, 120), rc = emailCodes.get(email), pw = String(m.password || '').slice(0, 200);
  if (!rc || rc.exp < Date.now()) return send(res, 400, { error: 'That code has expired or was never sent. Send a new code.' });
  if (rc.tries >= 5) { emailCodes.delete(email); return send(res, 429, { error: 'Too many wrong codes. Send a new code.' }); }
  if (sha('erst:' + String(m.code || '').replace(/\D/g, '')) !== rc.h) { rc.tries++; return send(res, 401, { error: 'That code is not right. ' + (5 - rc.tries) + ' tries left.' }); }
  const rule = pwRule(pw, {}); if (rule) return send(res, 400, { error: rule });
  const M = await byEmail(email, true);
  for (const x of M) await ctx.run({ shop: x.shop }, async () => { const main = await shopMain(true); await setPin(main, x.staff.id, pw); serverLog('Password reset', 'with a code emailed to ' + maskEmail(email) + ' · login page', x.staff); });
  emailCodes.delete(email);
  const open = M.filter((x) => planState(x.shop) !== 'suspended');
  return send(res, 200, { ok: true, shops: open.map((x) => sess(x.shop, Object.assign({}, x.staff, { locked: false }), m.dev)) });
}

// ---- admin: read-only view of a shop ----
async function shopView(rec) {
  return ctx.run({ shop: rec }, async () => {
    const docs = await allDocs(true), main = docs['shop/main'] || {}, set = main.set || {}, two = set.branches !== 1;
    const BRN = { '': (set.brNames || {}).kum || 'Main branch', accra_: (set.brNames || {}).acc || 'Second branch' };
    const pf = two ? ['', 'accra_'] : [''];
    const list = (c) => Object.entries(docs).filter(([k]) => k.startsWith(c + '/')).map(([, d]) => d);
    const recs = (c) => list(c).flatMap((d) => (d && d.recs) || []);
    const day0 = new Date(new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Accra' }) + 'T00:00:00Z').getTime(), mon0 = new Date(new Date(day0).toISOString().slice(0, 7) + '-01T00:00:00Z').getTime();
    const sum = (a, f) => a.reduce((t, x) => t + (+f(x) || 0), 0);
    const branches = pf.map((p) => {
      const prods = list(p + 'products'), sales = recs(p + 'sales'), exps = recs(p + 'expenses');
      return { name: BRN[p], products: prods.length, units: sum(prods, (x) => x.stock), low: prods.filter((x) => x.stock <= (x.min || set.low || 0)).length, customers: list(p + 'customers').length,
        today: { n: sales.filter((x) => x.ts >= day0).length, total: sum(sales.filter((x) => x.ts >= day0), (x) => x.total) },
        month: { n: sales.filter((x) => x.ts >= mon0).length, total: sum(sales.filter((x) => x.ts >= mon0), (x) => x.total), expenses: sum(exps.filter((x) => x.ts >= mon0), (x) => x.amt) },
        all: { n: sales.length, total: sum(sales, (x) => x.total) } };
    });
    const products = pf.flatMap((p) => list(p + 'products').map((x) => ({ b: BRN[p], name: x.name, cat: x.cat || '', price: +x.price || 0, stock: +x.stock || 0 }))).sort((a, b) => a.name.localeCompare(b.name)).slice(0, 300);
    const sales = pf.flatMap((p) => recs(p + 'sales').map((x) => ({ b: BRN[p], id: x.id, ts: +x.ts || 0, total: +x.total || 0, method: x.method, by: x.byName || '', items: (Array.isArray(x.items) ? x.items : []).reduce((t, i) => t + (+(i && i.qty) || 0), 0) }))).sort((a, b) => b.ts - a.ts).slice(0, 50);
    const log = recs('log').sort((a, b) => b.ts - a.ts).slice(0, 60).map((x) => ({ ts: x.ts, who: x.who, a: x.a, d: x.d }));
    const staff = (main.staff || []).map((x) => ({ name: x.name, role: x.role, branch: x.role === 'owner' || x.branch === 'both' ? 'All branches' : BRN[x.branch === 'acc' ? 'accra_' : ''], email: x.email || '', phone: x.phone || '', locked: !!x.locked }));
    return { shop: pubShop(rec), cur: curFix({ set: { cur: set.cur || 'GH₵' } }).set.cur, details: { name: set.name, phone: set.phone || '', addr: set.addr || '', email: set.email || '', biz: set.biz || 'retail', city: set.city || '', region: set.region || '', store: !!(set.store && set.store.open) }, branches, staff, products, sales, log, warehouse: list('whItems').length };
  });
}

// Platform admin (you). The first password is PLATFORM_ADMIN_PASSWORD; after you change it on /admin,
// only a salted hash of the new one is kept in the database (mt_kv 'admin_pw').
let adminPw = { at: 0, hash: null };
async function adminHash(fresh) {
  if (!fresh && Date.now() - adminPw.at < 60000) return adminPw.hash;
  try { adminPw = { at: Date.now(), hash: (await sbCall('mt_kv_get', { p_k: 'admin_pw' })) || null }; } catch (e) { console.error('admin pw', e.message); }
  return adminPw.hash;
}
// Admin logins are signed with the current password, so changing it signs out every admin session.
const adminSign = (b) => crypto.createHmac('sha256', secret() + ':admin:' + (adminPw.hash || process.env.PLATFORM_ADMIN_PASSWORD || '')).update(b).digest('base64url');
async function adminOK(req) {
  const [b, mac] = String(req.headers.authorization || '').replace(/^Bearer /, '').split('.');
  await adminHash(false);
  if (!b || !mac || !(adminPw.hash || process.env.PLATFORM_ADMIN_PASSWORD)) return false;
  const want = adminSign(b); if (mac.length !== want.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(want))) return false;
  try { return JSON.parse(Buffer.from(b, 'base64url').toString()).exp > Date.now(); } catch (e) { return false; }
}
async function adminPwOK(p) {
  const h = await adminHash(true);
  if (h) return pwOK(p, h);
  const want = process.env.PLATFORM_ADMIN_PASSWORD; return !!want && eq(sha(String(p)), sha(want));
}
const adminToken = () => { const b = b64u(JSON.stringify({ exp: Date.now() + 12 * 3600e3 })); return b + '.' + adminSign(b); };
async function platformApi(req, res, url) {
  const q = new URL(req.url, 'http://x').searchParams;
  if (req.method === 'GET' && url === '/api/platform/info') return send(res, 200, { name: PLATFORM });
  // How far the photos have been copied from Supabase to the hosting (counts only).
  if (req.method === 'GET' && url === '/api/platform/photos-status') return send(res, 200, await photoStatus());
  if (req.method === 'GET' && url === '/api/platform/slug') {
    const v = String(q.get('s') || '').toLowerCase(), want = slugOK(v) ? v : slugify(v);
    if (!slugOK(want)) return send(res, 200, { ok: false, slug: want, why: 'Use 3 to 40 small letters, numbers or dashes.' });
    try { const r = await shopBySlug(want); return send(res, 200, { ok: !r, slug: want, why: r ? 'Already used by another shop.' : '' }); }
    catch (e) { return send(res, 502, { error: 'Could not check the link.' }); }
  }
  if (req.method === 'POST' && url === '/api/platform/signup') return signup(req, res);
  if (req.method === 'POST' && url === '/api/platform/login') return emailLogin(req, res);
  if (req.method === 'POST' && url === '/api/platform/reset/code') return emailResetCode(req, res);
  if (req.method === 'POST' && url === '/api/platform/reset') return emailReset(req, res);
  if (req.method === 'POST' && url === '/api/platform/admin/login') {
    const k = 'adm:' + clientIp(req), w = tooMany(k) || tooMany('adm:all'); if (w) return send(res, 429, { error: 'Too many wrong tries. Wait ' + w + ' minutes.' });
    let m; try { m = JSON.parse(await readBody(req)); } catch (e) { return send(res, 400, { error: 'Not valid data.' }); }
    if (!(await adminHash(true)) && !process.env.PLATFORM_ADMIN_PASSWORD) return send(res, 503, { error: 'Set PLATFORM_ADMIN_PASSWORD on the server first.' });
    if (!(await adminPwOK(String(m.password || '').slice(0, 200)))) { failed(k, 6); failed('adm:all', 20); return send(res, 401, { error: 'Wrong admin password.' }); }
    loginFails.delete(k); return send(res, 200, { ok: true, token: adminToken() });
  }
  if (url.startsWith('/api/platform/admin/')) {
    if (!(await adminOK(req))) return send(res, 401, { error: 'Log in as admin again.' });
    if (req.method === 'POST' && url === '/api/platform/admin/password') {
      const k = 'admpw:' + clientIp(req), w = tooMany(k); if (w) return send(res, 429, { error: 'Too many wrong tries. Wait ' + w + ' minutes.' });
      let m; try { m = JSON.parse(await readBody(req)); } catch (e) { return send(res, 400, { error: 'Not valid data.' }); }
      const cur = String(m.current || '').slice(0, 200), np = String(m.password || '').slice(0, 200);
      if (!(await adminPwOK(cur))) { failed(k, 6); return send(res, 400, { error: 'Your current password is not right.', f: 'cur' }); }
      if (np.length < 8 || !/[A-Za-z]/.test(np) || !/\d/.test(np)) return send(res, 400, { error: 'Use at least 8 characters with both letters and numbers.', f: 'np' });
      if (np === cur) return send(res, 400, { error: 'Choose a password different from the current one.', f: 'np' });
      try { await sbCall('mt_kv_set', { p_k: 'admin_pw', p_v: await mkHash(np) }); } catch (e) { console.error('admin pw save', e.message); return send(res, 502, { error: 'Could not save the new password. Try again.' }); }
      await adminHash(true); console.log('admin password changed');
      return send(res, 200, { ok: true, token: adminToken() });
    }
    // Shared payments (Paystack): on/off, commission, your details; per shop: on/off, commission, payouts.
    if (url === '/api/platform/admin/pay') {
      let v = await payCfg(true); if (!v) return send(res, 502, { error: 'Could not read the payment settings.' });
      if (req.method === 'POST') {
        let m; try { m = JSON.parse(await readBody(req)); } catch (e) { return send(res, 400, { error: 'Not valid data.' }); }
        const t = (x, n) => String(x || '').trim().slice(0, n);
        const cfg = { on: !!v.on, off: Array.isArray(v.off) ? v.off : [], pct: v.pct != null ? +v.pct : 5, rates: v.rates && typeof v.rates === 'object' ? v.rates : {}, me: v.me && typeof v.me === 'object' ? v.me : {} };
        if (typeof m.on === 'boolean') cfg.on = m.on;
        if (m.pct != null && m.pct !== '' && !m.id) { const p = +m.pct; if (!(p >= 0 && p <= 50)) return send(res, 400, { error: 'Commission must be between 0 and 50%.' }); cfg.pct = Math.round(p * 100) / 100; }
        if (m.me && typeof m.me === 'object') cfg.me = { name: t(m.me.name, 60), phone: t(m.me.phone, 20), email: t(m.me.email, 120), kind: m.me.kind === 'bank' ? 'bank' : 'momo', bank: t(m.me.bank, 40), acctName: t(m.me.acctName, 60), number: t(m.me.number, 30) };
        if (m.id && typeof m.shopOn === 'boolean') { cfg.off = cfg.off.filter((x) => x !== m.id); if (!m.shopOn) cfg.off.push(String(m.id).slice(0, 40)); }
        if (m.id && m.rate !== undefined) { if (m.rate === '' || m.rate === null) delete cfg.rates[m.id]; else { const p = +m.rate; if (!(p >= 0 && p <= 50)) return send(res, 400, { error: 'Commission must be between 0 and 50%.' }); cfg.rates[String(m.id).slice(0, 40)] = Math.round(p * 100) / 100; } }
        try { await sbCall('mt_kv_set', { p_k: 'shared_pay', p_v: JSON.stringify(cfg) }); } catch (e) { console.error('shared pay save', e.message); return send(res, 502, { error: 'Could not save.' }); }
        console.log('shared payments: ' + (cfg.on ? 'on' : 'off') + ', ' + cfg.pct + '% commission');
        v = await payCfg(true); for (const st of stores.values()) st.payReset && st.payReset();
      }
      return send(res, 200, { ok: true, on: !!v.on, off: v.off || [], pct: v.pct != null ? +v.pct : 5, rates: v.rates || {}, me: v.me || {}, ready: !!v.ready, live: !!v.live });
    }
    // Withdrawal requests from shop owners that are waiting to be paid, oldest first (the bell on /admin).
    if (req.method === 'GET' && url === '/api/platform/admin/withdrawals') {
      let L; try { L = (await sbCall('mt_wd_list', {})) || []; } catch (e) { console.error('withdrawals', e.message); return send(res, 502, { error: 'Could not read the withdrawal requests.' }); }
      const open = [];
      for (const s of L) for (const x of Array.isArray(s.recs) ? s.recs : []) if (x && x.status === 'open') open.push({ shop: s.id, name: s.name, slug: s.slug, phone: s.phone || '', id: x.id, at: +x.at || 0, amt: +x.amt || 0, by: x.by || '', acct: x.acct || null });
      open.sort((a, b) => a.at - b.at);
      return send(res, 200, { ok: true, open, hours: 24 });
    }
    if (url === '/api/platform/admin/payouts' || url === '/api/platform/admin/payout' || url === '/api/platform/admin/payacct') {
      const L = (await sbCall('mt_shop_list', {})) || [];
      if (req.method === 'GET' && !q.get('id')) { // money owed to every shop
        const out = [];
        for (const r of L) { try { const g = await ctx.run({ shop: r }, () => store().ledger()); if (g.collected || g.paid) out.push({ id: r.id, name: r.name, slug: r.slug, collected: g.collected, fees: g.fees, net: g.net, paid: g.paid, due: g.due, acct: g.acct }); } catch (e) { console.error('ledger ' + r.slug, e.message); } }
        return send(res, 200, { ok: true, shops: out });
      }
      let m = {}; if (req.method === 'POST') { try { m = JSON.parse(await readBody(req)); } catch (e) { return send(res, 400, { error: 'Not valid data.' }); } }
      const r = L.find((x) => x.id === (q.get('id') || m.id)); if (!r) return send(res, 404, { error: 'Shop not found.' });
      return ctx.run({ shop: r }, async () => {
        const st = store();
        try {
          if (url === '/api/platform/admin/payacct' && req.method === 'POST') await st.setAcct(m.acct);
          if (url === '/api/platform/admin/payout' && req.method === 'POST') {
            if (m.del) await st.delPayout(m.del);
            else if (m.decline) { // a withdrawal request that can't be paid (e.g. wrong account): closed, and the owner is told
              const x = await st.wdDecline(m.decline, m.note);
              const sh = await shopMain(false), ph = st.normPhone((sh && sh.set && sh.set.phone) || r.phone);
              if (ph) st.sendSms(ph, PLATFORM + ': we could not pay your withdrawal of GHS ' + (+x.amt).toFixed(2) + (x.note ? ' (' + x.note + ')' : '') + '. Check your account in Online shop > Settings > Payments, then ask again.', { free: true }).catch((e) => console.log('withdrawal sms: ' + e.message));
            } else {
              const rec = await st.addPayout({ amt: m.amt, method: m.method, ref: m.ref, note: m.note, wd: m.wd, by: 'Platform admin' });
              const sh = await shopMain(false), ph = st.normPhone((sh && sh.set && sh.set.phone) || r.phone);
              if (ph && m.notify !== false) st.sendSms(ph, PLATFORM + ': we have paid ' + r.name + ' GHS ' + rec.amt.toFixed(2) + (rec.method ? ' by ' + rec.method : '') + (rec.ref ? ' (ref ' + rec.ref + ')' : '') + ' for your online sales. Details: Online shop > Settings > Payments.', { free: true }).catch((e) => console.log('payout sms: ' + e.message));
            }
          }
          return send(res, 200, Object.assign({ ok: true, shop: { id: r.id, name: r.name, slug: r.slug, phone: r.phone } }, await st.ledger()));
        } catch (e) { return send(res, 400, { error: e.message }); }
      });
    }
    // Shared SMS account: on/off for all shops, and per shop.
    if (url === '/api/platform/admin/sms') {
      let v = await sharedCfg(true); if (!v) return send(res, 502, { error: 'Could not read the SMS settings.' });
      if (req.method === 'POST') {
        let m; try { m = JSON.parse(await readBody(req)); } catch (e) { return send(res, 400, { error: 'Not valid data.' }); }
        const cfg = { on: !!v.on, off: Array.isArray(v.off) ? v.off.filter((x) => typeof x === 'string') : [], free: v.free != null ? +v.free : 10, plans: Array.isArray(v.plans) && v.plans.length ? v.plans : SMS_PLANS };
        if (typeof m.on === 'boolean') cfg.on = m.on;
        if (m.free != null) { const f = Math.trunc(+m.free); if (!(f >= 0 && f <= 10000)) return send(res, 400, { error: 'Free SMS per month must be a number from 0 to 10000.' }); cfg.free = f; }
        if (Array.isArray(m.plans)) {
          const P = m.plans.slice(0, 6).map((x) => ({ gh: Math.round((+(x && x.gh) || 0) * 100) / 100, sms: Math.trunc(+(x && x.sms) || 0) })).filter((x) => x.gh > 0 && x.sms > 0).sort((a, b) => a.gh - b.gh);
          if (!P.length) return send(res, 400, { error: 'Add at least one SMS plan with a price and a number of SMS.' }); cfg.plans = P;
        }
        if (m.id && typeof m.shopOn === 'boolean') { cfg.off = cfg.off.filter((x) => x !== m.id); if (!m.shopOn) cfg.off.push(String(m.id).slice(0, 40)); }
        try { await sbCall('mt_kv_set', { p_k: 'shared_sms', p_v: JSON.stringify(cfg) }); } catch (e) { console.error('shared sms save', e.message); return send(res, 502, { error: 'Could not save.' }); }
        console.log('shared sms: ' + (cfg.on ? 'on' : 'off') + ', off for ' + cfg.off.length + ' shop(s)');
        v = await sharedCfg(true); for (const st of stores.values()) st.smsReset && st.smsReset();
      }
      let balance = null;
      if (v.token) { try { const r = await fetch((process.env.USMS_API || 'https://webapp.usmsgh.com/api') + '/balance', { headers: { Authorization: 'Bearer ' + v.token, Accept: 'application/json' }, signal: AbortSignal.timeout(10000) }); const j = await r.json(); balance = j.data && (j.data.remaining_balance ?? j.data.balance ?? null); } catch (e) {} }
      return send(res, 200, { ok: true, on: !!v.on, off: v.off || [], sender: v.sender || '', ready: !!v.ready, balance, free: v.free != null ? +v.free : 10, plans: Array.isArray(v.plans) && v.plans.length ? v.plans : SMS_PLANS });
    }
    // SMS plan orders from shops: list, confirm (the plan starts at once) or decline. The shop owner is told by SMS.
    if (url === '/api/platform/admin/smsorders') {
      if (req.method === 'POST') {
        let m; try { m = JSON.parse(await readBody(req)); } catch (e) { return send(res, 400, { error: 'Not valid data.' }); }
        const o = ((await sbCall('mt_sms_order_list', { p_shop: null })) || []).find((x) => +x.id === +m.id); if (!o) return send(res, 404, { error: 'Order not found.' });
        const r = ((await sbCall('mt_shop_list', {})) || []).find((x) => x.id === o.shop_id); if (!r) return send(res, 404, { error: 'Shop not found.' });
        const ok = !!m.ok, note = String(m.note || '').trim().slice(0, 200);
        const d = await sbCall('mt_sms_order_set', { p_id: o.id, p_status: ok ? 'approved' : 'declined', p_note: note });
        if (!d || d.error) return send(res, 400, { error: (d && d.error) || 'Could not save.' });
        let until = null;
        if (ok) { const patch = smsPlanPatch(r, +o.sms, +o.months || 1); until = patch.sms_until;
          try { await sbCall('mt_shop_set', { p_id: r.id, p_patch: patch }); listCache.at = 0; }
          catch (e) { console.error('sms order plan', e.message); await sbCall('mt_sms_order_set', { p_id: o.id, p_status: 'declined', p_note: 'error' }).catch(() => {}); return send(res, 502, { error: 'Could not turn the plan on. Try again.' }); } }
        const ph = (await ctx.run({ shop: r }, () => shopMain(false)).catch(() => null) || {}).set, to = (ph && ph.phone) || o.phone || r.phone;
        const text = ok ? PLATFORM + ': your SMS order #' + o.id + ' is confirmed. ' + r.name + ' now has ' + o.sms + ' extra SMS a month until ' + new Date(until).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) + '. Thank you!'
          : PLATFORM + ': we could not confirm your SMS order #' + o.id + ' (MoMo ID ' + o.txid + ')' + (note ? ': ' + note : '') + '. Check the transaction ID and order again, or WhatsApp ' + HELP_WA + '.';
        platformSms(to, text).catch((e) => console.log('sms order reply: ' + e.message));
        console.log('sms order #' + o.id + ' ' + (ok ? 'confirmed' : 'declined') + ': ' + r.slug);
      }
      try { return send(res, 200, { ok: true, orders: (await sbCall('mt_sms_order_list', { p_shop: null })) || [], momo: SMS_MOMO }); }
      catch (e) { return send(res, 502, { error: 'Could not load the SMS orders.' }); }
    }
    // Reminder SMS to shop owners: on/off, mute one shop, who is due next, what was sent.
    if (url === '/api/platform/admin/nudge') {
      let v = await nudgeCfg(true); if (!v) return send(res, 502, { error: 'Could not read the reminder settings.' });
      if (req.method === 'POST') {
        let m; try { m = JSON.parse(await readBody(req)); } catch (e) { return send(res, 400, { error: 'Not valid data.' }); }
        if (typeof m.on === 'boolean') v.on = m.on;
        if (m.id && typeof m.shopOn === 'boolean') { v.off = v.off.filter((x) => x !== m.id); if (!m.shopOn) v.off.push(String(m.id).slice(0, 40)); }
        try { await nudgeSave(v); } catch (e) { console.error('nudge save', e.message); return send(res, 502, { error: 'Could not save.' }); }
        console.log('reminder SMS: ' + (v.on ? 'on' : 'off') + ', muted for ' + v.off.length + ' shop(s)');
        v = await nudgeCfg(true);
      }
      const sh = await sharedCfg(true);
      return send(res, 200, { ok: true, on: !!v.on, off: v.off, ready: !!(sh && sh.token && sh.sender), help: HELP_WA, due: await nudgeRun(true), log: (v.log || []).slice(-30).reverse().map((x) => ({ ts: x.ts, name: x.name, slug: x.slug, stage: x.stage, n: x.n, ok: x.ok, err: x.err })) });
    }
    if (req.method === 'GET' && url === '/api/platform/admin/view') {
      const r = ((await sbCall('mt_shop_list', {})) || []).find((x) => x.id === q.get('id')); if (!r) return send(res, 404, { error: 'Shop not found.' });
      try { return send(res, 200, Object.assign({ ok: true }, await shopView(r))); } catch (e) { console.error('view', e.message); return send(res, 502, { error: 'Could not load the shop.' }); }
    }
    if (req.method === 'GET' && url === '/api/platform/admin/shops') {
      try {
        const L = (await sbCall('mt_shop_list', {})) || [], stats = {};
        // st: what each shop holds and when it was last used (one database call). The list still loads without it.
        try { for (const x of (await sbCall('mt_shop_stats', {})) || []) stats[x.id] = x; } catch (e) { console.error('shop stats', e.message); }
        let sms = {}; try { sms = (await sbCall('mt_sms_usage', {})) || {}; } catch (e) { console.error('sms usage', e.message); }
        return send(res, 200, { ok: true, shops: L.map((r) => Object.assign(pubShop(r), { st: stats[r.id] || null, sms: sms[r.id] || null })) });
      }
      catch (e) { return send(res, 502, { error: 'Could not load the shops.' }); }
    }
    if (req.method === 'POST' && url === '/api/platform/admin/shop') {
      let m; try { m = JSON.parse(await readBody(req)); } catch (e) { return send(res, 400, { error: 'Not valid data.' }); }
      const L = (await sbCall('mt_shop_list', {})) || [], r = L.find((x) => x.id === m.id); if (!r) return send(res, 404, { error: 'Shop not found.' });
      const now = Date.now(), base = (d) => Math.max(now, d ? Date.parse(d) : 0), n = Math.max(1, Math.min(36, +m.n || 1)), patch = {};
      if (m.act === 'delete') {
        if (String(m.confirm || '').trim().toLowerCase() !== r.slug) return send(res, 400, { error: 'Type the shop link (' + r.slug + ') to confirm.' });
        try { await sbCall('mt_shop_delete', { p_id: r.id }); } catch (e) { console.error('delete shop', e.message); return send(res, 502, { error: 'Could not delete the shop.' }); }
        await ctx.run({ shop: r }, () => fsp.rm(bdir(), { recursive: true, force: true })).catch(() => {});
        slugCache.delete(r.slug); shopCache.delete(r.id); listCache.at = 0; console.log('shop deleted: ' + r.slug);
        return send(res, 200, { ok: true, deleted: r.id });
      }
      if (m.act === 'suspend') patch.status = 'suspended';
      else if (m.act === 'activate') patch.status = 'active';
      else if (m.act === 'note') patch.note = String(m.note || '').slice(0, 300);
      else if (m.act === 'smsplan') { // paid SMS plan: SMS per month, for n months (30 days each); plan 0 removes it
        const pl = Math.trunc(+m.plan || 0); if (pl < 0 || pl > 1000000) return send(res, 400, { error: 'Not a valid SMS plan.' });
        Object.assign(patch, smsPlanPatch(r, pl, n));
        console.log('sms plan: ' + r.slug + ' ' + (pl ? pl + ' SMS/month until ' + patch.sms_until.slice(0, 10) : 'removed'));
      }
      else return send(res, 400, { error: 'Unknown action.' });
      try { const out = await sbCall('mt_shop_set', { p_id: r.id, p_patch: patch }); slugCache.delete(r.slug); listCache.at = 0; return send(res, 200, { ok: true, shop: pubShop(out) }); }
      catch (e) { return send(res, 502, { error: 'Could not save.' }); }
    }
  }
  return send(res, 404, { error: 'Not found.' });
}

// ================= web server =================
const files = new Map();
function file(p) { if (!files.has(p)) files.set(p, fs.readFileSync(p, 'utf8')); return files.get(p); }
const jsonScript = (o) => JSON.stringify(o).replace(/</g, '\\u003c');
function html(res, req, body, code) {
  res.writeHead(code || 200, Object.assign({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' }, HEADERS));
  res.end(req.method === 'HEAD' ? undefined : body);
}
const platInfo = (extra) => '<script>window.PLAT=' + jsonScript(Object.assign({ name: PLATFORM }, extra || {})) + '</script>';
function landing(req, res, extra, code, f) { return html(res, req, file(f || LANDING).replace('<!--PLAT-->', platInfo(extra)), code); }
const notFound = (req, res, slug) => landing(req, res, { notFound: String(slug).slice(0, 40) }, 404, LOGIN);
// ---- product photos at /<shop>/img/<key>: kept on the hosting per shop, outside the website folder (deploys don't touch it).
// Photos uploaded before 22 Nov 2026 were kept in Supabase (mt_photos); photoSync copies them here once, and the
// originals saved on 21 Nov (mt_photos_backup_20261121) go to PHOTO_DIR/_originals-20261121, so nothing is lost
// when they are removed from Supabase. Until then a photo missing here is still read from Supabase. ----
const PHOTO_DIR = process.env.PHOTO_DIR || path.join(os.homedir(), 'tessa-photos');
const PHOTO_ORIG = path.join(PHOTO_DIR, '_originals-20261121');
const PHOTO_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const sdir = (root, shop) => path.join(root, String(shop).replace(/[^A-Za-z0-9-]/g, ''));
const pdir = () => sdir(PHOTO_DIR, SID());
// Writes the whole file or nothing (temporary name, then rename), so a half-written photo is never served.
async function photoWrite(shop, key, mime, buf, root) {
  if (!PHOTO_EXT[mime] || !/^[A-Za-z0-9]+$/.test(key)) throw new Error('bad photo');
  const dir = sdir(root || PHOTO_DIR, shop), f = path.join(dir, key + '.' + PHOTO_EXT[mime]), tmp = f + '.' + process.pid + '.tmp';
  await fsp.mkdir(dir, { recursive: true }); await fsp.writeFile(tmp, buf); await fsp.rename(tmp, f);
}
function photoCacheSave(key, mime, buf) { photoWrite(SID(), key, mime, buf).catch((e) => console.error('photo cache', e.message)); }
const PHOTO_MARK = path.join(PHOTO_DIR, '.copied-from-supabase.json');
let PSYNC = { state: 'not started' };
// Copies every photo from Supabase to the hosting. A file already here is kept only if it is the same photo.
// The hosting runs several server processes; a lock file lets only one of them copy (a lock older than 30 minutes is stale).
const PHOTO_LOCK = path.join(PHOTO_DIR, '.copying.lock');
async function photoLock() {
  await fsp.mkdir(PHOTO_DIR, { recursive: true });
  try { await fsp.writeFile(PHOTO_LOCK, String(process.pid), { flag: 'wx' }); return true; } catch (e) {
    const st = await fsp.stat(PHOTO_LOCK).catch(() => null);
    if (st && Date.now() - st.mtimeMs > 30 * 60000) { await fsp.unlink(PHOTO_LOCK).catch(() => {}); return photoLock(); }
    return false;
  }
}
async function photoSync() {
  if (PSYNC.state === 'running') return;
  if (!(await photoLock().catch(() => false))) { PSYNC = { state: 'another server process is copying' }; return; }
  PSYNC = { state: 'running', pid: process.pid, started: new Date().toISOString(), live: { checked: 0, written: 0, failed: 0 }, orig: { checked: 0, written: 0, failed: 0 } };
  try {
    for (const src of ['live', 'orig']) {
      const C = PSYNC[src], root = src === 'live' ? PHOTO_DIR : PHOTO_ORIG; let after = '';
      for (;;) {
        let L; for (let t = 1; ; t++) { // a page that fails is tried again a few times before the copy stops
          try { L = (await sbCall('mt_photo_dump', { p_src: src, p_after: after, p_limit: 10 })) || []; break; }
          catch (e) { if (t >= 4) throw e; await new Promise((r) => setTimeout(r, 3000 * t)); }
        }
        if (!L.length) break;
        for (const x of L) {
          after = x.s + '/' + x.k; C.checked++;
          try {
            const buf = Buffer.from(x.d, 'base64'), f = path.join(sdir(root, x.s), x.k + '.' + PHOTO_EXT[x.m]);
            const cur = await fsp.readFile(f).catch(() => null);
            if (!cur || !cur.equals(buf)) { await photoWrite(x.s, x.k, x.m, buf, root); C.written++; }
          } catch (e) { C.failed++; console.error('photo copy', x.s, x.k, e.message); }
        }
      }
    }
    PSYNC.state = PSYNC.live.failed || PSYNC.orig.failed ? 'finished with errors' : 'done'; PSYNC.finished = new Date().toISOString();
    if (PSYNC.state === 'done') await fsp.writeFile(PHOTO_MARK, JSON.stringify(PSYNC));
  } catch (e) { PSYNC.state = 'stopped: ' + e.message; console.error('photo sync', e.message); }
  finally { await fsp.unlink(PHOTO_LOCK).catch(() => {}); }
}
// Counts the photos in Supabase and the files on the hosting, so the copy can be checked before Supabase is emptied.
async function photoStatus() {
  const count = async (root) => { let n = 0, bytes = 0;
    for (const d of await fsp.readdir(root, { withFileTypes: true }).catch(() => [])) {
      if (!d.isDirectory() || d.name.startsWith('_')) continue;
      for (const f of await fsp.readdir(path.join(root, d.name)).catch(() => [])) if (/\.(jpg|png|webp)$/.test(f)) { n++; bytes += (await fsp.stat(path.join(root, d.name, f)).catch(() => ({ size: 0 }))).size; }
    } return { files: n, mb: +(bytes / 1048576).toFixed(1) }; };
  let db = null; try { db = await sbCall('mt_photo_count', {}); } catch (e) { db = { error: e.message }; }
  let mark = null; try { mark = JSON.parse(await fsp.readFile(PHOTO_MARK, 'utf8')); } catch (e) {}
  return { supabase: db, hosting: await count(PHOTO_DIR), originals: await count(PHOTO_ORIG), sync: PSYNC, lastFullCopy: mark && { finished: mark.finished, live: mark.live, orig: mark.orig } };
}
async function photoServe(req, res, key) {
  const done = (mime, buf) => { res.writeHead(200, Object.assign({ 'Content-Type': mime, 'Cache-Control': 'public, max-age=31536000, immutable' }, HEADERS)); res.end(req.method === 'HEAD' ? undefined : buf); };
  for (const [mime, ext] of Object.entries(PHOTO_EXT)) { try { return done(mime, await fsp.readFile(path.join(pdir(), key + '.' + ext))); } catch (e) {} }
  try {
    const v = await sbCall('shop_photo_get', { p_key: key });
    if (!v || !PHOTO_EXT[v.mime]) { res.writeHead(404); return res.end(); }
    const buf = Buffer.from(v.data, 'base64'); photoCacheSave(key, v.mime, buf); return done(v.mime, buf);
  } catch (e) { console.error('photo get', e.message); res.writeHead(502); return res.end(); }
}

// ---- online shop, receipts, invoices, SMS (store.js): one instance per shop, each with its own caches and keys ----
const makeStore = require('./store');
const stores = new Map(); // shop id -> store instance (created inside the shop's context)
// Shared SMS account: the platform owner's USMS-GH account, lent to shops without their own while the admin switch is on.
let shSms = { at: 0, v: null };
async function sharedCfg(fresh) {
  if (fresh || Date.now() - shSms.at > 30000) { try { shSms = { at: Date.now(), v: await sbCall('mt_shared_sms', {}) }; } catch (e) { console.error('shared sms', e.message); shSms = { at: Date.now(), v: null }; } }
  return shSms.v;
}
// Shared payments: the platform owner's Paystack account takes online payments for shops without their own key;
// the platform pays each shop out (minus its commission) and records the payouts.
let shPay = { at: 0, v: null };
async function payCfg(fresh) {
  if (fresh || Date.now() - shPay.at > 30000) { try { shPay = { at: Date.now(), v: await sbCall('mt_shared_pay', {}) }; } catch (e) { console.error('shared pay', e.message); shPay = { at: Date.now(), v: null }; } }
  return shPay.v;
}
const payPct = (v, id) => { const r = v && v.rates && v.rates[id]; return Math.max(0, Math.min(50, +(r != null && r !== '' ? r : (v && v.pct != null ? v.pct : 5)) || 0)); };
async function sharedPay(fresh) { const v = await payCfg(!!fresh); return v && v.on && v.key && !(v.off || []).includes(SID()) ? { key: v.key, pct: payPct(v, SID()) } : null; }
async function sharedSms() { const v = await sharedCfg(false); return v && v.on && v.token && !(v.off || []).includes(SID()) ? { token: v.token, sender: v.sender } : null; }
// SMS allowance on the shared account: free SMS every month (shared_sms.free, 10) plus the shop's paid SMS plan, if any.
// Shops pay for a plan by Mobile Money to the platform owner, then send the transaction ID on WhatsApp.
const SMS_MOMO = { num: process.env.SMS_PAY_MOMO || '0244022727', name: process.env.SMS_PAY_NAME || 'Emmanuel Buckson' };
const SMS_PLANS = [{ gh: 30, sms: 300 }, { gh: 60, sms: 700 }, { gh: 120, sms: 1500 }];
const smsTake = (n) => sbCall('mt_sms_take', { p_shop: SID(), p_n: Math.trunc(+n || 0) }); // n = 0 only reads this month's use
// SMS plan orders: the shop enters its MoMo transaction ID in the POS; the platform admin is told (SMS + email) and confirms in admin.
const SMS_ORDER_TO = { phone: process.env.SMS_ORDER_PHONE || SMS_MOMO.num, email: process.env.SMS_ORDER_EMAIL || '' };
// SMS plan for a shop: pl SMS a month for n months (30 days each). Same plan again adds months; a new plan starts today.
function smsPlanPatch(r, pl, n) {
  if (!pl) return { sms_plan: 0, sms_until: null };
  const now = Date.now(), cur = r.sms_until ? Date.parse(r.sms_until) : 0;
  return { sms_plan: pl, sms_until: new Date((+r.sms_plan === pl && cur > now ? cur : now) + n * 30 * 864e5).toISOString() };
}
async function platformSms(phone, text) { // from the shared account, never counted against a shop
  const v = await sharedCfg(true), ph = nPhone(phone); if (!(v && v.token && v.sender && ph)) return false;
  await nudgeSend(v.token, v.sender, ph, text); return true;
}
async function smsOrder(o) { // inside a shop
  const r = await sbCall('mt_sms_order_add', { p_shop: SID(), p_o: o });
  if (!r || r.error) { const e = new Error((r && r.error) || 'Could not send the order.'); e.code = 400; throw e; }
  const sh = T().shop, tot = (o.gh * o.months).toFixed(2);
  const line = 'New SMS order #' + r.id + ' from ' + sh.name + ' (/' + sh.slug + '): ' + o.sms + ' SMS a month for ' + o.months + ' month' + (o.months > 1 ? 's' : '') + ', GHS ' + tot + '. MoMo transaction ID ' + o.txid + (o.payer ? ', paid by ' + o.payer : '') + (o.phone ? ' ' + o.phone : '') + '.';
  platformSms(SMS_ORDER_TO.phone, PLATFORM + ': ' + line + ' Check the MoMo, then confirm in admin.').catch((e) => console.log('sms order alert: ' + e.message));
  (async () => { const to = SMS_ORDER_TO.email || ((await payCfg(false)) || {}).me && (await payCfg(false)).me.email; if (to) await sendEmail({ to: [to], subject: PLATFORM + ': SMS order #' + r.id + ' from ' + sh.name + ' (GHS ' + tot + ')', text: line + '\n\nCheck that the money arrived on ' + SMS_MOMO.num + ', then open admin > Payments, SMS and reminders > SMS orders to confirm or decline.\n\nhttps://' + hostName() + '/admin' }); })().catch((e) => console.log('sms order email: ' + e.message));
  console.log('sms order #' + r.id + ': ' + sh.slug + ' ' + o.sms + ' SMS x ' + o.months + ' (GHS ' + tot + ') tx ' + o.txid);
  return r;
}
const smsOrders = () => sbCall('mt_sms_order_list', { p_shop: SID() });
async function smsPlans() { const v = await sharedCfg(false); return (v && Array.isArray(v.plans) && v.plans.length ? v.plans : SMS_PLANS); }
const hostName = () => String(process.env.PLATFORM_HOST || 'tessapos.shop').replace(/^https?:\/\//, '').replace(/\/.*$/, '');
function store() {
  const id = SID(); if (id === '-') throw new Error('No shop');
  if (!stores.has(id)) stores.set(id, makeStore({ sbCall, sbOn, send, readBody, serverLog, shopMain, clientIp, sendEmail, HEADERS, caller,
    multi: true, noTimers: true, tabs: (s) => powers(s).t, sharedSms, sharedPay, smsTake, smsPlans, smsOrder, smsOrders, help: HELP_WA, platform: PLATFORM, smsMomo: SMS_MOMO, unchanged: async (rev) => { const r = await shopRevs(); return !!(r && +(r[SID()] || 0) === +rev); }, host: hostName(), base: () => '/' + T().shop.slug, scope: () => 'shop:' + SID() + ':', siteUrl: () => 'https://' + hostName() }));
  return stores.get(id);
}
// Credit reminders: every 10 minutes, for every open shop (each shop's own SMS account; sent once a day per customer).
async function remindAll() {
  let list; try { list = await allShops(true); } catch (e) { return console.error('reminders: shop list', e.message); }
  for (const r of list || []) {
    if (r.status !== 'active') continue;
    try { await ctx.run({ shop: r }, () => store().remindRun()); } catch (e) { console.error('reminders ' + r.slug, e.message); }
  }
}
if (sbOn()) { setTimeout(remindAll, 30000).unref(); setInterval(remindAll, +process.env.REMIND_EVERY_MS || 1800000).unref(); }

// ---- Reminder SMS to shop owners: people who created a shop but stopped part-way, or went quiet ----
// Sent from the platform's shared SMS account, 9am to 6pm Ghana time, each message once only (mt_job_once).
// Shops that are being used are left alone. Off until the admin switches it on at /admin, where one shop can also be muted.
const HELP_WA = process.env.SUPPORT_WHATSAPP || '0244022727';
const nPhone = (v) => { let d = String(v || '').replace(/\D/g, ''); if (d.startsWith('233') && d.length === 12) d = '0' + d.slice(3); else if (d.length === 9) d = '0' + d; return /^0\d{9}$/.test(d) ? d : ''; };
const NUDGE_STEPS = { setup: [1, 3, 7], first: [2, 5, 10], quiet: [7, 14, 30] };
const NUDGE_LBL = { setup: 'Created, nothing added yet', first: 'Set up, not used yet', quiet: 'Used before, now quiet' };
let nudgeC = { at: 0, v: null };
async function nudgeCfg(fresh) {
  if (fresh || Date.now() - nudgeC.at > 30000) {
    try { const s = await sbCall('mt_kv_get', { p_k: 'nudge' }); let j = {}; try { j = s ? JSON.parse(s) : {}; } catch (e) {}
      nudgeC = { at: Date.now(), v: { on: j.on === true, off: Array.isArray(j.off) ? j.off : [], log: Array.isArray(j.log) ? j.log : [] } }; }
    catch (e) { console.error('nudge settings', e.message); nudgeC = { at: Date.now(), v: null }; }
  }
  return nudgeC.v;
}
async function nudgeSave(v) { await sbCall('mt_kv_set', { p_k: 'nudge', p_v: JSON.stringify({ on: !!v.on, off: (v.off || []).slice(0, 2000), log: (v.log || []).slice(-80) }) }); nudgeC = { at: 0, v: null }; }
// Where a shop has got to, and the message that fits. null = leave this shop alone.
function nudgePlan(rec, docs, now) {
  const main = docs['shop/main'] || {}, set = main.set || {}, biz = set.biz || 'retail', DAY = 864e5;
  const keys = Object.keys(docs), has = (c) => keys.some((k) => k.startsWith(c + '/'));
  const recs = (c) => keys.filter((k) => k.startsWith(c + '/')).flatMap((k) => (docs[k] && docs[k].recs) || []);
  const sales = recs('sales').concat(recs('accra_sales'));
  const items = biz === 'school' ? has('students') : biz === 'courier' ? has('jobs') : (has('products') || has('accra_products'));
  const used = sales.length > 0 || (biz === 'school' && (has('att') || has('marks') || keys.some((k) => k.startsWith('students/') && ((docs[k] || {}).pays || []).length))) || (biz === 'courier' && has('jobs')) || (biz === 'restaurant' && has('kot'));
  const created = Date.parse(rec.created_at) || now;
  const lastAct = Math.max(created, ...recs('log').filter((x) => x && x.who && x.who !== '—').map((x) => +x.ts || 0), ...sales.map((x) => +x.ts || 0));
  const since = (t) => Math.floor((now - t) / DAY);
  let stage, days, tag = '';
  if (!items) { stage = 'setup'; days = since(created); }
  else if (!used) { stage = 'first'; days = since(lastAct); }
  else if (since(lastAct) >= 7) { stage = 'quiet'; days = since(lastAct); tag = ':' + new Date(lastAct).toISOString().slice(0, 10); }
  else return null; // in use: no reminders
  const steps = NUDGE_STEPS[stage], n = steps.filter((s) => days >= s).length;
  if (!n || days > steps[steps.length - 1] + 3) return null; // too early, or gone too long to chase
  const owner = (main.staff || []).find((x) => x.role === 'owner') || {};
  const f = String(rec.owner_name || owner.name || '').trim().split(/\s+/)[0].slice(0, 14) || 'Hello';
  const shop = String(rec.name || 'your shop').replace(/\s+/g, ' ').trim().slice(0, 24), link = hostName() + '/' + rec.slug, H = HELP_WA;
  const kind = { school: 'school', restaurant: 'restaurant', courier: 'delivery service' }[biz] || 'shop';
  const firstStep = { pharmacy: 'Add your first drug to start selling', restaurant: 'Add your menu to start taking orders', school: 'Add your classes and students to begin', courier: 'Add your first delivery to begin' }[biz] || 'Add your first product to start selling';
  const useStep = { restaurant: 'take your first order', school: 'take attendance or record a fee payment' }[biz] || 'record your first sale';
  const T = {
    setup: [
      `Hi ${f}, ${shop} is ready on Tessa POS. ${firstStep}: ${link} Need help? WhatsApp ${H}`,
      `${f}, ${shop} is not set up yet. It takes 2 minutes: ${link} Guide: ${hostName()}/help or WhatsApp ${H}`,
      `${f}, we are still keeping ${shop} for you. What stopped you? WhatsApp ${H} and we will set it up with you. ${link}`],
    first: [
      `Well done ${f}! ${shop} is set up. Next, ${useStep}: ${link} Stuck? WhatsApp ${H}`,
      `${f}, ${shop} is ready but not in use yet. Log in, ${useStep} and fill in your ${kind} details: ${link} Help: WhatsApp ${H}`,
      `${f}, is anything stopping you from using ${shop}? WhatsApp ${H} and we will help. Continue here: ${link}`],
    quiet: [
      `Hi ${f}, we have not seen ${shop} for a week. Your records are safe and waiting: ${link} Any problem? WhatsApp ${H}`,
      `${f}, ${shop} has been quiet for 2 weeks. Log in to keep your records up to date: ${link} Help: WhatsApp ${H}`,
      `${f}, it is a month since you used ${shop}. If something is not working for you, tell us on WhatsApp ${H}. ${link}`] };
  return { stage, n, days, key: 'nudge:' + stage + tag + ':' + steps[n - 1], text: T[stage][n - 1].replace('Tessa POS', PLATFORM), phone: nPhone(rec.phone) || nPhone(owner.phone) };
}
async function nudgeSend(token, sender, phone, text) {
  const r = await fetch((process.env.USMS_API || 'https://webapp.usmsgh.com/api') + '/sms/send', { method: 'POST', headers: { Authorization: 'Bearer ' + token, Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ recipient: '233' + phone.slice(1), sender_id: sender, type: 'plain', message: text.slice(0, 459) }), signal: AbortSignal.timeout(20000) });
  const t = await r.text(); let j = {}; try { j = JSON.parse(t); } catch (e) {}
  if (!r.ok || (j.status && j.status !== 'success')) throw new Error(j.message || ('USMS-GH answered ' + r.status));
}
let nudgeBusy = false;
// dry = true only lists who is due (for the admin page); nothing is sent or marked.
async function nudgeRun(dry) {
  if (nudgeBusy && !dry) return []; const out = [];
  try {
    if (!dry) nudgeBusy = true;
    const cfg = await nudgeCfg(true); if (!cfg || (!cfg.on && !dry)) return out;
    const hr = +new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Accra', hour: '2-digit', hour12: false }).format(new Date());
    if (!dry && (hr < 9 || hr >= 18)) return out;
    const sh = await sharedCfg(true); if (!dry && !(sh && sh.token && sh.sender)) return out;
    const sent = [];
    for (const r of (await allShops(true)) || []) {
      if (r.status !== 'active') continue;
      try {
        const muted = cfg.off.includes(r.id);
        const p = nudgePlan(r, await ctx.run({ shop: r }, () => allDocs()), Date.now()); if (!p) continue;
        const row = { id: r.id, slug: r.slug, name: r.name, stage: p.stage, n: p.n, days: p.days, text: p.text, phone: !!p.phone, muted };
        if (dry) { row.done = !!(cfg.log || []).find((x) => x.id === r.id && x.key === p.key); out.push(row); continue; }
        if (muted || !p.phone) continue;
        if (!(await ctx.run({ shop: r }, () => sbCall('job_once', { p_k: p.key })))) continue; // already sent (by this or another server process)
        const e = { ts: Date.now(), id: r.id, slug: r.slug, name: r.name, stage: p.stage, n: p.n, key: p.key, ok: true };
        try { await nudgeSend(sh.token, sh.sender, p.phone, p.text); ctx.run({ shop: r }, () => serverLog('Reminder SMS from ' + PLATFORM, NUDGE_LBL[p.stage] + ' · message ' + p.n + ' · to ' + p.phone.slice(0, 3) + '****' + p.phone.slice(-3))); }
        catch (x) { e.ok = false; e.err = String(x.message || x).slice(0, 120); console.error('nudge ' + r.slug, e.err); }
        sent.push(e); out.push(e);
      } catch (x) { console.error('nudge ' + r.slug, x.message); }
    }
    if (sent.length) { try { const c = await nudgeCfg(true); if (c) { c.log = (c.log || []).concat(sent); await nudgeSave(c); } } catch (x) { console.error('nudge log', x.message); } console.log('reminder SMS: ' + sent.filter((x) => x.ok).length + ' sent, ' + sent.filter((x) => !x.ok).length + ' failed'); }
  } catch (x) { console.error('nudge run', x.message); } finally { if (!dry) nudgeBusy = false; }
  return out;
}
// Copy the photos from Supabase once (skipped after a full copy has been made).
if (sbOn()) setTimeout(() => fsp.access(PHOTO_MARK).catch(() => photoSync()), 20000).unref();
if (sbOn()) { setTimeout(nudgeRun, 120000).unref(); setInterval(nudgeRun, +process.env.NUDGE_EVERY_MS || 1800000).unref(); }
if (process.env.NUDGE_TEST) module.exports = { nudgePlan, nPhone };

function shopPage(req, res, rec) {
  const info = { slug: rec.slug, name: rec.name, plan: planState(rec), platform: PLATFORM };
  const b = file(PAGE).replace('<head>', '<head><script>window.SHOP=' + jsonScript(info) + '</script>')
    .replace('href="/manifest.webmanifest"', 'href="/' + rec.slug + '/manifest.webmanifest"')
    .replace(/<title>[^<]*<\/title>/, '<title>' + rec.name.replace(/[<&]/g, '') + ' · ' + PLATFORM + '</title>')
    .replace('content="Renatel Shop"', 'content="' + rec.name.replace(/["<&]/g, '') + '"')
    .replace(/\/logo-icon\.svg/g, '/icon-192.png').replace(/src="\/img\//g, 'src="/' + rec.slug + '/img/').replace(/on renatel\.shop/g, 'on the website').replace(/website, renatel\.shop/g, 'website').replace(/renatel\.shop/g, 'the website');
  return html(res, req, b);
}
const ICONS = { '/icon-192.png': 'icon-192.png', '/icon-512.png': 'icon-512.png', '/apple-touch-icon.png': 'apple-touch-icon.png', '/apple-touch-icon-precomposed.png': 'apple-touch-icon.png', '/favicon.ico': 'icon-192.png' };

http.createServer(async (req, res) => {
  try {
    const url = (req.url || '/').split('?')[0];
    if (url.startsWith('/api/platform/')) return await platformApi(req, res, url);
    if (url === '/robots.txt') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('User-agent: *\nAllow: /$\nAllow: /help$\nDisallow: /\n'); }
    if (ICONS[url]) {
      return fs.readFile(path.join(__dirname, 'icons', ICONS[url]), (e, buf) => {
        if (e) { res.writeHead(404); return res.end(); }
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=604800' }); res.end(buf);
      });
    }
    const parts = url.split('/').filter(Boolean);
    if (!parts.length) return (req.method === 'GET' || req.method === 'HEAD') ? landing(req, res) : send(res, 405, { error: 'Not allowed.' });
    if (parts[0] === 'admin' && parts.length === 1) return html(res, req, file(ADMIN).replace('<!--PLAT-->', platInfo()));
    if (parts.length === 1 && parts[0] === 'login') return landing(req, res, null, 200, LOGIN);
    if (parts.length === 1 && (parts[0] === 'help' || parts[0] === 'support')) return landing(req, res, null, 200, HELP);
    if (parts.length === 1 && (parts[0] === 'register' || parts[0] === 'signup')) return landing(req, res, null, 200, REGISTER);
    if (url === '/assets/site.css') { res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'public, max-age=300' }); return res.end(file(CSS)); }
    const slug = parts[0].toLowerCase();
    if (!slugOK(slug)) return parts[0] === 'api' ? send(res, 404, { error: 'Open your shop link first, e.g. /your-shop.' }) : notFound(req, res, parts[0]);
    if (!sbOn()) return send(res, 503, { error: 'The database is not set up on the server yet.' });
    let rec; try { rec = await shopBySlug(slug); } catch (e) { console.error('shop lookup', e.message); return send(res, 502, { error: 'Could not reach the database. Try again in a moment.' }); }
    if (!rec) return parts[1] === 'api' ? send(res, 404, { error: 'This shop does not exist.' }) : notFound(req, res, slug);
    if (parts[0] !== slug) { res.writeHead(301, { Location: '/' + slug + url.slice(slug.length + 1) }); return res.end(); }
    const rest = '/' + parts.slice(1).join('/');
    if (rest.startsWith('/api/')) return await ctx.run({ shop: rec }, () => api(req, res, rest));
    // Customer pages of the shop: invoice (with "I have paid"), receipt, photos and the online shop.
    const iv = rest.match(/^\/i\/([A-Za-z0-9._-]{4,40})$/);
    if (iv && ['GET', 'HEAD', 'POST'].includes(req.method)) return await ctx.run({ shop: rec }, () => store().invoicePage(req, res, iv[1]));
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow: 'GET, HEAD' }); return res.end(); }
    const bm = rest.match(/^\/b\/([A-Za-z0-9]{8,40})$/);
    if (bm) return await ctx.run({ shop: rec }, () => behPage(req, res, bm[1], rec));
    const rm = rest.match(/^\/r\/([A-Za-z0-9._-]{4,40})$/);
    if (rm) return await ctx.run({ shop: rec }, () => store().receiptPage(req, res, rm[1]));
    const im = rest.match(/^\/img\/([a-f0-9]{24})(?:\.(?:jpg|png|webp))?$/);
    if (im) return await ctx.run({ shop: rec }, () => photoServe(req, res, im[1]));
    if (rest === '/shop' || rest.startsWith('/shop/') || rest === '/store') {
      if (rec.status !== 'active') { res.writeHead(503, Object.assign({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }, HEADERS)); return res.end('<!DOCTYPE html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + rec.name.replace(/[<&]/g, '') + '</title><body style="font:16px system-ui;text-align:center;padding:60px 20px;color:#333"><h2>' + rec.name.replace(/[<&]/g, '') + '</h2><p>This online shop is closed right now. Please check again later.</p></body>'); }
      return ctx.run({ shop: rec }, () => store().page(req, res, '<script>window.STORE=' + jsonScript({ base: '/' + rec.slug, slug: rec.slug, name: rec.name }) + '</script>', rec.name + ' · Shop online'));
    }
    if (rest === '/manifest.webmanifest') {
      res.writeHead(200, { 'Content-Type': 'application/manifest+json', 'Cache-Control': 'public, max-age=86400' });
      return res.end(JSON.stringify({ name: rec.name, short_name: rec.name.slice(0, 12), start_url: '/' + slug, scope: '/' + slug, display: 'standalone', background_color: '#f6f5f1', theme_color: '#0f6e56',
        icons: [{ src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' }, { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' }] }));
    }
    return shopPage(req, res, rec);
  } catch (e) { console.error(e); if (!res.headersSent) send(res, 500, { error: 'Server error.' }); }
}).listen(PORT, () => console.log(PLATFORM + ' running on port ' + PORT));
