'use strict';
// Multi-shop web server: many shops, each with its own link (site/<shop-link>), data, staff,
// logins and backups. Free to use. Tessa POS, built from the Renatel Shop app.
// - /                 the platform page: sign up a new shop, find your shop
// - /admin            platform admin (you): every shop, pause / open, notes
// - /<link>           a shop's app; its API is /<link>/api/...
// No dependencies. Secrets come from environment variables:
//   SUPABASE_URL, SUPABASE_KEY, SUPABASE_BACKUP_TOKEN   the database (multi-shop functions, see schema.sql)
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
const SITE = process.env.PLATFORM_HOST || 'the website';

const PAGE = path.join(__dirname, 'index.html'), LANDING = path.join(__dirname, 'landing.html'), ADMIN = path.join(__dirname, 'admin.html'), LOGIN = path.join(__dirname, 'login.html'), REGISTER = path.join(__dirname, 'register.html'), CSS = path.join(__dirname, 'site.css');
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
    headers: { apikey: process.env.SUPABASE_KEY, 'Content-Type': 'application/json' },
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
const DB_COLS = new Set(['shop', 'devices', 'mailed', 'products', 'customers', 'sales', 'expenses', 'deliveries', 'pos', 'moves', 'log', 'whMoves', 'transfers', 'trReq', 'whItems', 'whPos',
  'accra_products', 'accra_customers', 'accra_sales', 'accra_expenses', 'accra_deliveries', 'accra_pos', 'accra_moves']);

