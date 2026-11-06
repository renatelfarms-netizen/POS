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
const DB_COLS = new Set(['shop', 'devices', 'products', 'customers', 'sales', 'expenses', 'deliveries', 'pos', 'moves', 'log', 'whMoves', 'transfers', 'trReq', 'whItems', 'whPos',
  'accra_products', 'accra_customers', 'accra_sales', 'accra_expenses', 'accra_deliveries', 'accra_pos', 'accra_moves']);

// ---- staff login: name + password are checked here against the shared shop's staff list ----
// A correct login returns a signed session token; devices use it for /api/db and backups.
const SESSION_DAYS = 30;
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
function findStaff(staff, v) {
  const q = nmz(v); if (!q) return null;
  const ex = staff.filter((x) => nmz(x.name) === q); if (ex.length) return ex.length === 1 ? ex[0] : null;
  const fn = staff.filter((x) => nmz(x.name).split(' ')[0] === q); return fn.length === 1 ? fn[0] : null;
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
  if (!s || !(await pwOK(pw, s.pin))) { failed(ip, 20); failed(nk, 6); return send(res, 401, { error: 'That name and password don’t match. Check how your name is spelled and try again.' }); }
  if (s.locked) return send(res, 423, { error: s.name + '’s account is locked after too many wrong tries. Ask the owner or a manager to unlock it.' });
  loginFails.delete(nk);
  const dev = cleanDev(msg.dev);
  return send(res, 200, { ok: true, token: makeToken(s.id, dev), sid: s.id, name: s.name, exp: Date.now() + SESSION_DAYS * 864e5 });
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

  // ---- shared shop database (every device that joined with the shop code sees the same data) ----
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

  if (req.method === 'POST' && url === '/api/backup') {
    let raw;
    try { raw = await readBody(req); } catch (e) { return send(res, e.code === 413 ? 413 : 400, { error: e.code === 413 ? 'Backup is too big.' : 'Could not read the backup.' }); }
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return send(res, 400, { error: 'Not valid data.' }); }
    const dev = cleanDev(msg.device), name = String(msg.name || '').slice(0, 80), d = msg.data;
    if (!dev || !d || typeof d !== 'object' || !Array.isArray(d.products) || !Array.isArray(d.sales)) {
      return send(res, 400, { error: 'That is not shop data.' });
    }
    const data = JSON.stringify(d), digest = sha(data), cnt = counts(d);
    const out = { at: new Date().toISOString() };
    try { out.hosting = await hostSave(dev, name, data, digest, cnt); } catch (e) { console.error('hosting backup', e); out.hosting = { error: 'Could not save on the hosting.' }; }
    if (sbOn()) {
      try { out.supabase = await sbSave(dev, name, data, digest, cnt); } catch (e) { console.error('supabase backup', e.message); out.supabase = { error: 'Could not save in Supabase.' }; }
    } else out.supabase = { error: 'Supabase is not connected on the server.' };
    out.ok = !out.hosting.error || !out.supabase.error;
    return send(res, out.ok ? 200 : 502, out);
  }

  if (req.method === 'GET' && url === '/api/backups') {
    const list = [];
    for (const x of await hostIndex()) list.push({ source: 'hosting', id: x.id, at: x.at, device: x.device, name: x.name, sha256: x.sha256, size: x.size, counts: x.counts });
    let supabaseError = null;
    if (sbOn()) {
      try {
        for (const x of (await sbCall('site_backup_list', {})) || []) {
          list.push({ source: 'supabase', id: String(x.id), at: new Date(x.created_at).toISOString(), device: x.device, name: x.device_name, sha256: x.sha256, size: x.size_bytes, counts: x.counts });
        }
      } catch (e) { console.error('supabase list', e.message); supabaseError = 'Could not reach Supabase.'; }
    }
    list.sort((a, b) => b.at.localeCompare(a.at));
    return send(res, 200, { ok: true, backups: list, supabaseError });
  }

  const m = url.match(/^\/api\/backup\/(hosting|supabase)\/([A-Za-z0-9_.-]+)$/);
  if (req.method === 'GET' && m) {
    try {
      let raw = null;
      if (m[1] === 'hosting') raw = await hostGet(m[2]);
      else if (sbOn() && /^\d+$/.test(m[2])) { const v = await sbCall('site_backup_get', { p_id: +m[2] }); raw = v ? JSON.stringify(v) : null; }
      if (!raw) return send(res, 404, { error: 'Backup not found.' });
      res.writeHead(200, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, HEADERS));
      return res.end('{"ok":true,"data":' + raw + '}');
    } catch (e) {
      console.error('get backup', e.message);
      return send(res, 502, { error: 'Could not load that backup.' });
    }
  }

  return send(res, 404, { error: 'Not found.' });
}

http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
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
