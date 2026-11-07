'use strict';
// Web server for renatel.shop.
// - Serves the shop page (index.html).
// - Shared shop database: devices that joined with the shop code read and write one
//   live copy of the shop in Supabase through /api/db.
// - Online backup: the shop sends its data here; the server keeps a copy on the
//   hosting (compressed files outside the website folder) and in Supabase.
// No dependencies. Secrets come from environment variables set in Hostinger:
//   BACKUP_CODE            the shop's backup code, typed once in Settings on each device
//   SUPABASE_URL           e.g. https://xxxx.supabase.co
//   SUPABASE_KEY           the project's publishable key (not secret)
//   SUPABASE_BACKUP_TOKEN  secret token; Supabase only accepts backups with it
//   BACKUP_DIR             optional, defaults to ~/renatel-backups
//   PHOTO_DIR              optional, defaults to ~/renatel-photos (cache of product photos)
//   PAYSTACK_SECRET_KEY    optional; turns on real online payments in the online shop (store.js)
const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const crypto = require('crypto');

const PAGE = path.join(__dirname, 'index.html');
const PORT = process.env.PORT || 3000;
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(os.homedir(), 'renatel-backups');
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
async function hostIndex() {
  try { return JSON.parse(await fsp.readFile(path.join(BACKUP_DIR, 'index.json'), 'utf8')); } catch (e) { return []; }
}
let hostQueue = Promise.resolve();
function hostSave(dev, name, raw, digest, cnt) {
  const job = hostQueue.then(() => hostSaveNow(dev, name, raw, digest, cnt));
  hostQueue = job.catch(() => {});
  return job;
}
async function hostSaveNow(dev, name, raw, digest, cnt) {
  await fsp.mkdir(BACKUP_DIR, { recursive: true, mode: 0o700 });
  const idx = await hostIndex();
  const lastForDev = idx.filter((x) => x.device === dev).sort((a, b) => b.at.localeCompare(a.at))[0];
  if (lastForDev && lastForDev.sha256 === digest) return { skipped: true };
  const at = new Date().toISOString();
  const file = at.replace(/[:.]/g, '-') + '__' + dev + '__' + digest.slice(0, 12) + '.json.gz';
  await fsp.writeFile(path.join(BACKUP_DIR, file), zlib.gzipSync(raw), { mode: 0o600 });
  idx.push({ id: file, at, device: dev, name, sha256: digest, size: Buffer.byteLength(raw), counts: cnt });
  // keep everything from the last 2 days, then the newest of each day for 90 days (per device)
  const now = Date.now(), keep = [], seenDay = new Set();
  for (const x of idx.sort((a, b) => b.at.localeCompare(a.at))) {
    const age = now - Date.parse(x.at), dayKey = x.device + x.at.slice(0, 10);
    const k = age < 2 * 864e5 || (age < 90 * 864e5 && !seenDay.has(dayKey));
    seenDay.add(dayKey);
    if (k) keep.push(x); else await fsp.rm(path.join(BACKUP_DIR, x.id), { force: true });
  }
  const tmp = path.join(BACKUP_DIR, 'index.json.tmp');
  await fsp.writeFile(tmp, JSON.stringify(keep), { mode: 0o600 });
  await fsp.rename(tmp, path.join(BACKUP_DIR, 'index.json'));
  return { saved: true, id: file };
}
async function hostGet(id) {
  if (!/^[A-Za-z0-9_-]+\.json\.gz$/.test(id)) return null;
  const idx = await hostIndex();
  if (!idx.some((x) => x.id === id)) return null;
  return zlib.gunzipSync(await fsp.readFile(path.join(BACKUP_DIR, id))).toString('utf8');
}

