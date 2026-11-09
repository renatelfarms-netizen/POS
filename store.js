'use strict';
// Online shop at renatel.shop (also /store).
// Customers pick products, pay online, and the server records the sale in the POS exactly like a till sale:
//   - stock is deducted from the product (same `stock` field the tills use)
//   - a sale record is added (seller: "Online shop", method: "Online")
//   - a stock move is logged ("Online order #…") and an activity-trail entry is written
//   - a delivery job is created when the customer chose delivery
// Every product with a price is listed, unless the owner ticked "Hide from the online shop" (product.hideOnline).
// Each customer is served by the branch nearest to them (Kumasi or Accra), chosen in the page from their region
// or their phone's location; that branch's products and stock are shown, and the sale is recorded there.
//
// Customer accounts: browsing is open, but placing an order needs an account (phone number + password).
//   Accounts live in Supabase (web_accounts, token-checked functions), never in the data the tills sync.
//   Each account is also added to the POS Customers list of the customer's branch, and online sales are linked to it.
//
// SMS receipts (USMS-GH, webapp.usmsgh.com): after every purchase the customer gets a thank-you SMS with a link to
//   their receipt at /r/<code> (code = branch + sale number + a signature, so receipts can't be guessed).
//   Online: sent when the payment is recorded. POS: the till asks the server after a sale with the buyer's phone.
//   The owner saves the USMS token and approved sender ID in the POS (kept in Supabase site_secrets).
//
// Payments
//   Paystack secret key set   -> Paystack checkout (MoMo and cards). A sk_test_ key uses Paystack test mode.
//     The owner pastes it in the POS (Online shop → Settings → Payments); it is checked with Paystack and kept in
//     Supabase site_secrets ('paystack_secret'). PAYSTACK_SECRET_KEY on the hosting, if set, takes priority.
//   no key                    -> built-in TEST payment screen: no money moves, but stock and sales are real.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