// ---- online backups of the shared shop, made by the server ----
// Every SNAP_MIN minutes, if anything changed, the whole shop is saved on the hosting and in Supabase.
const SNAP_DEV = 'shop', SNAP_FORMAT = 'renatel-shop-docs-1', SNAP_MIN = 10;
async function allDocs() {
  const docs = {}; let since = 0, more = true;
  while (more) {
    const j = await sbCall('shop_db_pull', { p_since: since });
    for (const d of j.docs || []) { const k = d.c + '/' + d.id; if (d.x) delete docs[k]; else docs[k] = d.d; }
    since = j.rev; more = !!j.more;
  }
  return Object.keys(docs).sort().reduce((o, k) => (o[k] = docs[k], o), {});
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
const snapBusy = new Map();
function snapshot(label, force) { const k = SID(); if (!snapBusy.has(k)) snapBusy.set(k, snapshotNow(label, force).finally(() => snapBusy.delete(k))); return snapBusy.get(k); }
async function snapshotNow(label, force) {
  const docs = await allDocs();
  if (!docs['shop/main']) return { skipped: true, reason: 'empty' };
  const digest = sha(JSON.stringify(docs));
  const raw = JSON.stringify({ format: SNAP_FORMAT, at: new Date().toISOString(), docs }), cnt = docCounts(docs);
  const out = {};
  // The same backup is never saved twice in a row (hostSave and site_backup_save skip an unchanged copy).
  try { out.hosting = await hostSave(SNAP_DEV, label, raw, digest, cnt); } catch (e) { console.error('hosting backup', e.message); out.hosting = { error: 'Could not save on the hosting.' }; }
  try { out.supabase = await sbSave(SNAP_DEV, label, raw, digest, cnt); } catch (e) { console.error('supabase backup', e.message); out.supabase = { error: 'Could not save in Supabase.' }; }
  if (force && out.hosting.skipped && out.supabase.skipped) out.same = true;
  return out;
}
async function restoreDocs(docs, by) {
  const cur = await allDocs(); let n = 0;
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
const shopCache = new Map(); // shop id -> {at, doc}
const scClear = () => shopCache.delete(SID());
async function shopMain(fresh) {
  const c = shopCache.get(SID());
  if (!fresh && c && c.doc && Date.now() - c.at < 15000) return c.doc;
  const doc = await sbCall('shop_db_get', { p_col: 'shop', p_id: 'main' });
  shopCache.set(SID(), { at: Date.now(), doc });
  return doc;
}
// Same name matching and password checks as the shop page (index.html: nmz, findStaff, pwOK).
const nmz = (v) => String(v || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
// A name matches if it is the full name, the same words in any order ("Emmanuel Buckson"),
// or one word of exactly one person's name ("Emmanuel").
function findStaff(staff, v) {
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
  if (!name || !pw) return send(res, 400, { error: 'Type your name and password.' });
  const nk = SID() + ':name:' + nmz(name);
  const wait = tooMany(ip) || tooMany(nk);
  if (wait) return send(res, 429, { error: 'Too many wrong tries. Wait ' + wait + ' minute' + (wait > 1 ? 's' : '') + ', then try again.' });
  let shop; try { shop = await shopMain(true); } catch (e) { console.error('login', e.message); return send(res, 502, { error: 'Could not reach the shop database. Try again in a moment.' }); }
  if (!shop) return send(res, 404, { error: 'The shop has not been set up yet.', setup: true });
  const s = findStaff(shop.staff || [], name);
  if (!s || !(await pwOK(pw, s.pin))) {
    console.log('login failed: ' + (s ? 'wrong password for ' + s.name : 'no staff member called "' + nmz(name) + '"'));
    serverLog('Failed login', s ? 'wrong password · on ' + SITE : 'name not recognised: “' + name.slice(0, 40) + '” · on ' + SITE, s);
    failed(ip, 20); failed(nk, 6); return send(res, 401, { error: 'That name and password don’t match. Check how your name is spelled and try again.' }); }
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
  const ip = 'rc:' + clientIp(req), wait = tooMany(ip);
  if (wait) return send(res, 429, { error: 'Too many wrong codes. Wait ' + wait + ' minutes, then try again.' });
  let msg; try { msg = JSON.parse(await readBody(req)); } catch (e) { return send(res, 400, { error: 'Not valid data.' }); }
  const name = String(msg.name || '').slice(0, 80), code = rcNorm(msg.code), pw = String(msg.password || '').slice(0, 200);
  let shop; try { shop = await shopMain(true); } catch (e) { return send(res, 502, { error: 'Could not reach the shop database. Try again in a moment.' }); }
  if (!shop) return send(res, 404, { error: 'The shop has not been set up yet.' });
  const s = findStaff(shop.staff || [], name);
  if (!s) return send(res, 400, { error: 'No staff member with that name. Type the name exactly as the owner added it.' });
  if (!shop.set || !shop.set.rc) return send(res, 400, { error: 'This shop has no recovery code yet. Ask the owner.' });
  if (!code || !(await pwOK('rc:' + code, shop.set.rc))) { console.log('reset failed: wrong recovery code for ' + s.name); serverLog('Failed recovery code', 'on ' + SITE, s); failed(ip, 5); return send(res, 401, { error: 'That recovery code is not right.' }); }
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
  t.pin = await mkHash(pw); t.fails = 0; t.nextTry = 0; t.locked = false; t.mustChange = false; delete t.rst;
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
  if (!s) { failed(ip, 10); return send(res, 400, { error: 'No staff member with that name. Type your name as the owner added it.' }); }
  const st = store(), nm = (shop.set && shop.set.name) || PLATFORM, ph = st.normPhone(s.phone), smsOk = !!ph && await st.smsReady().catch(() => false);
  const via = msg.via === 'email' ? 'email' : msg.via === 'sms' ? 'sms' : (smsOk ? 'sms' : 'email');
  if (via === 'sms' && !smsOk) return send(res, 400, { error: ph ? 'SMS codes are not set up for this shop yet. Choose “Email me a code” or the recovery code.' : 'No phone number is saved for ' + s.name + '. Choose “Email me a code”, or ask the owner.' });
  if (via === 'email' && !emailOK(s.email)) return send(res, 400, { error: 'No email is saved for ' + s.name + '.' + (smsOk ? ' Choose “Text me a code” instead.' : ' Use the recovery code, or ask the owner or a manager.') });
  let code; try { code = await st.otpIssue('staff:' + s.id); } catch (e) { return send(res, e.code || 502, { error: e.message }); }
  failed(ip, 10);
  try {
    if (via === 'sms') await st.sendSms(ph, st.otpSms(nm, code));
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
    return { staff: s };
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
  // ---- product photos: the page shrinks the picture first; it is kept in Supabase and cached on the hosting ----
  if (req.method === 'POST' && url === '/api/photo') {
    const who = await caller(req); if (who.err) return send(res, who.err[0], { error: who.err[1] });
    let msg; try { msg = JSON.parse(await readBody(req)); } catch (e) { return send(res, 400, { error: 'Not valid data.' }); }
    const m = String(msg && msg.data || '').match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
    if (!m) return send(res, 400, { error: 'That file is not a photo (use JPG, PNG or WebP).' });
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > 1024 * 1024) return send(res, 413, { error: 'The photo is too big. Try a smaller one.' });
    const key = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 24);
    try { await sbCall('shop_photo_put', { p_key: key, p_mime: m[1], p_data: m[2] }); } catch (e) { console.error('photo put', e.message); return send(res, 502, { error: 'Could not save the photo. Try again.' }); }
    photoCacheSave(key, m[1], buf);
    return send(res, 200, { ok: true, key });
  }
  if (req.method === 'POST' && url === '/api/login') return login(req, res);
  if (req.method === 'POST' && url === '/api/reset') return resetPw(req, res);
  if (req.method === 'POST' && url === '/api/reset/code') return resetCode(req, res);
  if (req.method === 'POST' && url === '/api/reset/email') return resetByEmail(req, res);
  const who = await caller(req);
  if (who.err) return send(res, who.err[0], { error: who.err[1] });
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
        return send(res, 200, await sbCall('shop_db_pull', { p_since: since }));
      }
      if (req.method === 'POST' && (url === '/api/db/put' || url === '/api/db/del')) {
        let msg;
        try { msg = JSON.parse(await readBody(req)); } catch (e) { return send(res, e.code === 413 ? 413 : 400, { error: e.code === 413 ? 'That is too big to save.' : 'Not valid data.' }); }
        const col = String(msg && msg.c || ''), id = String(msg && msg.id || '');
        if (!DB_COLS.has(col) || !/^[A-Za-z0-9_.-]{1,120}$/.test(id)) return send(res, 400, { error: 'Unknown document.' });
        if (url === '/api/db/put' && (!msg.d || typeof msg.d !== 'object' || Array.isArray(msg.d))) return send(res, 400, { error: 'Not valid data.' });
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
const pubShop = (r) => ({ id: r.id, slug: r.slug, name: r.name, owner: r.owner_name, email: r.email, phone: r.phone, status: r.status, plan: planState(r), created: r.created_at, note: r.note || '' });
const signups = new Map();
function signupAllowed(ip) { const m = signups.get(ip) || { n: 0, since: Date.now() }; if (Date.now() - m.since > 3600e3) { m.n = 0; m.since = Date.now(); } m.n++; signups.set(ip, m); return m.n <= 5; }

async function signup(req, res) {
  if (!sbOn()) return send(res, 503, { error: 'The database is not set up on the server yet.' });
  let m; try { m = JSON.parse(await readBody(req)); } catch (e) { return send(res, 400, { error: 'Not valid data.' }); }
  const t = (v, n) => String(v || '').trim().slice(0, n);
  const name = t(m.shopName, 60), slug = t(m.slug, 40).toLowerCase(), owner = t(m.ownerName, 60), email = t(m.email, 120).toLowerCase(), phone = t(m.phone, 30), pw = String(m.password || '').slice(0, 200);
  const nb = m.branches === 2 ? 2 : 1, br1 = t(m.br1, 40) || 'Main branch', br2 = t(m.br2, 40) || 'Second branch', cur = t(m.cur, 6) || 'GH₵';
  if (name.length < 2) return send(res, 400, { error: 'Type the name of your shop.', f: 'shopName' });
  if (!slugOK(slug)) return send(res, 400, { error: 'The shop link can use small letters, numbers and dashes (3 to 40), e.g. kofi-mart.', f: 'slug' });
  if (owner.length < 2) return send(res, 400, { error: 'Type your full name.', f: 'ownerName' });
  if (!emailOK(email)) return send(res, 400, { error: 'Type a valid email address. Password reset codes are sent there.', f: 'email' });
  const rule = pwRule(pw, {}); if (rule) return send(res, 400, { error: rule, f: 'password' });
  if (!signupAllowed(clientIp(req))) return send(res, 429, { error: 'Too many new shops from this connection. Try again in an hour.' });
  let rec;
  try { rec = await sbCall('mt_shop_create', { p_slug: slug, p_name: name, p_owner: owner, p_email: email, p_phone: phone, p_trial_days: 365 }); }
  catch (e) { console.error('signup', e.message); return send(res, 502, { error: 'Could not create the shop. Try again in a moment.' }); }
  if (!rec || rec.error === 'taken') return send(res, 409, { error: 'That shop link is already used. Try another, e.g. ' + slug + '-' + (2 + crypto.randomInt(98)) + '.', f: 'slug' });
  slugCache.delete(slug); listCache.at = 0;
  return ctx.run({ shop: rec }, async () => {
    const ownerRec = { id: 1, name: owner, role: 'owner', branch: 'both', pin: await mkHash(pw), email, emailOK: true, phone, mustChange: false, setupDone: true };
    const main = { set: { name, phone, email, addr: '', cur, branches: nb, brNames: { kum: br1, acc: br2 }, created: Date.now() }, staff: [ownerRec], suppliers: [], seq: 10 };
    try { await sbCall('shop_db_put', { p_col: 'shop', p_id: 'main', p_data: main }); }
    catch (e) { console.error('signup main', e.message); return send(res, 502, { error: 'The shop was created but could not be opened. Try logging in at /' + slug + '.' }); }
    serverLog('Shop created', name + ' · on ' + PLATFORM, ownerRec);
    console.log('new shop: ' + slug);
    sendEmail({ to: [email], subject: 'Welcome to ' + PLATFORM + ' - your shop ' + name + ' is ready',
      text: 'Hello ' + owner + ',\n\nYour shop "' + name + '" is ready.\n\nYour shop link: ' + (process.env.PLATFORM_HOST ? 'https://' + process.env.PLATFORM_HOST : '') + '/' + slug + '\nLog in with your name (' + owner + ') and the password you chose.\n\n'+PLATFORM+' is free to use.\nAdd your staff in Staff, and your products in Stock.\n\n-- \n' + PLATFORM }).catch((e) => console.error('welcome mail', e.message));
    return send(res, 200, { ok: true, slug, token: makeToken(1, cleanDev(m.dev)), sid: 1, name: owner, exp: Date.now() + SESSION_DAYS * 864e5 });
  });
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
    const docs = await allDocs(), main = docs['shop/main'] || {}, set = main.set || {}, two = set.branches !== 1;
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
    const products = pf.flatMap((p) => list(p + 'products').map((x) => ({ b: BRN[p], name: x.name, cat: x.cat || '', price: x.price, stock: x.stock }))).sort((a, b) => a.name.localeCompare(b.name)).slice(0, 300);
    const sales = pf.flatMap((p) => recs(p + 'sales').map((x) => ({ b: BRN[p], id: x.id, ts: x.ts, total: x.total, method: x.method, by: x.byName || '', items: (x.items || []).reduce((t, i) => t + (i.qty || 0), 0) }))).sort((a, b) => b.ts - a.ts).slice(0, 50);
    const log = recs('log').sort((a, b) => b.ts - a.ts).slice(0, 60).map((x) => ({ ts: x.ts, who: x.who, a: x.a, d: x.d }));
    const staff = (main.staff || []).map((x) => ({ name: x.name, role: x.role, branch: x.role === 'owner' || x.branch === 'both' ? 'All branches' : BRN[x.branch === 'acc' ? 'accra_' : ''], email: x.email || '', phone: x.phone || '', locked: !!x.locked }));
    return { shop: pubShop(rec), cur: set.cur || 'GH₵', details: { name: set.name, phone: set.phone || '', addr: set.addr || '', email: set.email || '' }, branches, staff, products, sales, log, warehouse: list('whItems').length };
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
    const k = 'adm:' + clientIp(req), w = tooMany(k); if (w) return send(res, 429, { error: 'Too many wrong tries. Wait ' + w + ' minutes.' });
    let m; try { m = JSON.parse(await readBody(req)); } catch (e) { return send(res, 400, { error: 'Not valid data.' }); }
    if (!(await adminHash(true)) && !process.env.PLATFORM_ADMIN_PASSWORD) return send(res, 503, { error: 'Set PLATFORM_ADMIN_PASSWORD on the server first.' });
    if (!(await adminPwOK(String(m.password || '').slice(0, 200)))) { failed(k, 6); return send(res, 401, { error: 'Wrong admin password.' }); }
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
    // Shared SMS account: on/off for all shops, and per shop.
    if (url === '/api/platform/admin/sms') {
      let v = await sharedCfg(true); if (!v) return send(res, 502, { error: 'Could not read the SMS settings.' });
      if (req.method === 'POST') {
        let m; try { m = JSON.parse(await readBody(req)); } catch (e) { return send(res, 400, { error: 'Not valid data.' }); }
        const cfg = { on: !!v.on, off: Array.isArray(v.off) ? v.off.filter((x) => typeof x === 'string') : [] };
        if (typeof m.on === 'boolean') cfg.on = m.on;
        if (m.id && typeof m.shopOn === 'boolean') { cfg.off = cfg.off.filter((x) => x !== m.id); if (!m.shopOn) cfg.off.push(String(m.id).slice(0, 40)); }
        try { await sbCall('mt_kv_set', { p_k: 'shared_sms', p_v: JSON.stringify(cfg) }); } catch (e) { console.error('shared sms save', e.message); return send(res, 502, { error: 'Could not save.' }); }
        console.log('shared sms: ' + (cfg.on ? 'on' : 'off') + ', off for ' + cfg.off.length + ' shop(s)');
        v = await sharedCfg(true); for (const st of stores.values()) st.smsReset && st.smsReset();
      }
      let balance = null;
      if (v.token) { try { const r = await fetch((process.env.USMS_API || 'https://webapp.usmsgh.com/api') + '/balance', { headers: { Authorization: 'Bearer ' + v.token, Accept: 'application/json' }, signal: AbortSignal.timeout(10000) }); const j = await r.json(); balance = j.data && (j.data.remaining_balance ?? j.data.balance ?? null); } catch (e) {} }
      return send(res, 200, { ok: true, on: !!v.on, off: v.off || [], sender: v.sender || '', ready: !!v.ready, balance });
    }
    if (req.method === 'GET' && url === '/api/platform/admin/view') {
      const r = ((await sbCall('mt_shop_list', {})) || []).find((x) => x.id === q.get('id')); if (!r) return send(res, 404, { error: 'Shop not found.' });
      try { return send(res, 200, Object.assign({ ok: true }, await shopView(r))); } catch (e) { console.error('view', e.message); return send(res, 502, { error: 'Could not load the shop.' }); }
    }
    if (req.method === 'GET' && url === '/api/platform/admin/shops') {
      try { const L = (await sbCall('mt_shop_list', {})) || []; return send(res, 200, { ok: true, shops: L.map(pubShop) }); }
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
// ---- product photos at /<shop>/img/<key> (cached on the hosting per shop, outside the website folder) ----
const PHOTO_DIR = process.env.PHOTO_DIR || path.join(os.homedir(), 'tessa-photos');
const PHOTO_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const pdir = () => path.join(PHOTO_DIR, SID().replace(/[^A-Za-z0-9-]/g, ''));
function photoCacheSave(key, mime, buf) {
  const dir = pdir(); fsp.mkdir(dir, { recursive: true }).then(() => fsp.writeFile(path.join(dir, key + '.' + PHOTO_EXT[mime]), buf)).catch((e) => console.error('photo cache', e.message));
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
async function sharedSms() { const v = await sharedCfg(false); return v && v.on && v.token && !(v.off || []).includes(SID()) ? { token: v.token, sender: v.sender } : null; }
const hostName = () => String(process.env.PLATFORM_HOST || 'lavenderblush-gull-669222.hostingersite.com').replace(/^https?:\/\//, '').replace(/\/.*$/, '');
function store() {
  const id = SID(); if (id === '-') throw new Error('No shop');
  if (!stores.has(id)) stores.set(id, makeStore({ sbCall, sbOn, send, readBody, serverLog, shopMain, clientIp, sendEmail, HEADERS, caller,
    multi: true, noTimers: true, sharedSms, host: hostName(), base: () => '/' + T().shop.slug, scope: () => 'shop:' + SID() + ':', siteUrl: () => 'https://' + hostName() }));
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
if (sbOn()) { setTimeout(remindAll, 30000).unref(); setInterval(remindAll, +process.env.REMIND_EVERY_MS || 600000).unref(); }

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
    if (url === '/robots.txt') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('User-agent: *\nAllow: /$\nDisallow: /\n'); }
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