// ---- copies in Supabase (through locked-down database functions) ----
const sbOn = () => !!(process.env.SUPABASE_URL && process.env.SUPABASE_KEY && process.env.SUPABASE_BACKUP_TOKEN);
async function sbCall(fn, args, bodyRaw) {
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
let snapBusy = null;
function snapshot(label, force) { if (!snapBusy) snapBusy = snapshotNow(label, force).finally(() => { snapBusy = null; }); return snapBusy; }
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
  shopCache.at = 0;
  console.log('restore: ' + n + ' documents changed by ' + by);
  return n;
}
if (sbOn()) {
  setTimeout(() => snapshot('Automatic').catch((e) => console.error('auto backup', e.message)), 60000).unref();
  setInterval(() => snapshot('Automatic').catch((e) => console.error('auto backup', e.message)), SNAP_MIN * 60000).unref();
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
      const id = day + '_server_' + n, cur = await sbCall('shop_db_get', { p_col: 'log', p_id: id });
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
const secret = () => sha('renatel-session:' + (process.env.SUPABASE_BACKUP_TOKEN || ''));
const b64u = (s) => Buffer.from(s).toString('base64url');
const sign = (body) => crypto.createHmac('sha256', secret()).update(body).digest('base64url');
function makeToken(sid, dev) {
  const body = b64u(JSON.stringify({ sid, dev, iat: Date.now(), exp: Date.now() + SESSION_DAYS * 864e5 }));
  return body + '.' + sign(body);
}
function readToken(t) {
  const [body, mac] = String(t || '').split('.');
  if (!body || !mac) return null;
  const want = sign(body);
  if (mac.length !== want.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(want))) return null;
  try { const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); return p.exp > Date.now() ? p : null; } catch (e) { return null; }
}
let shopCache = { at: 0, doc: null };
async function shopMain(fresh) {
  if (!fresh && shopCache.doc && Date.now() - shopCache.at < 15000) return shopCache.doc;
  const doc = await sbCall('shop_db_get', { p_col: 'shop', p_id: 'main' });
  shopCache = { at: Date.now(), doc };
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

async function login(req, res) {
  if (!sbOn()) return send(res, 503, { error: 'The shop database is not set up on the server yet.' });
  const ip = 'ip:' + clientIp(req);
  let msg; try { msg = JSON.parse(await readBody(req)); } catch (e) { return send(res, 400, { error: 'Not valid data.' }); }
  const name = String(msg && msg.name || '').slice(0, 80), pw = String(msg && msg.password || '').slice(0, 200);
  if (!name || !pw) return send(res, 400, { error: 'Type your name and password.' });
  const nk = 'name:' + nmz(name);
  const wait = tooMany(ip) || tooMany(nk);
  if (wait) return send(res, 429, { error: 'Too many wrong tries. Wait ' + wait + ' minute' + (wait > 1 ? 's' : '') + ', then try again.' });
  let shop; try { shop = await shopMain(true); } catch (e) { console.error('login', e.message); return send(res, 502, { error: 'Could not reach the shop database. Try again in a moment.' }); }
  if (!shop) return send(res, 404, { error: 'The shop has not been set up yet.', setup: true });
  const s = findStaff(shop.staff || [], name);
  if (!s || !(await pwOK(pw, s.pin))) {
    console.log('login failed: ' + (s ? 'wrong password for ' + s.name : 'no staff member called "' + nmz(name) + '"'));
    serverLog('Failed login', s ? 'wrong password · on renatel.shop' : 'name not recognised: “' + name.slice(0, 40) + '” · on renatel.shop', s);
    failed(ip, 20); failed(nk, 6); return send(res, 401, { error: 'That name and password don’t match. Check how your name is spelled and try again.' }); }
  if (s.locked) { serverLog('Failed login', 'account is locked · on renatel.shop', s); return send(res, 423, { error: s.name + '’s account is locked after too many wrong tries. Ask the owner or a manager to unlock it.' }); }
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
  if (!code || !(await pwOK('rc:' + code, shop.set.rc))) { console.log('reset failed: wrong recovery code for ' + s.name); serverLog('Failed recovery code', 'on renatel.shop', s); failed(ip, 5); return send(res, 401, { error: 'That recovery code is not right.' }); }
  const rule = pwRule(pw, shop.set); if (rule) return send(res, 400, { error: rule });
  await setPin(shop, s.id, pw);
  console.log('password reset with the recovery code: ' + s.name); serverLog('Password reset', 'with the shop recovery code · on renatel.shop', s);
  return send(res, 200, { ok: true, token: makeToken(s.id, cleanDev(msg.dev)), sid: s.id, name: s.name, exp: Date.now() + SESSION_DAYS * 864e5 });
}
// ---- email from the shop's own mailbox (shop@renatel.shop) through the Hostinger Mail API ----
// The API key and mailbox id are kept privately in Supabase (site_secrets), read with the server token.
let mailCache = { at: 0, cfg: null };
async function mailCfg() {
  if (mailCache.cfg && Date.now() - mailCache.at < 300000) return mailCache.cfg;
  const get = (n) => sbCall('site_secret_get', { p_name: n });
  const [token, box, from] = await Promise.all([get('mail_api_token'), get('mail_mailbox_id'), get('mail_from')]);
  mailCache = { at: Date.now(), cfg: token && box ? { token, box, from: from || '' } : null };
  return mailCache.cfg;
}
const emailOK = (e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(e || ''));
const maskEmail = (e) => { const [u, d] = String(e).split('@'); return (u || '').slice(0, 2) + '•••@' + (d || ''); };
async function sendEmail({ to, subject, text, html, attachments }) {
  const cfg = await mailCfg();
  if (!cfg) throw new Error('The shop email is not set up.');
  let shopName = 'Renatel Shop'; try { const sh = await shopMain(false); if (sh && sh.set && sh.set.name) shopName = sh.set.name; } catch (e) {}
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
  await sbCall('shop_db_put', { p_col: 'shop', p_id: 'main', p_data: main }); shopCache.at = 0;
}
// Forgot password by email: a 6-digit code is emailed to the address saved on the staff record.
const resetCodes = new Map(); // staff id -> {h, exp, tries}
async function resetCode(req, res) {
  if (!sbOn()) return send(res, 503, { error: 'The shop database is not set up on the server yet.' });
  const ip = 'em:' + clientIp(req), wait = tooMany(ip);
  if (wait) return send(res, 429, { error: 'Too many tries. Wait ' + wait + ' minutes, then try again.' });
  let msg; try { msg = JSON.parse(await readBody(req)); } catch (e) { return send(res, 400, { error: 'Not valid data.' }); }
  let shop; try { shop = await shopMain(true); } catch (e) { return send(res, 502, { error: 'Could not reach the shop database. Try again in a moment.' }); }
  const s = shop && findStaff(shop.staff || [], String(msg.name || '').slice(0, 80));
  if (!s) { failed(ip, 10); return send(res, 400, { error: 'No staff member with that name. Type your name as the owner added it.' }); }
  if (!emailOK(s.email)) return send(res, 400, { error: 'No email is saved for ' + s.name + '. Use the recovery code, or ask the owner or a manager.' });
  if (s.locked && s.role !== 'owner') { /* still allowed: the reset unlocks the account */ }
  const prev = resetCodes.get(s.id);
  if (prev && prev.sent && Date.now() - prev.sent < 60000) return send(res, 429, { error: 'A code was sent less than a minute ago. Check your email (and spam).' });
  const code = String(100000 + crypto.randomInt(900000));
  resetCodes.set(s.id, { h: sha('rst:' + code), exp: Date.now() + 15 * 60000, tries: 0, sent: Date.now() });
  failed(ip, 10);
  try {
    await sendEmail({ to: [s.email], subject: (shop.set && shop.set.name || 'Renatel Shop') + ' - password reset code: ' + code,
      text: 'Hello ' + s.name + ',\n\nSomeone asked to reset your password for ' + (shop.set && shop.set.name || 'Renatel Shop') + '. Your reset code is:\n\n    ' + code + '\n\nIt expires in 15 minutes. If this wasn’t you, ignore this email and tell the shop owner.\n\n-- \nshop@renatel.shop' });
  } catch (e) { resetCodes.delete(s.id); return send(res, 502, { error: 'The code email could not be sent. Try again, or use the recovery code.' }); }
  serverLog('Reset code emailed', 'to ' + maskEmail(s.email) + ' from the shop email', s);
  return send(res, 200, { ok: true, to: maskEmail(s.email) });
}
async function resetByEmail(req, res) {
  let msg; try { msg = JSON.parse(await readBody(req)); } catch (e) { return send(res, 400, { error: 'Not valid data.' }); }
  let shop; try { shop = await shopMain(true); } catch (e) { return send(res, 502, { error: 'Could not reach the shop database. Try again in a moment.' }); }
  const s = shop && findStaff(shop.staff || [], String(msg.name || '').slice(0, 80));
  const rc = s && resetCodes.get(s.id);
  if (!s || !rc || rc.exp < Date.now()) return send(res, 400, { error: 'That code has expired or was never sent. Send a new code.' });
  if (rc.tries >= 5) { resetCodes.delete(s.id); return send(res, 429, { error: 'Too many wrong codes. Send a new code.' }); }
  if (sha('rst:' + String(msg.code || '').replace(/\D/g, '')) !== rc.h) { rc.tries++; serverLog('Failed reset code', (5 - rc.tries) + ' tries left · on renatel.shop', s); return send(res, 401, { error: 'That code is not right. ' + (5 - rc.tries) + ' tries left.' }); }
  const pw = String(msg.password || '').slice(0, 200), rule = pwRule(pw, shop.set);
  if (rule) return send(res, 400, { error: rule });
  await setPin(shop, s.id, pw); resetCodes.delete(s.id);
  console.log('password reset by email code: ' + s.name); serverLog('Password reset', 'with a code emailed to ' + maskEmail(s.email) + ' · on renatel.shop', s);
  return send(res, 200, { ok: true, token: makeToken(s.id, cleanDev(msg.dev)), sid: s.id, name: s.name, exp: Date.now() + SESSION_DAYS * 864e5 });
}
// Who is calling: a logged-in staff member (session token) or a device with the shop code.
async function caller(req) {
  const h = String(req.headers.authorization || '');
  if (h.startsWith('Bearer ')) {
    const t = readToken(h.slice(7));
    if (!t || !sbOn()) return { err: [401, 'Please log in again.'] };
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
    if (!mailAllowed(who.staff ? 's' + who.staff.id : 'code')) return send(res, 429, { error: 'Too many emails this hour. Try again later.' });
    const atts = (Array.isArray(msg.attachments) ? msg.attachments : []).slice(0, 5);
    try { await sendEmail({ to, subject: msg.subject, text: String(msg.body || msg.text || '').slice(0, 50000), html: msg.html ? String(msg.html).slice(0, 500000) : undefined, attachments: atts }); return send(res, 200, { ok: true }); }
    catch (e) { return send(res, 502, { error: e.message }); }
  }
  if (req.method === 'GET' && url === '/api/mail/status') {
    try { const c = await mailCfg(); return send(res, 200, { ok: !!c, from: c ? c.from : '' }); } catch (e) { return send(res, 200, { ok: false }); }
  }
  // ---- product photos: the page shrinks the picture first; it is kept in Supabase and cached on the hosting ----
  if (req.method === 'POST' && url === '/api/photo') {
    if (!sbOn()) return send(res, 503, { error: 'Photos are not set up on the server yet.' });
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
        if (col === 'shop') shopCache.at = 0; // staff, password or sign-out changes take effect at once
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

// ---- product photos served at /img/<key> (cached on the hosting, outside the website folder) ----
const PHOTO_DIR = process.env.PHOTO_DIR || path.join(os.homedir(), 'renatel-photos');
const PHOTO_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
function photoCacheSave(key, mime, buf) {
  fsp.mkdir(PHOTO_DIR, { recursive: true }).then(() => fsp.writeFile(path.join(PHOTO_DIR, key + '.' + PHOTO_EXT[mime]), buf)).catch((e) => console.error('photo cache', e.message));
}
async function photoServe(req, res, key) {
  const done = (mime, buf) => { res.writeHead(200, Object.assign({ 'Content-Type': mime, 'Cache-Control': 'public, max-age=31536000, immutable' }, HEADERS)); res.end(req.method === 'HEAD' ? undefined : buf); };
  for (const [mime, ext] of Object.entries(PHOTO_EXT)) {
    try { return done(mime, await fsp.readFile(path.join(PHOTO_DIR, key + '.' + ext))); } catch (e) {}
  }
  try {
    const v = sbOn() ? await sbCall('shop_photo_get', { p_key: key }) : null;
    if (!v || !PHOTO_EXT[v.mime]) { res.writeHead(404); return res.end(); }
    const buf = Buffer.from(v.data, 'base64'); photoCacheSave(key, v.mime, buf); return done(v.mime, buf);
  } catch (e) { console.error('photo get', e.message); res.writeHead(502); return res.end(); }
}

// ---- online shop (renatel.shop/store): see store.js ----
const shopStore = require('./store')({ sbCall, sbOn, send, readBody, serverLog, shopMain, clientIp, sendEmail, HEADERS, caller });

http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (url.startsWith('/api/store/')) {
    shopStore.api(req, res, url).catch((e) => { console.error(e); send(res, 500, { error: 'Server error.' }); });
    return;
  }
  if ((url === '/store' || url.startsWith('/store/')) && (req.method === 'GET' || req.method === 'HEAD')) return shopStore.page(req, res);
  const im = url.match(/^\/img\/([a-f0-9]{24})(?:\.(?:jpg|png|webp))?$/);
  if (im && (req.method === 'GET' || req.method === 'HEAD')) { photoServe(req, res, im[1]).catch(() => { res.writeHead(500); res.end(); }); return; }
  if (url.startsWith('/api/')) {
    api(req, res, url).catch((e) => { console.error(e); send(res, 500, { error: 'Server error.' }); });
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' });
    return res.end();
  }
  if (url === '/robots.txt') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('User-agent: *\nDisallow: /\n');
  }
  // App icon and "Add to Home screen" details
  const ICONS = { '/icon-192.png': 'icon-192.png', '/icon-512.png': 'icon-512.png', '/apple-touch-icon.png': 'apple-touch-icon.png', '/apple-touch-icon-precomposed.png': 'apple-touch-icon.png', '/favicon.ico': 'icon-192.png' };
  if (ICONS[url]) {
    fs.readFile(path.join(__dirname, 'icons', ICONS[url]), (e, buf) => {
      if (e) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=604800' });
      res.end(buf);
    });
    return;
  }
  if (url === '/manifest.webmanifest') {
    res.writeHead(200, { 'Content-Type': 'application/manifest+json', 'Cache-Control': 'public, max-age=86400' });
    return res.end(JSON.stringify({
      name: 'Renatel Shop', short_name: 'Renatel Shop', start_url: '/', scope: '/', display: 'standalone',
      background_color: '#f6f5f1', theme_color: '#0f6e56',
      icons: [
        { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
        { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' }
      ]
    }));
  }
  // Every other address shows the shop page (it is a single-page app).
  try {
    const body = page();
    res.writeHead(200, Object.assign({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' }, HEADERS));
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch (e) {
    console.error(e);
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('The shop page is missing.');
  }
}).listen(PORT, () => console.log('Renatel Shop running on port ' + PORT + (process.env.BACKUP_CODE ? ', online backup on' : ', online backup not set up')));