module.exports = function store(d) {
  const { sbCall, sbOn, send, readBody, serverLog, shopMain, clientIp, sendEmail, HEADERS, caller } = d;
  // Multi-shop platform (Tessa): d.multi is set, d.base() is the shop's path ('/<shop-link>'), d.scope() keeps
  // each shop's signed links and customer logins apart, and the platform runs the reminder job (d.noTimers).
  const MULTI = !!d.multi, BASE = () => (d.base ? d.base() : ''), SCOPE = () => (d.scope ? d.scope() : '');
  const SHOPURL = () => BASE() + (MULTI ? '/shop' : '/');
  const ENVKEY = MULTI ? '' : (process.env.PAYSTACK_SECRET_KEY || '');
  const DEFHOST = d.host || 'renatel.shop';
  // Shop settings kept in the POS (Settings saved in shop/main: set.store).
  const storeSet = (shop) => Object.assign({ open: true, msg: '', pickup: true, delivery: true, dnote: '' }, (shop && shop.set && shop.set.store) || {});
  // Staff permissions for the online shop: the owner has all; others as granted in Staff → Access (perms.web).
  const WEBP = ['orders', 'products', 'customers', 'settings'];
  const webCan = (st, k) => !!st && !st.locked && (st.role === 'owner' || !!(st.perms && st.perms.web && st.perms.web[k]));
  const BR = MULTI ? { kum: { pf: '', name: 'Main branch', city: '' }, acc: { pf: 'accra_', name: 'Second branch', city: '' } } : { kum: { pf: '', name: 'Kumasi branch', city: 'Kumasi' }, acc: { pf: 'accra_', name: 'Accra branch', city: 'Accra' } };
  let ONE = false; // multi-shop: the shop uses one branch only (Settings → Branches)
  const brKeys = () => (ONE ? ['kum'] : Object.keys(BR));
  const brOf = (b) => (BR[b] && brKeys().includes(b) ? b : 'kum');
  // The Paystack key: from the hosting environment, or the one the owner saved in the POS (re-read every minute).
  const PK = { key: '', src: '', at: 0, pct: 0 };
  async function loadKey() {
    if (ENVKEY) { PK.key = ENVKEY; PK.src = 'hosting'; return; }
    if (!sbOn()) return;
    try {
      const v = await sbCall('site_secret_get', { p_name: 'paystack_secret' }); PK.key = v || ''; PK.src = v ? 'pos' : ''; PK.pct = 0;
      // Multi-shop: a shop with no Paystack key of its own may take payments through the platform's account
      // (switched on by the platform admin); the platform pays the shop out later, minus its commission.
      if (!PK.key && d.sharedPay) { const sp = await d.sharedPay(); if (sp && sp.key) { PK.key = sp.key; PK.src = 'platform'; PK.pct = sp.pct; } }
      PK.at = Date.now();
    }
    catch (e) { console.error('paystack key', e.message); }
  }
  loadKey(); if (!d.noTimers) setInterval(loadKey, 60000).unref();
  // Before anything that depends on the payment mode, re-read the key if it is more than a few seconds old,
  // so every process switches to (or away from) Paystack together.
  const freshKey = async () => { if (!ENVKEY && Date.now() - PK.at > 3000) await loadKey(); };
  const KEY = () => PK.key;
  async function keyFor(o) {
    if (o && o.plat && PK.src !== 'platform' && d.sharedPay) { const sp = await d.sharedPay(true); if (sp && sp.key) return sp.key; }
    return KEY();
  }
  const PS_API = process.env.PAYSTACK_API || 'https://api.paystack.co';
  const mode = () => (KEY() ? (KEY().startsWith('sk_test_') ? 'paystack-test' : 'paystack') : 'test');
  const WHO = { id: null, name: 'Online shop' };
  const r2 = (n) => Math.round(n * 100) / 100;
  const accraDay = (t) => new Date(t).toLocaleDateString('en-CA', { timeZone: 'Africa/Accra' });
  const PAGE = path.join(__dirname, 'store.html');
  const CLM = 'creditClaims'; // "I have paid" claims from customers (the tills ignore this collection)
  let pageCache = null;

  // ---- products ----
  // Product documents of both branches, kept up to date with the same change feed the tills use.
  const prodDocs = { kum: {}, acc: {} }, custDocs = { kum: {}, acc: {} }, orderDocs = {}, saleDocs = { kum: {}, acc: {} }, claimDocs = {}; let prodRev = 0, prodAt = 0, prodBusy = null;
  async function refreshProducts() {
    let more = true;
    while (more) {
      const j = await sbCall('shop_db_pull', { p_since: prodRev });
      for (const x of j.docs || []) {
        if (x.c === CLM) { if (x.x) delete claimDocs[x.id]; else claimDocs[x.id] = x.d; continue; }
        if (x.c === 'webOrders') { if (x.x) delete orderDocs[x.id]; else orderDocs[x.id] = x.d; continue; }
        if (x.c === 'sales' || x.c === 'accra_sales') { const sb = x.c === 'sales' ? 'kum' : 'acc'; if (x.x) delete saleDocs[sb][x.id]; else saleDocs[sb][x.id] = (x.d && x.d.recs) || []; continue; }
        const b = x.c === 'products' || x.c === 'customers' ? 'kum' : x.c === 'accra_products' || x.c === 'accra_customers' ? 'acc' : null;
        const box = b && (x.c.endsWith('products') ? prodDocs : custDocs)[b];
        if (box) { if (x.x) delete box[x.id]; else box[x.id] = x.d; }
      }
      prodRev = j.rev; more = !!j.more;
    }
    prodAt = Date.now();
  }
  const forSale = (p) => p && !p.hideOnline && p.price > 0 && !p.rx;
  // pharmacy shops: stock past its expiry date (per batch) is never sold online
  const avail = (p) => { const t = new Date().toISOString().slice(0, 10), x = (Array.isArray(p.lots) ? p.lots : []).filter((l) => l && l.exp && l.exp < t).reduce((a, l) => a + (+l.q || 0), 0); return Math.max(0, (p.stock || 0) - x); };
  async function listed(b, fresh) {
    if (fresh || Date.now() - prodAt > 5000) { if (!prodBusy) prodBusy = refreshProducts().finally(() => { prodBusy = null; }); await prodBusy; }
    return Object.values(prodDocs[brOf(b)]).filter(forSale);
  }
  const getProd = (b, id) => sbCall('shop_db_get', { p_col: BR[brOf(b)].pf + 'products', p_id: 'p' + id });

  // ---- customer accounts ----
  const normPhone = (v) => { let d = String(v || '').replace(/\D/g, ''); if (d.startsWith('233') && d.length === 12) d = '0' + d.slice(3); else if (d.length === 9) d = '0' + d; return /^0\d{9}$/.test(d) ? d : ''; };
  const acctGet = (ph) => sbCall('web_acct_get', { p_phone: ph });
  const acctPut = (ph, data, isNew) => sbCall('web_acct_put', { p_phone: ph, p_data: data, p_new: !!isNew });
  const hashPw = (pw) => new Promise((ok, no) => { const salt = crypto.randomBytes(16).toString('hex'); crypto.pbkdf2(String(pw), salt, 150000, 32, 'sha256', (e, k) => e ? no(e) : ok('p2$' + salt + '$' + k.toString('hex'))); });
  const checkPw = (pw, stored) => new Promise((ok) => { const [, salt, h] = String(stored || '').split('$'); if (!salt || !h) return ok(false); crypto.pbkdf2(String(pw), salt, 150000, 32, 'sha256', (e, k) => ok(!e && crypto.timingSafeEqual(k, Buffer.from(h, 'hex')))); });
  const pwRule = (pw) => (String(pw).length < 6 ? 'Use a password of at least 6 characters.' : String(pw).length > 100 ? 'That password is too long.' : '');
  const csecret = () => crypto.createHash('sha256').update('renatel-customer:' + SCOPE() + (process.env.SUPABASE_BACKUP_TOKEN || '')).digest();
  const csign = (body) => crypto.createHmac('sha256', csecret()).update(body).digest('base64url');
  const ctoken = (ph) => { const body = Buffer.from(JSON.stringify({ ph, iat: Date.now(), exp: Date.now() + 90 * 864e5 })).toString('base64url'); return body + '.' + csign(body); };
  async function custOf(req) {
    const h = String(req.headers.authorization || ''); if (!h.startsWith('Bearer ')) return null;
    const [body, mac] = h.slice(7).split('.'); if (!body || !mac) return null;
    const want = csign(body); if (mac.length !== want.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(want))) return null;
    let t; try { t = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch (e) { return null; }
    if (!(t.exp > Date.now())) return null;
    const a = await acctGet(t.ph); if (!a || (a.pwAt && t.iat < a.pwAt)) return null;
    return { phone: t.ph, a, blocked: !!a.blocked };
  }
  const profile = (ph, a) => ({ name: a.name, phone: ph, email: a.email || '', region: a.region || '' });
  // The account in the POS Customers list of a branch: found by phone, or added.
  async function posCustomer(b, ph, a) {
    b = brOf(b);
    if (!prodAt || Date.now() - prodAt > 5000) { if (!prodBusy) prodBusy = refreshProducts().finally(() => { prodBusy = null; }); await prodBusy; }
    const found = Object.values(custDocs[b]).find((c) => c && normPhone(c.phone) === ph);
    if (found) return found.id;
    const [id] = await sbCall('shop_ids', { p_n: 1 });
    const c = { id, name: a.name, phone: ph, region: a.region || '', city: '', gps: '', owed: 0, addedBy: 'Online shop', addedTs: Date.now(), email: a.email || '', online: true };
    await sbCall('shop_db_put', { p_col: BR[b].pf + 'customers', p_id: 'c' + id, p_data: c });
    custDocs[b]['c' + id] = c;
    serverLog('Added customer', a.name + ' · ' + ph + ' (online shop account, ' + BR[b].name + ')', WHO);
    return id;
  }

  // ---- receipts and SMS ----
  const rsecret = () => crypto.createHash('sha256').update('renatel-receipt:' + SCOPE() + (process.env.SUPABASE_BACKUP_TOKEN || '')).digest();
  const rsig = (b, id) => crypto.createHmac('sha256', rsecret()).update(b + ':' + id).digest('base64url').slice(0, 10);
  const receiptCode = (b, id) => (b === 'acc' ? 'a' : 'k') + Number(id).toString(36) + '.' + rsig(b === 'acc' ? 'acc' : 'kum', Number(id));
  function readCode(code) {
    const m = String(code || '').match(/^([ka])([0-9a-z]{1,12})\.([A-Za-z0-9_-]{10})$/); if (!m) return null;
    const b = m[1] === 'a' ? 'acc' : 'kum', id = parseInt(m[2], 36);
    const want = rsig(b, id); if (!crypto.timingSafeEqual(Buffer.from(want), Buffer.from(m[3]))) return null;
    return { b, id };
  }
  const findSale = (b, id) => { for (const recs of Object.values(saleDocs[b])) { const r = recs.find((x) => x.id === id); if (r) return r; } return null; };
  async function getSale(b, id, waitMs) {
    const until = Date.now() + (waitMs || 0);
    for (;;) {
      if (!prodBusy) prodBusy = refreshProducts().finally(() => { prodBusy = null; }); await prodBusy;
      const r = findSale(b, id); if (r || Date.now() > until) return r;
      await new Promise((ok) => setTimeout(ok, 1000));
    }
  }
  const SMS_API = process.env.USMS_API || 'https://webapp.usmsgh.com/api';
  const SM = { token: '', sender: '', at: 0, shared: false };
  async function smsCfg(fresh) {
    if (!fresh && SM.at && Date.now() - SM.at < 30000) return SM;
    try { const [t, sd] = await Promise.all([sbCall('site_secret_get', { p_name: 'usms_token' }), sbCall('site_secret_get', { p_name: 'usms_sender' })]); SM.token = t || ''; SM.sender = sd || ''; SM.shared = false;
      // Multi-shop: a shop with no SMS account of its own may use the platform's shared account (switched on by the platform admin).
      if (!SM.token && d.sharedSms) { const sh = await d.sharedSms(); if (sh && sh.token && sh.sender) { SM.token = sh.token; SM.sender = sh.sender; SM.shared = true; } }
      SM.at = Date.now(); }
    catch (e) { console.error('sms config', e.message); }
    return SM;
  }
  const intlPhone = (v) => { const d = normPhone(v); return d ? '233' + d.slice(1) : ''; };
  async function usms(path, body, token) {
    const r = await fetch(SMS_API + path, { method: body ? 'POST' : 'GET', headers: { Authorization: 'Bearer ' + token, Accept: 'application/json', 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000) });
    const t = await r.text(); let j = {}; try { j = JSON.parse(t); } catch (e) {}
    if (!r.ok || (j.status && j.status !== 'success')) throw new Error(j.message || ('USMS-GH answered ' + r.status + (t && !j.message ? ': ' + t.slice(0, 120) : '')));
    return j;
  }
  async function sendSms(to, message) {
    const c = await smsCfg(false), rc = intlPhone(to);
    if (!c.token || !c.sender) throw new Error('SMS is not set up yet (Online shop → Settings → SMS receipts).');
    if (!rc) throw new Error('That phone number is not valid.');
    return usms('/sms/send', { recipient: rc, sender_id: c.sender, type: 'plain', message: String(message).slice(0, 459) }, c.token);
  }
  // One-time codes (password resets), kept as hashes in Supabase so every server process sees them.
  const otpHash = (key, code) => crypto.createHash('sha256').update('otp:' + key + ':' + String(code)).digest('hex');
  async function otpIssue(key) {
    const cur = await sbCall('otp_get', { p_k: key });
    if (cur && Date.now() - cur.sent < 60000) { const e = new Error('A code was sent less than a minute ago. Wait a moment before asking for another.'); e.code = 429; throw e; }
    const code = String(100000 + crypto.randomInt(900000));
    await sbCall('otp_set', { p_k: key, p_h: otpHash(key, code), p_minutes: 15 });
    return code;
  }
  async function otpCheck(key, code) { // 'ok' | 'expired' | 'locked' | number of tries left
    const cur = await sbCall('otp_get', { p_k: key });
    if (!cur || cur.exp < Date.now()) return 'expired';
    if (cur.tries >= 5) { await sbCall('otp_mark', { p_k: key, p_try: false }); return 'locked'; }
    if (otpHash(key, String(code || '').replace(/\D/g, '')) !== cur.h) { await sbCall('otp_mark', { p_k: key, p_try: true }); return 4 - cur.tries; }
    await sbCall('otp_mark', { p_k: key, p_try: false });
    return 'ok';
  }
  const otpSms = (shopName, code) => (shopName || 'Renatel Shop') + ': your password reset code is ' + code + '. It expires in 15 minutes. Never share this code with anyone.';
  const smsReady = async () => { const c = await smsCfg(false); return !!(c.token && c.sender); };
  const DEF_SMS = 'Thank you for shopping at {shop}, {name}! Receipt #{no}, GHS {total}. View it here: {link}';
  // Thank-you SMS with the receipt link. Returns {sent, to} or throws.
  async function smsReceipt(b, sale, phone, host, by) {
    const shop = await shopMain(false), set = (shop && shop.set) || {};
    const link = host + BASE() + '/r/' + receiptCode(b, sale.id), first = String(sale.custName || '').trim().split(/\s+/)[0] || 'customer';
    const cr = credOf(sale);
    if (cr > 0 && sale.cust) { // a sale on credit: the SMS says how much is owed, by when, and links to the invoice
      const c = await custDoc(b, sale.cust), due = sale.due || (c && c.due) || '', ilink = host + BASE() + '/i/' + invCode(b, sale.cust);
      const msg = fill(set.credSaleMsg || DEF_CRED_SALE, { shop: set.name || 'Renatel Shop', name: first, no: sale.id, total: Number(sale.total || 0).toFixed(2), credit: cr.toFixed(2), owed: Number((c && c.owed) || cr).toFixed(2), due: due ? dayStr(due) : 'the agreed date', link: ilink });
      await sendSms(phone, msg);
      const ph = normPhone(phone);
      serverLog('Credit SMS sent', '#' + sale.id + ' · GHS ' + cr.toFixed(2) + ' on credit' + (due ? ', pay by ' + dayStr(due) : '') + ' · to ' + mask(ph) + ' · ' + (b === 'acc' ? 'Accra' : 'Kumasi') + ' branch', by || WHO);
      return { sent: true, to: mask(ph), link: ilink, credit: true };
    }
    const msg = String(set.smsMsg || DEF_SMS).replace(/\{shop\}/g, set.name || 'Renatel Shop').replace(/\{name\}/g, first).replace(/\{no\}/g, sale.id).replace(/\{total\}/g, Number(sale.total || 0).toFixed(2)).replace(/\{link\}/g, link)
      .replace(/₵/g, 'S').replace(/[‘’]/g, "'").replace(/[“”]/g, '"');
    await sendSms(phone, msg);
    const ph = normPhone(phone);
    serverLog('Receipt SMS sent', '#' + sale.id + ' to ' + ph.slice(0, 3) + '•••' + ph.slice(-3) + ' · ' + (b === 'acc' ? 'Accra' : 'Kumasi') + ' branch', by || WHO);
    return { sent: true, to: ph.slice(0, 3) + '•••' + ph.slice(-3), link };
  }
  const hostOf = (req) => 'https://' + String((req && (req.headers['x-forwarded-host'] || req.headers.host)) || DEFHOST).split(',')[0].trim().replace(/^localhost.*/, DEFHOST);

  // ---- the customer's receipt page: /r/<code> ----
  async function receiptPage(req, res, code) {
    const html = (status, body, title) => { res.writeHead(status, Object.assign({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' }, HEADERS)); res.end(req.method === 'HEAD' ? undefined : RPAGE(title || 'Receipt', body)); };
    const k = readCode(code);
    if (!k || !sbOn()) return html(404, '<div class="box"><h2>Receipt not found</h2><p class="mut">This receipt link is not valid. Check the SMS, or contact the shop.</p></div>');
    let sale; try { sale = await getSale(k.b, k.id, 0); } catch (e) { console.error('receipt', e.message); return html(502, '<div class="box"><h2>Please try again</h2><p class="mut">The receipt could not be loaded just now.</p></div>'); }
    if (!sale) return html(404, '<div class="box"><h2>Receipt not found</h2><p class="mut">This receipt is no longer available. Contact the shop if you need a copy.</p></div>');
    const shop = await shopMain(false), set = (shop && shop.set) || {}, cur = set.cur || 'GH₵', m = (n) => cur + ' ' + Number(n || 0).toFixed(2);
    const e = (x) => String(x == null ? '' : x).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const when = new Date(sale.ts).toLocaleString('en-GB', { timeZone: 'Africa/Accra', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    const rows = (sale.items || []).map((i) => `<tr><td>${e(i.name)}<br><small>${i.qty} × ${Number(i.price).toFixed(2)}${i.disc ? ' · discount ' + Number(i.disc).toFixed(2) : ''}</small></td><td class="n">${(i.qty * i.price - (i.disc || 0)).toFixed(2)}</td></tr>`).join('');
    const line = (a, b, cls) => `<div class="r ${cls || ''}"><span>${e(a)}</span><span>${e(b)}</span></div>`;
    const refunded = (sale.refunds || []).reduce((t, r) => t + (Number(r.amt || r.total || 0)), 0);
    const pays = (sale.pays || []).filter((p) => p.amt > 0);
    const bn = (set.brNames || {})[k.b] || (k.b === 'acc' ? 'Accra branch' : 'Kumasi branch');
    const body = `<div class="box"><div class="head">${LOGO(set)}<div><h1>${e(set.name || 'Renatel Shop')}</h1><div class="mut">${e(bn)}${k.b === 'kum' && set.addr ? ' · ' + e(set.addr) : ''}${set.phone ? ' · <a href="tel:' + e(String(set.phone).replace(/[^\d+]/g, '')) + '">' + e(set.phone) + '</a>' : ''}</div></div></div>
      <div class="meta"><div><b>Receipt #${e(sale.id)}</b><br><span class="mut">${e(when)}</span></div>${sale.custName ? `<div style="text-align:right"><span class="mut">Customer</span><br><b>${e(sale.custName)}</b></div>` : ''}</div>
      <table>${rows}</table>
      ${sale.disc ? line('Discount', '−' + m(sale.disc)) : ''}${sale.dfee ? line('Delivery fee', m(sale.dfee)) : ''}${line('Total', m(sale.total), 'b')}
      ${pays.map((p) => line(p.m === 'Credit' ? 'On credit' : 'Paid by ' + (p.m === 'Online' ? 'Mobile Money / card (online)' : p.m), m(p.amt))).join('')}
      ${refunded ? line('Refunded', '−' + m(refunded)) : ''}${sale.tax ? line('Includes tax (' + (sale.taxRate || '') + '%)', m(sale.tax), 'mut') : ''}
      ${line('Served by', sale.byName || '—', 'mut')}
      ${refunded < sale.total && credOf(sale) > 0 && sale.cust ? `<div class="note">Part of this receipt is on credit. <a href="${BASE()}/i/${invCode(k.b, sale.cust)}"><b>See what is left to pay</b></a></div>` : `<div class="paid">${refunded >= sale.total ? 'Refunded' : (sale.online ? '✓ Paid online' : '✓ Paid')}</div>`}
      <p class="thanks">${e(set.footer || 'Thank you!')}</p></div>
      <p class="shopon"><a href="${SHOPURL()}">🛍️ Shop online at ${e(String(hostOf(req)).replace(/^https:\/\//, ''))}</a></p>`;
    return html(200, body, 'Receipt #' + sale.id + ' · ' + (set.name || 'Renatel Shop'));
  }
  const LOGO = (set) => MULTI ? `<span style="display:grid;place-items:center;width:52px;height:52px;border-radius:12px;background:#0b7a4b;color:#fff;font-weight:800;font-size:24px;flex:none">${String(set.name || 'S').trim().charAt(0).toUpperCase().replace(/[<&"]/g, '')}</span>` : '<img src="/logo-icon.svg" alt="" width="52" height="52">';
  const RPAGE = (title, body) => `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${title.replace(/</g, '&lt;')}</title>${MULTI ? '' : '<link rel="icon" href="/logo-icon.svg">'}
<style>:root{--g:#0b7a4b;--ink:#1b1f1d;--mut:#6e7571;--line:#ebedeb}*{box-sizing:border-box}body{margin:0;background:#f4f5f3;color:var(--ink);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;padding:20px 14px 40px}
.box{max-width:460px;margin:0 auto;background:#fff;border-radius:18px;padding:22px;box-shadow:0 4px 18px rgba(0,0,0,.06)}.head{display:flex;gap:12px;align-items:center;padding-bottom:14px;border-bottom:2px dashed var(--line)}.head img{border-radius:12px;flex:none}
h1{font-size:19px;margin:0}h2{margin:0 0 6px}.mut,small{color:var(--mut)}a{color:var(--g)}.meta{display:flex;justify-content:space-between;gap:10px;margin:14px 0 4px}
table{width:100%;border-collapse:collapse;margin:8px 0}td{padding:9px 0;border-bottom:1px solid var(--line);vertical-align:top}.n{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
.r{display:flex;justify-content:space-between;gap:10px;padding:3px 0;font-variant-numeric:tabular-nums}.r.b{font-weight:700;font-size:19px;border-top:2px solid var(--ink);margin-top:6px;padding-top:9px}.r.mut{font-size:13px}
.fm{margin-top:16px;border-top:2px dashed var(--line);padding-top:12px}.fm h3{margin:0 0 8px}.fm label{display:block;font-size:14px;color:var(--mut)}.fm input,.fm select{display:block;width:100%;padding:11px;border:1px solid #cfd4d1;border-radius:10px;font:inherit;color:var(--ink);margin:4px 0 12px;background:#fff}
.fm button{width:100%;padding:13px;border:0;border-radius:12px;background:var(--g);color:#fff;font-weight:700;font-size:16px;cursor:pointer}.note{background:#fff6dc;border-radius:12px;padding:10px 12px;margin-top:14px}.bad{color:#c0392b;font-weight:700}
.paid{display:inline-block;margin-top:14px;padding:5px 12px;border-radius:99px;background:#e7f4ee;color:var(--g);font-weight:700}.thanks{text-align:center;color:var(--mut);margin:18px 0 0}.shopon{text-align:center;margin-top:16px;font-weight:600}
@media print{body{background:#fff;padding:0}.box{box-shadow:none}.shopon{display:none}}</style></head><body>${body}</body></html>`;

  // ---- credit: invoices (/i/<code>), daily reminder SMS and "I have paid" claims ----
  const credOf = (s) => r2(((s && s.pays) || []).filter((p) => p.m === 'Credit').reduce((a, p) => a + (+p.amt || 0), 0));
  const fill = (t, v) => String(t).replace(/\{(\w+)\}/g, (m, k) => (v[k] != null ? String(v[k]) : m)).replace(/₵/g, 'S').replace(/[‘’]/g, "'").replace(/[“”]/g, '"');
  const isDay = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
  const dayStr = (v) => { if (!isDay(v)) return ''; const [y, m, dd] = v.split('-').map(Number); return new Date(Date.UTC(y, m - 1, dd)).toLocaleDateString('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' }); };
  const DEF_CRED_SALE = 'Thank you for shopping at {shop}, {name}! Receipt #{no}, GHS {total}. GHS {credit} is on credit, to pay by {due}. Your invoice: {link}';
  const DEF_REMIND = 'Hello {name}, this is {shop}. Your credit balance of GHS {owed} {when}. Please pay, then tap I have paid on your invoice: {link}';
  const SITE = () => (MULTI ? (d.siteUrl ? d.siteUrl() : 'https://' + DEFHOST) + BASE() : (process.env.SITE_URL || 'https://renatel.shop').replace(/\/+$/, ''));
  const isig = (b, id) => crypto.createHmac('sha256', rsecret()).update('inv:' + b + ':' + id).digest('base64url').slice(0, 10);
  const invCode = (b, id) => (b === 'acc' ? 'a' : 'k') + Number(id).toString(36) + '.' + isig(b === 'acc' ? 'acc' : 'kum', Number(id));
  function readInv(code) {
    const m = String(code || '').match(/^([ka])([0-9a-z]{1,12})\.([A-Za-z0-9_-]{10})$/); if (!m) return null;
    const b = m[1] === 'a' ? 'acc' : 'kum', id = parseInt(m[2], 36);
    if (!crypto.timingSafeEqual(Buffer.from(isig(b, id)), Buffer.from(m[3]))) return null;
    return { b, id };
  }
  async function fresh() { if (!prodBusy) prodBusy = refreshProducts().finally(() => { prodBusy = null; }); await prodBusy; }
  async function custDoc(b, id) { if (!prodAt || Date.now() - prodAt > 3000) await fresh(); return custDocs[brOf(b)]['c' + id] || null; }
  // What the customer owes, split over their newest credit sales (payments clear the oldest credit first).
  function credInfo(b, c) {
    const owed = r2(+c.owed || 0), list = [], all = []; let left = owed;
    for (const recs of Object.values(saleDocs[b])) for (const s of recs) if (s && +s.cust === +c.id && credOf(s) > 0) all.push(s);
    all.sort((x, y) => y.ts - x.ts);
    for (const s of all) { if (left <= 0.004) break; const take = r2(Math.min(left, credOf(s))); list.push({ id: s.id, ts: s.ts, credit: credOf(s), unpaid: take, due: isDay(s.due) ? s.due : '' }); left = r2(left - take); }
    list.reverse();
    // A pay-by date set on the customer (Customers → profile) overrides the dates of the sales.
    const due = isDay(c.due) ? c.due : list.map((x) => x.due).filter(Boolean).sort()[0] || '';
    return { owed, list, due, other: left > 0.004 ? left : 0 };
  }
  const pendingClaim = (b, id) => Object.values(claimDocs).find((x) => x && x.b === b && +x.cust === +id && x.status === 'pending' && Date.now() - x.ts < 3 * 864e5) || null;
  const whenText = (due, today) => (!due ? 'is now due' : due < today ? 'was due on ' + dayStr(due) : due === today ? 'is due today' : 'is due on ' + dayStr(due));
  const remindText = (set, c, ci, link) => fill(set.credMsg || DEF_REMIND, { shop: set.name || 'Renatel Shop', name: String(c.name || '').trim().split(/\s+/)[0] || 'customer', owed: ci.owed.toFixed(2), due: ci.due ? dayStr(ci.due) : '', when: whenText(ci.due, accraDay(Date.now())), link, phone: set.phone || '' });
  const mask = (ph) => ph.slice(0, 3) + '•••' + ph.slice(-3);

  // Every 10 minutes: from the reminder hour (Ghana time), text each customer whose credit is due or overdue,
  // once a day, until the balance is cleared. Paused while a payment claim waits for approval (up to 3 days).
  // The job_once table makes sure only one server process sends each day's reminder.
  let remBusy = false;
  async function remindRun() {
    if (remBusy || !sbOn()) return; remBusy = true;
    try {
      const shop = await shopMain(true), set = (shop && shop.set) || {};
      if (set.credRem === false || !(await smsReady())) return;
      const hr = new Date().getUTCHours(), at = Number.isFinite(+set.credHour) && set.credHour !== '' ? +set.credHour : 9; // Ghana = UTC
      if (hr < at || hr >= 20) return;
      await fresh();
      const today = accraDay(Date.now());
      ONE = MULTI && set.branches == 1;
      for (const b of brKeys()) {
        for (const c of Object.values(custDocs[b])) {
          if (!c || !(+c.owed > 0.004) || c.remOff) continue;
          const ph = normPhone(c.phone); if (!ph) continue;
          const ci = credInfo(b, c); if (!ci.due || ci.due > today) continue;
          if (pendingClaim(b, c.id)) continue;
          if (!(await sbCall('job_once', { p_k: 'crem:' + b + ':' + c.id + ':' + today }))) continue;
          try { await sendSms(ph, remindText(set, c, ci, SITE() + '/i/' + invCode(b, c.id))); serverLog('Credit reminder SMS', c.name + ' · owes GHS ' + ci.owed.toFixed(2) + ' · ' + whenText(ci.due, today) + ' · to ' + mask(ph) + ' · ' + BR[b].name, WHO); }
          catch (e) { console.log('credit reminder ' + c.id + ': ' + e.message); }
        }
      }
    } catch (e) { console.error('credit reminders', e.message); }
    finally { remBusy = false; }
  }
  if (sbOn() && !d.noTimers) { setTimeout(remindRun, 20000).unref(); setInterval(remindRun, +process.env.REMIND_EVERY_MS || 600000).unref(); }

  const PAY_METHODS = ['Mobile Money', 'Cash', 'Bank transfer', 'Other'];
  async function invoicePage(req, res, code) {
    const html = (status, body, title) => { res.writeHead(status, Object.assign({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' }, HEADERS)); res.end(req.method === 'HEAD' ? undefined : RPAGE(title || 'Invoice', body)); };
    const k = readInv(code);
    if (!k || !sbOn()) return html(404, '<div class="box"><h2>Invoice not found</h2><p class="mut">This invoice link is not valid. Check the SMS, or contact the shop.</p></div>');
    try { await fresh(); } catch (e) { return html(502, '<div class="box"><h2>Please try again</h2><p class="mut">The invoice could not be loaded just now.</p></div>'); }
    const c = custDocs[k.b]['c' + k.id];
    if (!c) return html(404, '<div class="box"><h2>Invoice not found</h2><p class="mut">Contact the shop if you need a copy.</p></div>');
    const shop = await shopMain(false), set = (shop && shop.set) || {}, cur = set.cur || 'GH₵', m = (n) => cur + ' ' + Number(n || 0).toFixed(2);
    const e = (x) => String(x == null ? '' : x).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
    let err = '';
    if (req.method === 'POST') {
      const f = new URLSearchParams(String(await readBody(req)).slice(0, 4000));
      const amt = r2(+f.get('amt')), method = PAY_METHODS.includes(f.get('method')) ? f.get('method') : 'Other', ref = String(f.get('ref') || '').trim().replace(/\s+/g, ' ').slice(0, 80);
      if (!allow(req, 20, 'clm')) err = 'Too many tries from here. Please call the shop.';
      else if (pendingClaim(k.b, c.id)) err = 'Your earlier payment is still waiting for the shop to confirm it.';
      else if (!(+c.owed > 0.004)) err = 'There is nothing to pay on this invoice.';
      else if (!(amt > 0) || amt > r2(+c.owed) + 0.004) err = 'Enter the amount you paid (up to ' + m(c.owed) + ').';
      else {
        const [id] = await sbCall('shop_ids', { p_n: 1 });
        const cl = { id, b: k.b, cust: c.id, name: c.name, phone: c.phone || '', amt, method, ref, ts: Date.now(), status: 'pending' };
        await sbCall('shop_db_put', { p_col: CLM, p_id: 'cl' + id, p_data: cl }); claimDocs['cl' + id] = cl;
        serverLog('Payment claim', c.name + ' says they paid ' + m(amt) + ' by ' + method + (ref ? ' (' + ref + ')' : '') + ' · approve it in Customers · ' + BR[k.b].name, WHO);
        res.writeHead(303, { Location: BASE() + '/i/' + code + '?sent=1', 'Cache-Control': 'no-store' }); return res.end();
      }
    }
    const ci = credInfo(k.b, c), today = accraDay(Date.now()), pend = pendingClaim(k.b, c.id), sent = /[?&]sent=1/.test(req.url || '');
    const bn = (set.brNames || {})[k.b] || BR[k.b].name;
    const date = (t) => new Date(t).toLocaleDateString('en-GB', { timeZone: 'Africa/Accra', day: 'numeric', month: 'short', year: 'numeric' });
    const dueTag = (d) => (!d ? '' : d < today ? `<span class="bad">overdue since ${e(dayStr(d))}</span>` : d === today ? '<span class="bad">due today</span>' : 'pay by ' + e(dayStr(d)));
    const rows = ci.list.map((x) => `<tr><td><a href="${BASE()}/r/${receiptCode(k.b, x.id)}">Receipt #${e(x.id)}</a> · ${e(date(x.ts))}<br><small>${x.unpaid < x.credit ? 'on credit ' + e(m(x.credit)) + ' · ' : ''}${isDay(c.due) ? '' : dueTag(x.due)}</small></td><td class="n">${e(m(x.unpaid))}</td></tr>`).join('')
      + (ci.other ? `<tr><td>Earlier balance</td><td class="n">${e(m(ci.other))}</td></tr>` : '');
    const opts = PAY_METHODS.map((x) => `<option>${x}</option>`).join('');
    const tail = ci.owed <= 0.004 ? '<div class="paid">✓ Nothing to pay. Thank you!</div>'
      : pend ? `<div class="note">${sent ? '<b>Thank you!</b> ' : ''}Your payment of <b>${e(m(pend.amt))}</b> (${e(pend.method)}${pend.ref ? ', ' + e(pend.ref) : ''}) is waiting for the shop to confirm it. Reminders are paused meanwhile, and you’ll get an SMS when it is confirmed.</div>`
      : `${set.credPayInfo ? `<div class="note"><b>How to pay</b><br>${e(set.credPayInfo).replace(/\n/g, '<br>')}</div>` : ''}
        <form class="fm" method="post" action="${BASE()}/i/${e(code)}"><h3>Already paid?</h3>${err ? `<p class="bad">${e(err)}</p>` : ''}
        <label>Amount paid (${e(cur)})<input name="amt" type="number" inputmode="decimal" min="0.01" step="0.01" max="${ci.owed.toFixed(2)}" value="${ci.owed.toFixed(2)}" required></label>
        <label>Paid by<select name="method">${opts}</select></label>
        <label>Transaction ID or note (optional)<input name="ref" maxlength="80" placeholder="e.g. MoMo transaction ID"></label>
        <button type="submit">I have paid</button><p class="mut" style="font-size:13px;margin:8px 0 0">The shop checks the payment and confirms it. Reminders stop once it is confirmed.</p></form>`;
    const body = `<div class="box"><div class="head">${LOGO(set)}<div><h1>${e(set.name || 'Renatel Shop')}</h1><div class="mut">${e(bn)}${set.phone ? ' · <a href="tel:' + e(String(set.phone).replace(/[^\d+]/g, '')) + '">' + e(set.phone) + '</a>' : ''}</div></div></div>
      <div class="meta"><div><b>Credit invoice</b><br><span class="mut">${e(date(Date.now()))}</span></div><div style="text-align:right"><span class="mut">Customer</span><br><b>${e(c.name)}</b></div></div>
      ${rows ? '<table>' + rows + '</table>' : ''}
      <div class="r b"><span>Balance to pay</span><span>${e(m(Math.max(0, ci.owed)))}</span></div>
      ${ci.owed > 0.004 && ci.due ? `<div class="r"><span>Pay by</span><span>${ci.due < today ? `<span class="bad">${e(dayStr(ci.due))} (overdue)</span>` : e(dayStr(ci.due))}</span></div>` : ''}
      ${tail}</div>
      <p class="shopon"><a href="${SHOPURL()}">🛍️ Shop online at ${e(String(hostOf(req)).replace(/^https:\/\//, ''))}</a></p>`;
    return html(err ? 400 : 200, body, 'Invoice · ' + (set.name || 'Renatel Shop'));
  }

  // ---- orders (kept in their own collection; the tills ignore it) ----
  const ORD = 'webOrders';
  const getOrder = (ref) => sbCall('shop_db_get', { p_col: ORD, p_id: ref });
  const putOrder = (ref, o) => sbCall('shop_db_put', { p_col: ORD, p_id: ref, p_data: o });
  const publicOrder = (o, ref) => ({ ref, branch: o.branch, branchName: (BR[o.branch] || BR.kum).name, status: o.status, items: o.items.map((i) => ({ name: i.name, qty: i.qty, price: i.price })), total: o.total, name: o.name, mode: o.mode, saleId: o.saleId || null, created: o.created, pay: o.pay || mode(), fulfil: o.fulfil || '' });

  // Append one record to a list document ({recs:[...]}) the way the tills do: up to 300 per document.
  async function appendRec(col, base, rec) {
    for (let n = 0; n < 50; n++) {
      // Each server process writes its own documents, so processes running side by side never overwrite each other.
      const id = base + '_web' + process.pid + '_' + n, cur = await sbCall('shop_db_get', { p_col: col, p_id: id });
      const recs = cur && Array.isArray(cur.recs) ? cur.recs : [];
      if (recs.length >= 300) continue;
      recs.push(Object.assign({ _c: id }, rec));
      await sbCall('shop_db_put', { p_col: col, p_id: id, p_data: { recs } });
      return id;
    }
    throw new Error('no room in ' + col);
  }

  // Record a paid order in the POS. The site may run as several processes, so the order is first claimed in the
  // database (only one process ever gets it) and each item's stock is taken atomically (it can never go below zero).
  let q = Promise.resolve();
  function finalize(ref, pay) { const job = q.then(() => finalizeNow(ref, pay)); q = job.catch(() => {}); return job; }
  async function finalizeNow(ref, pay) {
    const o = await getOrder(ref);
    if (!o) throw new Error('order not found');
    if (o.status !== 'pending') return o;
    if (!(await sbCall('web_order_claim', { p_ref: ref }))) return (await getOrder(ref)) || o;
    try { return await finalizeClaimed(ref, o, pay); }
    catch (e) {
      console.error('finalize ' + ref, e.message);
      o.status = 'paid_short'; o.paidAt = o.paidAt || Date.now(); o.payment = pay; o.short = 'could not be recorded automatically';
      if (o.plat) { o.fee = r2(o.total * (+o.feePct || 0) / 100); o.net = r2(o.total - o.fee); }
      try { await putOrder(ref, o); } catch (e2) { console.error('finalize save', e2.message); }
      serverLog('Online order needs attention', 'Order ' + ref + ' was paid (' + money(o.total) + ') but could not be recorded automatically. Check the stock and record the sale for ' + o.name + ' ' + o.phone + '.', WHO);
      return o;
    }
  }
  async function finalizeClaimed(ref, o, pay) {
    const b = brOf(o.branch), PF = BR[b].pf;
    const prods = [];
    for (const it of o.items) {
      const p = await sbCall('web_stock_take', { p_col: PF + 'products', p_id: 'p' + it.id, p_qty: it.qty });
      if (!p) {
        for (const [tp, ti] of prods) await sbCall('web_stock_take', { p_col: PF + 'products', p_id: 'p' + tp.id, p_qty: -ti.qty }); // put back what was taken
        o.status = 'paid_short'; o.paidAt = Date.now(); o.payment = pay; o.short = it.name;
        if (o.plat) { o.fee = r2(o.total * (+o.feePct || 0) / 100); o.net = r2(o.total - o.fee); }
        await putOrder(ref, o);
        serverLog('Online order needs attention', 'Order ' + ref + ' was paid (' + money(o.total) + ') but ' + it.name + ' is out of stock at the ' + BR[b].name + '. Contact ' + o.name + ' ' + o.phone + ' to refund or swap.', WHO);
        return o;
      }
      prods.push([p, it]);
    }
    const ids = await sbCall('shop_ids', { p_n: 3 });
    const shop = await shopMain(false), set = (shop && shop.set) || {};
    const now = Date.now(), saleId = ids[0];
    const via = pay.provider === 'test' ? 'TEST payment' : 'Paystack' + (pay.channel ? ' ' + pay.channel : '');
    // 1. stock was taken above; log the stock moves
    for (const [p, it] of prods) {
      await appendRec(PF + 'moves', accraDay(now).slice(0, 7), { ts: now, pid: p.id, name: p.name, qty: -it.qty, reason: 'Online order #' + saleId, by: 'Online shop' });
    }
    // 2. the sale, shaped like a till sale
    const items = prods.map(([p, it]) => ({ id: p.id, name: p.name, price: it.price, cost: p.cost || 0, qty: it.qty, disc: 0 }));
    let custId = null;
    if (o.acct) { try { const a = await acctGet(o.acct); if (a) custId = await posCustomer(b, o.acct, a); } catch (e) { console.error('order customer', e.message); } }
    const tax = set.tax ? o.total * set.tax / (100 + set.tax) : 0;
    const sale = { id: saleId, ts: now, items, sub: o.total, disc: 0, sdisc: 0, total: o.total, method: 'Online', pays: [{ m: 'Online', amt: o.total }], tend: null, change: null,
      cust: custId, custName: o.name, by: null, byName: 'Online shop', tax, taxRate: set.tax || 0, refunds: [], dfee: 0,
      online: { ref, phone: o.phone, email: o.email || '', mode: o.mode, region: o.region || '', provider: pay.provider, payRef: pay.reference || ref } };
    // 3. delivery job if asked
    if (o.mode === 'delivery') {
      const dl = { id: ids[1], ts: now, sale: saleId, name: o.name, phone: o.phone, addr: o.addr, region: o.region || '', city: o.city || '', gps: '', note: ('Online order ' + ref + '. ' + (o.note || '')).trim(),
        items: items.map((i) => i.qty + ' × ' + i.name).join(', '), fee: 0, rider: null, status: 'Pending', by: 'Online shop', byId: null, when: '', cod: 0, codPaid: false };
      sale.dlv = dl.id; o.dlvId = dl.id;
      o.dlvDoc = await appendRec(PF + 'deliveries', accraDay(now).slice(0, 7), dl);
    }
    await appendRec(PF + 'sales', accraDay(now), sale);
    o.status = 'paid'; o.saleId = saleId; o.paidAt = now; o.payment = pay;
    if (o.plat) { o.fee = r2(o.total * (+o.feePct || 0) / 100); o.net = r2(o.total - o.fee); sale.online.plat = true; }
    await putOrder(ref, o);
    prodAt = 0;
    serverLog('Sale', '#' + saleId + ' · ' + money(o.total) + ' · Online (' + via + ') · ' + BR[b].name + ' · ' + o.name + ' ' + o.phone + (o.region ? ' (' + o.region + ')' : '') + ' · ' + (o.mode === 'delivery' ? 'delivery' : 'pickup') + ' · order ' + ref, WHO);
    if (o.phone) smsReceipt(b, sale, o.phone, o.host || 'https://' + DEFHOST).then((r) => { o.sms = r.to; }).catch((e) => console.log('order sms: ' + e.message));
    if (o.email) {
      const lines = items.map((i) => i.qty + ' × ' + i.name + '  ' + money(i.price * i.qty)).join('\n');
      sendEmail({ to: [o.email], subject: (set.name || 'Renatel Shop') + ' - order ' + ref + ' confirmed',
        text: 'Hello ' + o.name + ',\n\nThank you for your order. Receipt #' + saleId + '\n\n' + lines + '\n\nTotal paid: ' + money(o.total) + '\n' + (o.mode === 'delivery' ? 'We will call you on ' + o.phone + ' to arrange delivery to: ' + o.addr : 'Pick it up at our ' + BR[b].name + (b === 'kum' && set.addr ? ': ' + set.addr : '') + '. Show this email or your order number.') + '\n\n-- \n' + (set.name || 'Renatel Shop') + (set.phone ? ' · ' + set.phone : '') })
        .catch((e) => console.error('order email', e.message));
    }
    return o;
  }
  let CUR = 'GH₵';
  const money = (n) => CUR + ' ' + Number(n || 0).toFixed(2);

  // ---- Paystack ----
  async function paystack(pathname, body, key) {
    const r = await fetch(PS_API + pathname, { method: body ? 'POST' : 'GET', headers: { Authorization: 'Bearer ' + (key || KEY()), 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.status) throw new Error('Paystack: ' + (j.message || r.status));
    return j.data;
  }
  async function verifyPaystack(ref) {
    const o = await getOrder(ref);
    if (!o) return null;
    if (o.status !== 'pending') return o;
    const t = await paystack('/transaction/verify/' + encodeURIComponent(ref), null, await keyFor(o));
    if (t.status === 'success' && t.amount === Math.round(o.total * 100) && String(t.currency).toUpperCase() === 'GHS') {
      return finalize(ref, { provider: mode(), reference: t.reference, channel: t.channel || '', paidAt: t.paid_at || '' });
    }
    if (t.status === 'failed' || t.status === 'abandoned') { o.lastTry = t.status; await putOrder(ref, o); }
    return o;
  }

  // ---- limits: a few orders per visitor per hour ----
  const hits = new Map();
  function allow(req, max, bucket) { const k = (bucket || 'o') + ':' + (bucket && bucket.startsWith('lp') ? '' : clientIp(req)), h = hits.get(k) || { n: 0, at: Date.now() }; if (Date.now() - h.at > 3600e3) { h.n = 0; h.at = Date.now(); } h.n++; hits.set(k, h); return h.n <= max; }
  setInterval(() => { const t = Date.now(); for (const [k, v] of hits) if (t - v.at > 3600e3) hits.delete(k); }, 600000).unref();
  const json = async (req) => { try { return JSON.parse(await readBody(req)); } catch (e) { return null; } };
  const REF_RX = /^RS[A-Z0-9]{10}$/;

  async function api(req, res, url) {
    if (!sbOn()) return send(res, 503, { error: 'The online shop is not set up yet.' });
    try {
      if (MULTI) { const sh = await shopMain(false); ONE = !!(sh && sh.set && sh.set.branches == 1); }
      if (req.method === 'GET' && url === '/api/store/info') {
        await freshKey();
        const shop = await shopMain(false), set = (shop && shop.set) || {}; CUR = set.cur || CUR;
        ONE = MULTI && set.branches == 1;
        const b = brOf(new URL(req.url, 'http://x').searchParams.get('b')), names = set.brNames || {};
        const list = await listed(b, false);
        const ss = storeSet(shop);
        return send(res, 200, { store: { open: ss.open !== false, msg: ss.msg || '', pickup: ss.pickup !== false, delivery: ss.delivery !== false, dnote: ss.dnote || '' }, name: set.name || 'Renatel Shop', phone: set.phone || '', addr: b === 'kum' ? set.addr || '' : '', city: BR[b].city || (MULTI && b === 'kum' ? set.city || '' : ''), cur: set.cur || 'GH₵', mode: mode(),
          branch: b, branches: Object.fromEntries(brKeys().map((k) => [k, { name: names[k] || BR[k].name, city: BR[k].city || (MULTI && k === 'kum' ? set.city || '' : '') }])),
          products: list.map((p) => ({ id: p.id, name: p.name, cat: p.cat || '', unit: p.unit || 'pcs', price: p.price, left: avail(p), img: /^[a-f0-9]{24}$/.test(p.img || '') ? p.img : '' })).sort((x, y) => x.name.localeCompare(y.name)) });
      }
      // ---- POS: online shop management (logged-in staff with the right permission) ----
      if (url.startsWith('/api/store/admin/')) {
        const who = await caller(req);
        if (who.err) return send(res, who.err[0], { error: who.err[1] });
        const st = who.staff;
        // Any logged-in staff member can text a customer their receipt after a sale.
        if (req.method === 'POST' && url === '/api/store/admin/sms/receipt') {
          if (!st || st.locked) return send(res, 403, { error: 'Please log in again.' });
          if (!allow(req, 120, 'smsr')) return send(res, 429, { error: 'Too many SMS from this device. Try again later.' });
          const m = await json(req), b = brOf(m && m.b), id = Number(m && m.id), phone = normPhone(m && m.phone);
          if (!id || !phone) return send(res, 400, { error: 'A sale number and a valid phone number are needed.' });
          const sale = await getSale(b, id, 12000);
          if (!sale) return send(res, 404, { error: 'The sale is not saved online yet. Try again in a moment.' });
          try { return send(res, 200, await smsReceipt(b, sale, phone, hostOf(req), st)); }
          catch (e) { console.log('sms receipt: ' + e.message); return send(res, 502, { error: e.message }); }
        }
        // Credit: payment claims, invoice links and reminders (staff who manage customer balances).
        if (url === '/api/store/admin/claims' || url === '/api/store/admin/claim' || url === '/api/store/admin/credit') {
          const credCan = st && !st.locked && (st.role === 'owner' || (Array.isArray(st.access) ? st.access.includes('cust') : ['manager', 'accountant'].includes(st.role)));
          if (!credCan) return send(res, 403, { error: 'Only staff who manage customer balances can do this.' });
          const qs = new URL(req.url, 'http://x').searchParams, shop = await shopMain(false), set = (shop && shop.set) || {};
          if (req.method === 'GET' && url === '/api/store/admin/claims') {
            await fresh();
            const b = brOf(qs.get('b')), L = Object.values(claimDocs).filter((x) => x && x.b === b).sort((x, y) => y.ts - x.ts);
            return send(res, 200, { pending: L.filter((x) => x.status === 'pending'), recent: L.filter((x) => x.status !== 'pending').slice(0, 20) });
          }
          if (req.method === 'POST' && url === '/api/store/admin/claim') {
            const m = await json(req) || {}, id = Number(m.id), ok = !!m.ok;
            const cl = id > 0 ? await sbCall('shop_db_get', { p_col: CLM, p_id: 'cl' + id }) : null;
            if (!cl) return send(res, 404, { error: 'Claim not found.' });
            if (cl.status !== 'pending') return send(res, 409, { error: 'This claim was already ' + cl.status + (cl.by ? ' by ' + cl.by : '') + '.', status: cl.status });
            const amt = ok ? r2(+m.amt || cl.amt) : 0;
            if (ok && !(amt > 0)) return send(res, 400, { error: 'Enter the amount received.' });
            if (!(await sbCall('job_once', { p_k: 'claim:' + id }))) return send(res, 409, { error: 'Another till is already handling this claim. Refresh.' });
            Object.assign(cl, { status: ok ? 'approved' : 'rejected', by: st.name, at: Date.now() }); if (ok) cl.got = amt; else cl.why = String(m.why || '').trim().slice(0, 120);
            await sbCall('shop_db_put', { p_col: CLM, p_id: 'cl' + id, p_data: cl }); claimDocs['cl' + id] = cl;
            const first = String(cl.name || '').trim().split(/\s+/)[0] || 'customer', bal = r2(Math.max(0, +m.bal || 0));
            const text = ok ? fill('Thank you {name}! {shop} has received your payment of GHS {amt}. {rest}', { name: first, shop: set.name || 'Renatel Shop', amt: amt.toFixed(2), rest: bal > 0.004 ? 'Balance left: GHS ' + bal.toFixed(2) + '.' : 'Your account is fully paid.' })
              : fill('Hello {name}, {shop} could not confirm your payment of GHS {amt}{why}. Please call {phone} or pay and tap I have paid again: {link}', { name: first, shop: set.name || 'Renatel Shop', amt: Number(cl.amt).toFixed(2), why: cl.why ? ' (' + cl.why + ')' : '', phone: set.phone || 'the shop', link: hostOf(req) + BASE() + '/i/' + invCode(cl.b, cl.cust) });
            let sms = false, smsErr = '';
            if (normPhone(cl.phone)) { try { await sendSms(cl.phone, text); sms = true; } catch (e) { smsErr = e.message; } }
            serverLog(ok ? 'Payment claim approved' : 'Payment claim rejected', cl.name + ' · ' + (ok ? 'received GHS ' + amt.toFixed(2) + ' (' + cl.method + (cl.ref ? ', ' + cl.ref : '') + ')' : 'claimed GHS ' + Number(cl.amt).toFixed(2) + (cl.why ? ' · ' + cl.why : '')) + (sms ? ' · customer told by SMS' : ''), st);
            return send(res, 200, { ok: true, status: cl.status, amt, sms, smsErr });
          }
          if (url === '/api/store/admin/credit') {
            const m = req.method === 'POST' ? (await json(req) || {}) : { b: qs.get('b'), id: qs.get('id') };
            const b = brOf(m.b), id = Number(m.id); await fresh();
            const c = custDocs[b]['c' + id];
            if (!c) return send(res, 404, { error: 'This customer is not saved online yet. Try again in a moment.' });
            const link = hostOf(req) + BASE() + '/i/' + invCode(b, id), ci = credInfo(b, c), pend = pendingClaim(b, id);
            if (req.method === 'GET') return send(res, 200, { link, owed: ci.owed, due: ci.due, list: ci.list, pending: pend });
            if (!(ci.owed > 0.004)) return send(res, 400, { error: c.name + ' owes nothing.' });
            const ph = normPhone(c.phone); if (!ph) return send(res, 400, { error: c.name + ' has no valid phone number.' });
            if (!allow(req, 60, 'crm')) return send(res, 429, { error: 'Too many reminders from this device. Try again later.' });
            try { await sendSms(ph, remindText(set, c, ci, link)); } catch (e) { return send(res, 502, { error: e.message }); }
            serverLog('Credit reminder SMS', c.name + ' · owes GHS ' + ci.owed.toFixed(2) + ' · sent by hand · to ' + mask(ph), st);
            return send(res, 200, { sent: true, to: mask(ph), link });
          }
        }
        // Delivery SMS (rider job details, customer updates, instructions): any logged-in staff; the till writes the text.
        if (req.method === 'POST' && url === '/api/store/admin/sms/bulk') { // school: fee reminders, payment receipts, absence notes (sent in the background)
          if (!st || st.locked || ['warehouse', 'stock'].includes(st.role)) return send(res, 403, { error: 'You can’t send these messages.' });
          if (!allow(req, 40, 'smsb')) return send(res, 429, { error: 'Too many batches of SMS from this device. Try again in an hour.' });
          const m = await json(req) || {}, kind = String(m.kind || 'note').replace(/[^a-z]/g, '').slice(0, 12) || 'note';
          const L = (Array.isArray(m.msgs) ? m.msgs.slice(0, 800) : []).map((x) => ({ to: normPhone(x && x.to), text: String(x && x.text || '').replace(/\s+\n/g, '\n').trim().slice(0, 459) })).filter((x) => x.to && x.text.length >= 5);
          if (!L.length) return send(res, 400, { error: 'No valid phone numbers to send to.' });
          if (!(await smsCfg()).token) return send(res, 400, { error: 'SMS is not set up for this shop yet.' });
          send(res, 200, { queued: L.length });
          (async () => { let ok = 0, bad = 0; for (const x of L) { try { await sendSms(x.to, x.text); ok++; } catch (e) { bad++; } }
            const K = { fees: 'fee reminders', receipt: 'fee receipt', absent: 'absence notes', courier: 'delivery updates', behaviour: 'behaviour report links', announce: 'announcements', note: 'messages' };
            serverLog('SMS sent', (K[kind] || kind) + ' · ' + ok + ' sent' + (bad ? ' · ' + bad + ' failed' : ''), st); })().catch((e) => console.error('bulk sms', e.message));
          return;
        }
        if (req.method === 'POST' && url === '/api/store/admin/sms/dlv') {
          if (!st || st.locked) return send(res, 403, { error: 'Please log in again.' });
          if (!allow(req, 200, 'smsd')) return send(res, 429, { error: 'Too many SMS from this device. Try again later.' });
          const m = await json(req) || {}, to = normPhone(m.to), text = String(m.text || '').replace(/\s+\n/g, '\n').trim().slice(0, 459), kind = String(m.kind || 'note').slice(0, 20), did = String(m.id || '').slice(0, 20);
          if (!to) return send(res, 400, { error: 'That phone number is not valid.' });
          if (text.length < 5) return send(res, 400, { error: 'Type the message.' });
          try { await sendSms(to, fill(text, {})); } catch (e) { console.log('delivery sms: ' + e.message); return send(res, 502, { error: e.message }); }
          const L = { rider: 'job sent to rider', out: 'customer told: on the way', courier: 'customer told: sent via courier', courierjob: 'job sent to courier', done: 'customer told: delivered', note: 'instructions sent' };
          serverLog('Delivery SMS', '#' + did + ' · ' + (L[kind] || kind) + ' · to ' + mask(to) + ' · “' + text.slice(0, 70) + (text.length > 70 ? '…' : '') + '”', st);
          return send(res, 200, { sent: true, to: mask(to) });
        }
        const need = url.includes('/order') ? 'orders' : url.includes('/customer') ? 'customers' : url.endsWith('/pay') || url.includes('/sms') ? 'pay' : '';
        if (!st || (need === 'pay' ? st.role !== 'owner' || st.locked : !webCan(st, need))) return send(res, 403, { error: need === 'pay' ? 'Only the owner can change payment and SMS settings.' : 'You don’t have access to this part of the online shop. Ask the owner.' });
        if (url === '/api/store/admin/sms' || url === '/api/store/admin/sms/test') {
          const info = async () => { const c = await smsCfg(true); let balance = null, err = '';
            if (c.shared) return { configured: true, shared: true, sender: c.sender, hint: '', balance: null, error: '' }; // the shared account's token and balance stay private
            if (c.token) { try { const j = await usms('/balance', null, c.token); balance = j.data && (j.data.remaining_balance ?? j.data.balance ?? null); } catch (e) { err = e.message; } }
            return { configured: !!(c.token && c.sender), sender: c.sender, hint: c.token ? c.token.split('|')[0] + '|…' + c.token.slice(-4) : '', balance, error: err }; };
          if (req.method === 'GET') return send(res, 200, await info());
          const m = await json(req) || {};
          if (url.endsWith('/test')) {
            try { await sendSms(m.to, 'Test from ' + (((await shopMain(false)) || {}).set || {}).name + ': SMS receipts are working. Customers will get a thank-you SMS with a link to their receipt.'); serverLog('Test SMS sent', 'to ' + normPhone(m.to), st); return send(res, 200, { ok: true }); }
            catch (e) { return send(res, 400, { error: e.message }); }
          }
          const token = m.token === undefined ? null : String(m.token).replace(/\s+/g, ''), sender = m.sender === undefined ? null : String(m.sender).trim();
          console.log('sms: settings change by ' + st.name + (token ? ' (new token ' + token.split('|')[0] + '|…, ' + token.length + ' chars)' : '') + (sender !== null ? ' sender "' + sender + '"' : ''));
          if (token && !/^[0-9]+\|[A-Za-z0-9]{20,120}$/.test(token)) return send(res, 400, { error: 'That doesn’t look like a USMS-GH API token. It looks like 1234|AbCd… : copy it with the copy icon on the USMS-GH Developers page.' });
          if (sender !== null && sender && !/^[A-Za-z0-9 ]{2,11}$/.test(sender)) return send(res, 400, { error: 'The sender ID must be 2–11 letters or numbers (for example Renatelshop), exactly as approved in USMS-GH.' });
          if (token) { try { await usms('/balance', null, token); } catch (e) { return send(res, 400, { error: 'USMS-GH did not accept this token (' + e.message + '). Regenerate it in USMS-GH → Developers and copy it again.' }); } }
          try {
            if (token !== null) await sbCall('site_secret_set', { p_name: 'usms_token', p_value: token });
            if (sender !== null) await sbCall('site_secret_set', { p_name: 'usms_sender', p_value: sender });
          } catch (e) { console.error('sms save', e.message); return send(res, 502, { error: 'Could not save. Try again.' }); }
          serverLog('SMS settings changed', (token ? 'USMS-GH token saved · ' : token === '' ? 'token removed · ' : '') + (sender !== null ? 'sender ID “' + sender + '”' : ''), st);
          return send(res, 200, await info());
        }
        if (MULTI && url === '/api/store/admin/payouts') { // the shop's earnings from payments taken by the platform
          if (req.method === 'POST') {
            const m = await json(req) || {}, a = cleanAcct(m.acct);
            if (!a) return send(res, 400, { error: 'Fill in the account name and number, and the network or bank.' });
            await sbCall('shop_db_put', { p_col: 'platAcct', p_id: 'main', p_data: Object.assign(a, { by: st.name, at: Date.now() }) });
            serverLog('Payout account saved', a.kind + ' · ' + a.bank + ' · ' + a.name + ' · ' + a.number.slice(0, 3) + '•••' + a.number.slice(-3), st);
          }
          await freshKey(); return send(res, 200, await ledger());
        }
        if (url === '/api/store/admin/pay') {
          const host = 'https://' + String(req.headers['x-forwarded-host'] || req.headers.host || DEFHOST).split(',')[0].trim();
          const info = () => ({ mode: mode(), source: PK.src, pct: PK.src === 'platform' ? PK.pct : undefined, hint: PK.src === 'platform' ? '' : KEY() ? KEY().slice(0, 8) + '…' + KEY().slice(-4) : '', webhook: host + BASE() + '/api/store/paystack', callback: host + (MULTI ? BASE() + '/shop' : '/store') + '/done/' });
          await freshKey();
          if (req.method === 'GET') return send(res, 200, info());
          if (req.method === 'POST') {
            if (ENVKEY) return send(res, 409, { error: 'The key is set on the hosting, so it can’t be changed here.' });
            const m = await json(req), key = String(m && m.key || '').trim();
            console.log('payments: key ' + (key ? 'attempt (' + key.slice(0, 8) + '…, ' + key.length + ' chars)' : 'removal') + ' by ' + st.name);
            if (key && !/^sk_(test|live)_[A-Za-z0-9]{20,100}$/.test(key)) return send(res, 400, { error: 'That doesn’t look like a Paystack secret key. It starts with sk_live_ or sk_test_. (The public key pk_… is not needed.)' });
            if (key) {
              try { await paystack('/transaction?perPage=1', null, key); }
              catch (e) { console.log('payments: Paystack refused the key: ' + e.message); serverLog('Payment key refused', 'Paystack said: ' + e.message.replace(/^Paystack: /, '') + ' · ' + key.slice(0, 8) + '…', st); return send(res, 400, { error: 'Paystack did not accept this key (' + e.message.replace(/^Paystack: /, '') + '). Copy the Secret Key again from Paystack → Settings → API Keys & Webhooks.' }); }
            }
            try { await sbCall('site_secret_set', { p_name: 'paystack_secret', p_value: key }); } catch (e) { console.error('save key', e.message); return send(res, 502, { error: 'Could not save the key. Try again.' }); }
            await loadKey();
            serverLog(key ? 'Payments switched on' : 'Payments switched off', key ? 'Paystack ' + (key.startsWith('sk_live_') ? 'LIVE (real money)' : 'test mode') + ' key saved · ' + key.slice(0, 8) + '…' + key.slice(-4) : 'Paystack key removed · online shop back to test payments', st);
            return send(res, 200, info());
          }
        }
        if (req.method === 'GET' && url === '/api/store/admin/orders') {
          await listed('kum', true);
          const list = Object.entries(orderDocs).map(([ref, o]) => Object.assign(publicOrder(o, ref), { phone: o.phone, email: o.email || '', addr: o.addr || '', city: o.city || '', note: o.note || '', region: o.region || '',
            paidAt: o.paidAt || null, provider: (o.payment && o.payment.provider) || '', channel: (o.payment && o.payment.channel) || '', short: o.short || '', fulfilBy: o.fulfilBy || '', fulfilAt: o.fulfilAt || null }))
            .sort((a, b) => b.created - a.created).slice(0, 400);
          return send(res, 200, { orders: list, mode: mode() });
        }
        if (req.method === 'POST' && url === '/api/store/admin/order') {
          const m = await json(req), ref = m && String(m.ref || ''), f = m && String(m.fulfil || '');
          if (!REF_RX.test(ref) || !['', 'ready', 'done', 'refunded', 'cancelled'].includes(f)) return send(res, 400, { error: 'Unknown order or action.' });
          const o = await getOrder(ref); if (!o) return send(res, 404, { error: 'Order not found.' });
          if (f === 'cancelled' && o.status !== 'pending') return send(res, 400, { error: 'This order is paid. Refund the sale in Receipts instead.' });
          if (f === 'refunded' && o.status !== 'paid_short') return send(res, 400, { error: 'Only orders paid for a sold-out item are refunded here. Refund other sales in Receipts.' });
          if ((f === 'ready' || f === 'done') && o.status !== 'paid') return send(res, 400, { error: 'This order is not paid.' });
          o.fulfil = f; o.fulfilBy = st.name; o.fulfilAt = Date.now(); (o.hist = o.hist || []).push({ ts: Date.now(), by: st.name, f });
          await putOrder(ref, o); orderDocs[ref] = o;
          if (f === 'done' && o.mode === 'delivery' && o.dlvId) {
            const col = BR[brOf(o.branch)].pf + 'deliveries', mon = accraDay(o.paidAt || o.created).slice(0, 7);
            const docIds = o.dlvDoc ? [o.dlvDoc] : Array.from({ length: 50 }, (_, n) => mon + '_web_' + n);
            let was = '';
            for (const id of docIds) { const cur = await sbCall('shop_db_get', { p_col: col, p_id: id }); if (!cur) break; const r = (cur.recs || []).find((x) => x.id === o.dlvId); if (r) { was = r.status; r.status = 'Delivered'; r.deliveredTs = r.doneTs = Date.now(); await sbCall('shop_db_put', { p_col: col, p_id: id, p_data: cur }); break; } }
            const set = ((await shopMain(false)) || {}).set || {};
            if (was && was !== 'Delivered' && set.dlvDone !== false && normPhone(o.phone)) {
              const msg = fill('Hello {name}, your {shop} order{no} has been delivered to {addr}. Thank you for shopping with us!', { name: String(o.name || '').split(/\s+/)[0] || 'customer', shop: set.name || 'Renatel Shop', no: o.saleId ? ' #' + o.saleId : '', addr: [o.addr, o.city].filter(Boolean).join(', ').slice(0, 90) || 'your address' });
              sendSms(o.phone, msg).then(() => serverLog('Delivery SMS', 'order ' + ref + ' · customer told: delivered · to ' + mask(normPhone(o.phone)), st)).catch((e) => console.log('delivered sms: ' + e.message));
            }
          }
          const L = { '': 'back to new', ready: 'ready for ' + (o.mode === 'delivery' ? 'delivery' : 'pickup'), done: o.mode === 'delivery' ? 'delivered' : 'collected', refunded: 'refunded', cancelled: 'cancelled' };
          serverLog('Online order ' + (L[f] || f), (o.saleId ? 'receipt #' + o.saleId + ' · ' : '') + 'order ' + ref + ' · ' + o.name + ' ' + o.phone, st);
          return send(res, 200, { ok: true, fulfil: f });
        }
        if (req.method === 'GET' && url === '/api/store/admin/customers') {
          return send(res, 200, { customers: (await sbCall('web_acct_list', {})) || [] });
        }
        if (req.method === 'POST' && url === '/api/store/admin/customer') {
          const m = await json(req), ph = m && normPhone(m.phone);
          const a = ph ? await acctGet(ph) : null; if (!a) return send(res, 404, { error: 'Account not found.' });
          a.blocked = !!m.blocked; if (a.blocked) a.pwAt = Date.now(); // blocking also signs them out everywhere
          await acctPut(ph, a, false);
          serverLog(a.blocked ? 'Blocked online account' : 'Unblocked online account', a.name + ' · ' + ph, st);
          return send(res, 200, { ok: true, blocked: a.blocked });
        }
        return send(res, 404, { error: 'Not found.' });
      }
      // ---- accounts ----
      if (req.method === 'POST' && url === '/api/store/signup') {
        if (!allow(req, 10, 'su')) return send(res, 429, { error: 'Too many new accounts from here. Try again later.' });
        const m = await json(req); if (!m) return send(res, 400, { error: 'Not valid data.' });
        const name = String(m.name || '').trim().replace(/\s+/g, ' ').slice(0, 80), ph = normPhone(m.phone), email = String(m.email || '').trim().toLowerCase().slice(0, 120), pw = String(m.password || '');
        if (name.length < 2) return send(res, 400, { error: 'Enter your full name.', field: 'name' });
        if (!ph) return send(res, 400, { error: 'Enter a valid Ghana phone number, e.g. 024 000 0000.', field: 'phone' });
        if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return send(res, 400, { error: 'That email address doesn’t look right.', field: 'email' });
        if (pwRule(pw)) return send(res, 400, { error: pwRule(pw), field: 'password' });
        const a = { name, email, region: String(m.region || '').slice(0, 40), branch: brOf(m.branch), pw: await hashPw(pw), created: Date.now(), orders: [] };
        const r = await acctPut(ph, a, true);
        if (r && r.exists) return send(res, 409, { error: 'An account already uses this phone number. Sign in instead.', field: 'phone', exists: true });
        posCustomer(a.branch, ph, a).catch((e) => console.error('signup customer', e.message));
        console.log('store: new customer account ' + ph.slice(0, 3) + '•••' + ph.slice(-3));
        return send(res, 200, { token: ctoken(ph), me: profile(ph, a) });
      }
      if (req.method === 'POST' && url === '/api/store/login') {
        const m = await json(req); if (!m) return send(res, 400, { error: 'Not valid data.' });
        const ph = normPhone(m.phone);
        if (!allow(req, 20, 'li') || (ph && !allow({ headers: {}, socket: {} }, 15, 'lp' + ph))) return send(res, 429, { error: 'Too many tries. Wait a while, then try again.' });
        const a = ph ? await acctGet(ph) : null;
        if (!a || !(await checkPw(String(m.password || ''), a.pw))) return send(res, 401, { error: 'That phone number and password don’t match.' });
        if (a.blocked) return send(res, 403, { error: 'This account is blocked. Please call the shop.' });
        return send(res, 200, { token: ctoken(ph), me: profile(ph, a) });
      }
      if (url === '/api/store/me') {
        const c = await custOf(req); if (!c) return send(res, 401, { error: 'Please sign in again.' });
        if (req.method === 'GET') {
          const orders = [];
          for (const ref of (c.a.orders || []).slice(-15).reverse()) { const o = await getOrder(ref); if (o) orders.push(publicOrder(o, ref)); }
          await fresh(); const credit = [];
          for (const b of brKeys()) { const pc = Object.values(custDocs[b]).find((x) => x && normPhone(x.phone) === c.phone && +x.owed > 0.004); if (pc) { const ci = credInfo(b, pc), p = pendingClaim(b, pc.id); credit.push({ branch: BR[b].name, owed: ci.owed, due: ci.due ? dayStr(ci.due) : '', late: !!ci.due && ci.due < accraDay(Date.now()), link: BASE() + '/i/' + invCode(b, pc.id), pending: p ? p.amt : 0 }); } }
          return send(res, 200, { me: profile(c.phone, c.a), orders, credit });
        }
        if (req.method === 'POST') {
          const m = await json(req); if (!m) return send(res, 400, { error: 'Not valid data.' });
          const a = c.a, name = String(m.name || a.name).trim().slice(0, 80), email = String(m.email ?? a.email ?? '').trim().toLowerCase().slice(0, 120);
          if (name.length < 2) return send(res, 400, { error: 'Enter your full name.' });
          if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return send(res, 400, { error: 'That email address doesn’t look right.' });
          Object.assign(a, { name, email }); if (m.region !== undefined) a.region = String(m.region).slice(0, 40);
          let token;
          if (m.password) {
            if (!(await checkPw(String(m.oldPassword || ''), a.pw))) return send(res, 401, { error: 'Your current password is not right.' });
            if (pwRule(m.password)) return send(res, 400, { error: pwRule(m.password) });
            a.pw = await hashPw(m.password); a.pwAt = Date.now(); token = ctoken(c.phone);
          }
          await acctPut(c.phone, a, false);
          return send(res, 200, { me: profile(c.phone, a), token });
        }
      }
      if (req.method === 'POST' && url === '/api/store/reset/code') {
        const m = await json(req); const ph = m && normPhone(m.phone);
        if (!ph) return send(res, 400, { error: 'Enter the phone number of your account.' });
        if (!allow(req, 10, 'rc')) return send(res, 429, { error: 'Too many tries. Try again later.' });
        const a = await acctGet(ph), shop = await shopMain(false), nm = (shop && shop.set && shop.set.name) || 'Renatel Shop', sp = (shop && shop.set && shop.set.phone) || '';
        if (!a) return send(res, 404, { error: 'No account uses that phone number. Create an account instead.' });
        const sms = await smsReady(), via = m.via === 'email' || !sms ? 'email' : 'sms';
        if (via === 'email' && !a.email) return send(res, 400, { error: sms ? 'This account has no email. Choose “Text me a code” instead.' : 'This account has no email for a reset code.' + (sp ? ' Call the shop on ' + sp + ' for help.' : ' Call the shop for help.') });
        let code; try { code = await otpIssue('cust:' + ph); } catch (e) { return send(res, e.code || 502, { error: e.message }); }
        try {
          if (via === 'sms') await sendSms(ph, otpSms(nm, code));
          else await sendEmail({ to: [a.email], subject: nm + ' - your password reset code: ' + code, text: 'Hello ' + a.name + ',\n\nYour code to reset your ' + nm + ' online shop password is:\n\n    ' + code + '\n\nIt expires in 15 minutes. If you did not ask for this, ignore this email.' });
        } catch (e) { await sbCall('otp_mark', { p_k: 'cust:' + ph, p_try: false }); console.log('reset code ' + via + ': ' + e.message); return send(res, 502, { error: 'The code could not be sent' + (via === 'sms' ? ' by SMS' : ' by email') + '. Try again later.' }); }
        const [u, d] = String(a.email || '').split('@');
        return send(res, 200, { ok: true, via, to: via === 'sms' ? ph.slice(0, 3) + '•••' + ph.slice(-3) : u.slice(0, 2) + '•••@' + d, email: !!a.email, sms });
      }
      if (req.method === 'POST' && url === '/api/store/reset') {
        const m = await json(req); const ph = m && normPhone(m.phone), a = ph ? await acctGet(ph) : null;
        if (!a) return send(res, 400, { error: 'That code has expired. Send a new code.' });
        if (pwRule(m.password)) return send(res, 400, { error: pwRule(m.password) });
        const r = await otpCheck('cust:' + ph, m.code);
        if (r === 'expired') return send(res, 400, { error: 'That code has expired. Send a new code.' });
        if (r === 'locked') return send(res, 429, { error: 'Too many wrong codes. Send a new code.' });
        if (r !== 'ok') return send(res, 401, { error: r > 0 ? 'That code is not right. ' + r + (r === 1 ? ' try' : ' tries') + ' left.' : 'That code is not right, and that was the last try. Send a new code.' });
        a.pw = await hashPw(m.password); a.pwAt = Date.now(); delete a.rst; if (a.blocked) return send(res, 403, { error: 'This account is blocked. Please call the shop.' });
        await acctPut(ph, a, false);
        return send(res, 200, { token: ctoken(ph), me: profile(ph, a) });
      }
      if (req.method === 'POST' && url === '/api/store/order') {
        if (!allow(req, 15)) return send(res, 429, { error: 'Too many orders from here. Try again in an hour.' });
        await freshKey();
        const cust = await custOf(req);
        if (!cust) return send(res, 401, { error: 'Please create an account or sign in to check out.', auth: true });
        if (cust.blocked) return send(res, 403, { error: 'Your account is blocked. Please call the shop.' });
        const ss = storeSet(await shopMain(false));
        if (ss.open === false) return send(res, 403, { error: (ss.msg ? ss.msg + ' ' : '') + 'The online shop is not taking orders right now.' });
        const m = await json(req); if (!m) return send(res, 400, { error: 'Not valid data.' });
        const name = cust.a.name, phone = cust.phone, email = String(m.email || cust.a.email || '').trim().toLowerCase().slice(0, 120);
        const branch = brOf(m.branch), region = String(m.region || '').trim().slice(0, 40);
        const dmode = m.mode === 'delivery' ? 'delivery' : 'pickup', addr = String(m.addr || '').trim().slice(0, 200), city = String(m.city || '').trim().slice(0, 60), note = String(m.note || '').trim().slice(0, 300);
        if (!name) return send(res, 400, { error: 'Enter your name.' });
        if (phone.replace(/\D/g, '').length < 10) return send(res, 400, { error: 'Enter a valid phone number, e.g. 024 000 0000.' });
        if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return send(res, 400, { error: 'That email address doesn’t look right.' });
        if (dmode === 'delivery' && !addr) return send(res, 400, { error: 'Enter the delivery address or a landmark.' });
        if ((dmode === 'delivery' && ss.delivery === false) || (dmode === 'pickup' && ss.pickup === false)) return send(res, 400, { error: (dmode === 'delivery' ? 'Delivery' : 'Pickup') + ' is not available right now. Choose the other option.' });
        const want = new Map();
        for (const it of Array.isArray(m.items) ? m.items.slice(0, 50) : []) { const id = +it.id, n = Math.floor(+it.qty); if (id > 0 && n > 0) want.set(id, (want.get(id) || 0) + n); }
        if (!want.size) return send(res, 400, { error: 'Your cart is empty.' });
        const shop = await shopMain(false); CUR = (shop && shop.set && shop.set.cur) || CUR;
        const items = []; let total = 0;
        for (const [id, qty] of want) {
          const p = await getProd(branch, id);
          if (!forSale(p)) return send(res, 400, { error: 'One of the products is no longer sold online. Refresh the page.' });
          if (avail(p) < qty) return send(res, 409, { error: 'Only ' + avail(p) + ' × ' + p.name + ' left. Change the quantity.' });
          items.push({ id: p.id, name: p.name, price: p.price, qty }); total += p.price * qty;
        }
        total = r2(total);
        const ref = 'RS' + crypto.randomBytes(8).toString('hex').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10).padEnd(10, '0');
        const o = { status: 'pending', created: Date.now(), host: hostOf(req), branch, region, items, total, name, phone, email, acct: phone, mode: dmode, addr, city, note, pay: mode(), ip: clientIp(req) };
        if (PK.src === 'platform' && mode() !== 'test') { o.plat = true; o.feePct = PK.pct; } // paid into the platform's Paystack; paid out to the shop later
        await putOrder(ref, o);
        cust.a.orders = (cust.a.orders || []).concat(ref).slice(-50); if (region && !cust.a.region) cust.a.region = region;
        await acctPut(phone, cust.a, false);
        if (mode() === 'test') return send(res, 200, { ref, pay_url: (MULTI ? BASE() + '/shop' : '/store') + '/pay/' + ref });
        const host = 'https://' + String(req.headers['x-forwarded-host'] || req.headers.host || DEFHOST).split(',')[0].trim();
        const t = await paystack('/transaction/initialize', { email: email || phone.replace(/\D/g, '') + '@customers.' + DEFHOST, amount: Math.round(total * 100), currency: 'GHS', reference: ref,
          callback_url: host + (MULTI ? BASE() + '/shop' : '/store') + '/done/' + ref, channels: ['mobile_money', 'card'], metadata: Object.assign({ name, phone, shop_order: ref, branch }, MULTI ? { tessa: BASE().slice(1) } : {}) });
        return send(res, 200, { ref, pay_url: t.authorization_url });
      }
      const om = url.match(/^\/api\/store\/order\/(RS[A-Z0-9]{10})$/);
      if (req.method === 'GET' && om) {
        await freshKey();
        let o = await getOrder(om[1]);
        if (o && o.status === 'pending' && o.pay !== 'test' && (KEY() || o.plat)) { try { o = await verifyPaystack(om[1]); } catch (e) { console.error('verify', e.message); } }
        return o ? send(res, 200, publicOrder(o, om[1])) : send(res, 404, { error: 'Order not found.' });
      }
      if (req.method === 'POST' && url === '/api/store/testpay') {
        await freshKey();
        if (mode() !== 'test') return send(res, 403, { error: 'Test payments are off: real payments are switched on.' });
        const m = await json(req); const ref = m && String(m.ref || '');
        if (!REF_RX.test(ref)) return send(res, 400, { error: 'Unknown order.' });
        const o = await getOrder(ref); if (!o) return send(res, 404, { error: 'Order not found.' });
        if (!m.ok) { if (o.status === 'pending') { o.lastTry = 'failed (test)'; await putOrder(ref, o); } return send(res, 200, publicOrder(o, ref)); }
        const done = await finalize(ref, { provider: 'test', reference: ref });
        return send(res, 200, publicOrder(done, ref));
      }
      if (req.method === 'POST' && url === '/api/store/paystack') {
        // Paystack webhook: signed with the secret key. Records the sale even if the customer closes the page.
        await freshKey();
        const raw = await readBody(req), sig = String(req.headers['x-paystack-signature'] || '');
        const keys = [KEY()]; if (MULTI && d.sharedPay && PK.src !== 'platform') { const sp = await d.sharedPay(true); if (sp && sp.key) keys.push(sp.key); }
        const good = keys.filter(Boolean).some((k) => { const want = crypto.createHmac('sha512', k).update(raw).digest('hex'); return sig.length === want.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want)); });
        if (!good) return send(res, 401, { error: 'bad signature' });
        let ev; try { ev = JSON.parse(raw); } catch (e) { return send(res, 400, {}); }
        if (ev.event === 'charge.success' && ev.data && REF_RX.test(String(ev.data.reference))) {
          let found = null; try { found = await verifyPaystack(ev.data.reference); } catch (e) { console.error('webhook', e.message); }
          // Renatel's Paystack account also takes payments for Tessa POS shops: pass those on, signed as received.
          const md = ev.data.metadata || {}, slug = String(md.tessa || '');
          if (!MULTI && !found && /^[a-z0-9-]{3,40}$/.test(slug)) {
            const to = (process.env.TESSA_URL || 'https://tessapos.shop').replace(/\/+$/, '') + '/' + slug + '/api/store/paystack';
            fetch(to, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-paystack-signature': sig }, body: raw, signal: AbortSignal.timeout(20000) }).then((r) => console.log('webhook passed to ' + slug + ': ' + r.status)).catch((e) => console.error('webhook pass ' + slug, e.message));
          }
        }
        return send(res, 200, { ok: true });
      }
    } catch (e) {
      console.error('store', e.message);
      return send(res, 502, { error: 'The shop could not be reached. Try again in a moment.' });
    }
    return send(res, 404, { error: 'Not found.' });
  }

  // ---- platform payments (multi-shop): what the platform collected for this shop, its commission, and payouts ----
  const PO = 'platPayouts';
  function cleanAcct(a) {
    if (!a || typeof a !== 'object') return null;
    const t = (v, n) => String(v || '').trim().replace(/\s+/g, ' ').slice(0, n);
    const out = { kind: a.kind === 'bank' ? 'bank' : 'momo', bank: t(a.bank, 40), name: t(a.name, 60), number: t(a.number, 30).replace(/[^\d -]/g, ''), branch: t(a.branch, 40) };
    return out.bank && out.name && out.number.replace(/\D/g, '').length >= 8 ? out : null;
  }
  async function ledger() {
    await fresh();
    const [acct, pd] = await Promise.all([sbCall('shop_db_get', { p_col: 'platAcct', p_id: 'main' }), sbCall('shop_db_get', { p_col: PO, p_id: 'list' })]);
    const payouts = ((pd && pd.recs) || []).slice();
    const orders = Object.entries(orderDocs).filter(([, o]) => o && o.plat && (o.status === 'paid' || o.status === 'paid_short'))
      .map(([ref, o]) => ({ ref, at: o.paidAt, sale: o.saleId || null, name: o.name, total: r2(o.total), pct: +o.feePct || 0, fee: o.fee != null ? o.fee : r2(o.total * (+o.feePct || 0) / 100), net: o.net != null ? o.net : r2(o.total - r2(o.total * (+o.feePct || 0) / 100)) }))
      .sort((a, b) => b.at - a.at);
    const sum = (L, k) => r2(L.reduce((a, x) => a + (+x[k] || 0), 0));
    const collected = sum(orders, 'total'), fees = sum(orders, 'fee'), net = sum(orders, 'net'), paid = sum(payouts, 'amt');
    payouts.sort((a, b) => b.at - a.at);
    return { on: PK.src === 'platform', pct: PK.pct, collected, fees, net, paid, due: r2(net - paid), orders: orders.slice(0, 200), payouts: payouts.slice(0, 100), acct };
  }
  async function addPayout(p) {
    const amt = r2(+p.amt); if (!(amt > 0)) throw new Error('Enter the amount paid out.');
    const [id] = await sbCall('shop_ids', { p_n: 1 });
    const rec = { id, at: Date.now(), amt, method: String(p.method || '').slice(0, 30), ref: String(p.ref || '').slice(0, 60), note: String(p.note || '').slice(0, 120), by: String(p.by || 'Platform') };
    const cur = (await sbCall('shop_db_get', { p_col: PO, p_id: 'list' })) || { recs: [] };
    cur.recs = (cur.recs || []).concat(rec); await sbCall('shop_db_put', { p_col: PO, p_id: 'list', p_data: cur });
    serverLog('Payout received', CUR + ' ' + amt.toFixed(2) + ' paid to the shop by the platform' + (rec.method ? ' · ' + rec.method : '') + (rec.ref ? ' · ref ' + rec.ref : ''), { id: null, name: 'Platform' });
    return rec;
  }
  async function delPayout(id) { const cur = (await sbCall('shop_db_get', { p_col: PO, p_id: 'list' })) || { recs: [] }; cur.recs = (cur.recs || []).filter((x) => x.id !== Number(id)); await sbCall('shop_db_put', { p_col: PO, p_id: 'list', p_data: cur }); serverLog('Payout removed', 'record #' + id + ' removed by the platform', { id: null, name: 'Platform' }); }
  async function setAcct(a) { const c = cleanAcct(a); if (!c) throw new Error('Fill in the account name and number, and the network or bank.'); await sbCall('shop_db_put', { p_col: 'platAcct', p_id: 'main', p_data: Object.assign(c, { by: 'Platform', at: Date.now() }) }); return c; }

  function page(req, res, head, title) {
    try {
      if (!pageCache) pageCache = fs.readFileSync(PAGE);
      res.writeHead(200, Object.assign({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' }, HEADERS));
      // Multi-shop: the platform adds the shop's settings (window.STORE) and title to the page.
      const out = head ? pageCache.toString('utf8').replace('<head>', '<head>' + head).replace(/<title>[^<]*<\/title>/, '<title>' + String(title || '').replace(/[<&]/g, '') + '</title>') : pageCache;
      res.end(req.method === 'HEAD' ? undefined : out);
    } catch (e) { res.writeHead(500, { 'Content-Type': 'text/plain' }); res.end('The online shop page is missing.'); }
  }

  return { remindRun, smsReset: () => { SM.at = 0; }, payReset: () => { PK.at = 0; }, ledger, addPayout, delPayout, setAcct, api, page, receiptPage, invoicePage, isLive: () => mode() === 'paystack', sendSms, smsReady, otpIssue, otpCheck, otpSms, normPhone };
};
