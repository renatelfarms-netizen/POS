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
  // Shop settings kept in the POS (Settings saved in shop/main: set.store).
  const storeSet = (shop) => Object.assign({ open: true, msg: '', pickup: true, delivery: true, dnote: '' }, (shop && shop.set && shop.set.store) || {});
  // Staff permissions for the online shop: the owner has all; others as granted in Staff → Access (perms.web).
  const WEBP = ['orders', 'products', 'customers', 'settings'];
  const webCan = (st, k) => !!st && !st.locked && (st.role === 'owner' || !!(st.perms && st.perms.web && st.perms.web[k]));
  const BR = { kum: { pf: '', name: 'Kumasi branch', city: 'Kumasi' }, acc: { pf: 'accra_', name: 'Accra branch', city: 'Accra' } };
  const brOf = (b) => (BR[b] ? b : 'kum');
  // The Paystack key: from the hosting environment, or the one the owner saved in the POS (re-read every minute).
  const PK = { key: '', src: '', at: 0 };
  async function loadKey() {
    if (process.env.PAYSTACK_SECRET_KEY) { PK.key = process.env.PAYSTACK_SECRET_KEY; PK.src = 'hosting'; return; }
    if (!sbOn()) return;
    try { const v = await sbCall('site_secret_get', { p_name: 'paystack_secret' }); PK.key = v || ''; PK.src = v ? 'pos' : ''; PK.at = Date.now(); }
    catch (e) { console.error('paystack key', e.message); }
  }
  loadKey(); setInterval(loadKey, 60000).unref();
  // Before anything that depends on the payment mode, re-read the key if it is more than a few seconds old,
  // so every process switches to (or away from) Paystack together.
  const freshKey = async () => { if (!process.env.PAYSTACK_SECRET_KEY && Date.now() - PK.at > 3000) await loadKey(); };
  const KEY = () => PK.key;
  const PS_API = process.env.PAYSTACK_API || 'https://api.paystack.co';
  const mode = () => (KEY() ? (KEY().startsWith('sk_test_') ? 'paystack-test' : 'paystack') : 'test');
  const WHO = { id: null, name: 'Online shop' };
  const r2 = (n) => Math.round(n * 100) / 100;
  const accraDay = (t) => new Date(t).toLocaleDateString('en-CA', { timeZone: 'Africa/Accra' });
  const PAGE = path.join(__dirname, 'store.html');
  let pageCache = null;

  // ---- products ----
  // Product documents of both branches, kept up to date with the same change feed the tills use.
  const prodDocs = { kum: {}, acc: {} }, custDocs = { kum: {}, acc: {} }, orderDocs = {}; let prodRev = 0, prodAt = 0, prodBusy = null;
  async function refreshProducts() {
    let more = true;
    while (more) {
      const j = await sbCall('shop_db_pull', { p_since: prodRev });
      for (const x of j.docs || []) {
        if (x.c === 'webOrders') { if (x.x) delete orderDocs[x.id]; else orderDocs[x.id] = x.d; continue; }
        const b = x.c === 'products' || x.c === 'customers' ? 'kum' : x.c === 'accra_products' || x.c === 'accra_customers' ? 'acc' : null;
        const box = b && (x.c.endsWith('products') ? prodDocs : custDocs)[b];
        if (box) { if (x.x) delete box[x.id]; else box[x.id] = x.d; }
      }
      prodRev = j.rev; more = !!j.more;
    }
    prodAt = Date.now();
  }
  const forSale = (p) => p && !p.hideOnline && p.price > 0;
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
  const csecret = () => crypto.createHash('sha256').update('renatel-customer:' + (process.env.SUPABASE_BACKUP_TOKEN || '')).digest();
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
    await putOrder(ref, o);
    prodAt = 0;
    serverLog('Sale', '#' + saleId + ' · ' + money(o.total) + ' · Online (' + via + ') · ' + BR[b].name + ' · ' + o.name + ' ' + o.phone + (o.region ? ' (' + o.region + ')' : '') + ' · ' + (o.mode === 'delivery' ? 'delivery' : 'pickup') + ' · order ' + ref, WHO);
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
    const t = await paystack('/transaction/verify/' + encodeURIComponent(ref));
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
      if (req.method === 'GET' && url === '/api/store/info') {
        await freshKey();
        const shop = await shopMain(false), set = (shop && shop.set) || {}; CUR = set.cur || CUR;
        const b = brOf(new URL(req.url, 'http://x').searchParams.get('b')), names = set.brNames || {};
        const list = await listed(b, false);
        const ss = storeSet(shop);
        return send(res, 200, { store: { open: ss.open !== false, msg: ss.msg || '', pickup: ss.pickup !== false, delivery: ss.delivery !== false, dnote: ss.dnote || '' }, name: set.name || 'Renatel Shop', phone: set.phone || '', addr: b === 'kum' ? set.addr || '' : '', city: BR[b].city, cur: set.cur || 'GH₵', mode: mode(),
          branch: b, branches: Object.fromEntries(Object.entries(BR).map(([k, v]) => [k, { name: names[k] || v.name, city: v.city }])),
          products: list.map((p) => ({ id: p.id, name: p.name, cat: p.cat || '', unit: p.unit || 'pcs', price: p.price, left: Math.max(0, p.stock || 0), img: /^[a-f0-9]{24}$/.test(p.img || '') ? p.img : '' })).sort((x, y) => x.name.localeCompare(y.name)) });
      }
      // ---- POS: online shop management (logged-in staff with the right permission) ----
      if (url.startsWith('/api/store/admin/')) {
        const who = await caller(req);
        if (who.err) return send(res, who.err[0], { error: who.err[1] });
        const st = who.staff, need = url.includes('/order') ? 'orders' : url.includes('/customer') ? 'customers' : url.endsWith('/pay') ? 'pay' : '';
        if (!st || (need === 'pay' ? st.role !== 'owner' || st.locked : !webCan(st, need))) return send(res, 403, { error: need === 'pay' ? 'Only the owner can change payment settings.' : 'You don’t have access to this part of the online shop. Ask the owner.' });
        if (url === '/api/store/admin/pay') {
          const host = 'https://' + String(req.headers['x-forwarded-host'] || req.headers.host || 'renatel.shop').split(',')[0].trim();
          const info = () => ({ mode: mode(), source: PK.src, hint: KEY() ? KEY().slice(0, 8) + '…' + KEY().slice(-4) : '', webhook: host + '/api/store/paystack', callback: host + '/store/done/' });
          if (req.method === 'GET') return send(res, 200, info());
          if (req.method === 'POST') {
            if (process.env.PAYSTACK_SECRET_KEY) return send(res, 409, { error: 'The key is set on the hosting, so it can’t be changed here.' });
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
            for (const id of docIds) { const cur = await sbCall('shop_db_get', { p_col: col, p_id: id }); if (!cur) break; const r = (cur.recs || []).find((x) => x.id === o.dlvId); if (r) { r.status = 'Delivered'; r.deliveredTs = Date.now(); await sbCall('shop_db_put', { p_col: col, p_id: id, p_data: cur }); break; } }
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
          return send(res, 200, { me: profile(c.phone, c.a), orders });
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
        const a = await acctGet(ph), shop = await shopMain(false), sp = (shop && shop.set && shop.set.phone) || '';
        if (!a) return send(res, 404, { error: 'No account uses that phone number. Create an account instead.' });
        if (!a.email) return send(res, 400, { error: 'This account has no email for a reset code.' + (sp ? ' Call the shop on ' + sp + ' for help.' : ' Call the shop for help.') });
        const prev = a.rst; if (prev && Date.now() - prev.sent < 60000) return send(res, 429, { error: 'A code was sent less than a minute ago. Check your email (and spam).' });
        const code = String(100000 + crypto.randomInt(900000));
        a.rst = { h: crypto.createHash('sha256').update('c:' + code).digest('hex'), exp: Date.now() + 15 * 60000, tries: 0, sent: Date.now() };
        await acctPut(ph, a, false);
        const nm = (shop && shop.set && shop.set.name) || 'Renatel Shop';
        try { await sendEmail({ to: [a.email], subject: nm + ' - your password reset code: ' + code, text: 'Hello ' + a.name + ',\n\nYour code to reset your ' + nm + ' online shop password is:\n\n    ' + code + '\n\nIt expires in 15 minutes. If you did not ask for this, ignore this email.' }); }
        catch (e) { delete a.rst; await acctPut(ph, a, false); return send(res, 502, { error: 'The code email could not be sent. Try again later.' }); }
        const [u, d] = a.email.split('@');
        return send(res, 200, { ok: true, to: u.slice(0, 2) + '•••@' + d });
      }
      if (req.method === 'POST' && url === '/api/store/reset') {
        const m = await json(req); const ph = m && normPhone(m.phone), a = ph ? await acctGet(ph) : null, rc = a && a.rst;
        if (!rc || rc.exp < Date.now()) return send(res, 400, { error: 'That code has expired. Send a new code.' });
        if (rc.tries >= 5) { delete a.rst; await acctPut(ph, a, false); return send(res, 429, { error: 'Too many wrong codes. Send a new code.' }); }
        if (crypto.createHash('sha256').update('c:' + String(m.code || '').replace(/\D/g, '')).digest('hex') !== rc.h) { rc.tries++; await acctPut(ph, a, false); return send(res, 401, { error: 'That code is not right.' }); }
        if (pwRule(m.password)) return send(res, 400, { error: pwRule(m.password) });
        a.pw = await hashPw(m.password); a.pwAt = Date.now(); delete a.rst; await acctPut(ph, a, false);
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
          if ((p.stock || 0) < qty) return send(res, 409, { error: 'Only ' + Math.max(0, p.stock || 0) + ' × ' + p.name + ' left. Change the quantity.' });
          items.push({ id: p.id, name: p.name, price: p.price, qty }); total += p.price * qty;
        }
        total = r2(total);
        const ref = 'RS' + crypto.randomBytes(8).toString('hex').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10).padEnd(10, '0');
        const o = { status: 'pending', created: Date.now(), branch, region, items, total, name, phone, email, acct: phone, mode: dmode, addr, city, note, pay: mode(), ip: clientIp(req) };
        await putOrder(ref, o);
        cust.a.orders = (cust.a.orders || []).concat(ref).slice(-50); if (region && !cust.a.region) cust.a.region = region;
        await acctPut(phone, cust.a, false);
        if (mode() === 'test') return send(res, 200, { ref, pay_url: '/store/pay/' + ref });
        const host = 'https://' + String(req.headers['x-forwarded-host'] || req.headers.host || 'renatel.shop').split(',')[0].trim();
        const t = await paystack('/transaction/initialize', { email: email || phone.replace(/\D/g, '') + '@customers.renatel.shop', amount: Math.round(total * 100), currency: 'GHS', reference: ref,
          callback_url: host + '/store/done/' + ref, channels: ['mobile_money', 'card'], metadata: { name, phone, shop_order: ref, branch } });
        return send(res, 200, { ref, pay_url: t.authorization_url });
      }
      const om = url.match(/^\/api\/store\/order\/(RS[A-Z0-9]{10})$/);
      if (req.method === 'GET' && om) {
        await freshKey();
        let o = await getOrder(om[1]);
        if (o && o.status === 'pending' && o.pay !== 'test' && KEY()) { try { o = await verifyPaystack(om[1]); } catch (e) { console.error('verify', e.message); } }
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
        const want = KEY() ? crypto.createHmac('sha512', KEY()).update(raw).digest('hex') : '';
        if (!want || sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return send(res, 401, { error: 'bad signature' });
        let ev; try { ev = JSON.parse(raw); } catch (e) { return send(res, 400, {}); }
        if (ev.event === 'charge.success' && ev.data && REF_RX.test(String(ev.data.reference))) { try { await verifyPaystack(ev.data.reference); } catch (e) { console.error('webhook', e.message); } }
        return send(res, 200, { ok: true });
      }
    } catch (e) {
      console.error('store', e.message);
      return send(res, 502, { error: 'The shop could not be reached. Try again in a moment.' });
    }
    return send(res, 404, { error: 'Not found.' });
  }

  function page(req, res) {
    try {
      if (!pageCache) pageCache = fs.readFileSync(PAGE);
      res.writeHead(200, Object.assign({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' }, HEADERS));
      res.end(req.method === 'HEAD' ? undefined : pageCache);
    } catch (e) { res.writeHead(500, { 'Content-Type': 'text/plain' }); res.end('The online shop page is missing.'); }
  }

  return { api, page, isLive: () => mode() === 'paystack' };
};
