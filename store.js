'use strict';
// Online shop for renatel.shop/store.
// Customers pick products, pay online, and the server records the sale in the POS exactly like a till sale:
//   - stock is deducted from the product (same `stock` field the tills use)
//   - a sale record is added (seller: "Online shop", method: "Online")
//   - a stock move is logged ("Online order #…") and an activity-trail entry is written
//   - a delivery job is created when the customer chose delivery
// Every product with a price is listed, unless the owner ticked "Hide from the online shop" (product.hideOnline).
// Each customer is served by the branch nearest to them (Kumasi or Accra), chosen in the page from their region
// or their phone's location; that branch's products and stock are shown, and the sale is recorded there.
//
// Payments
//   PAYSTACK_SECRET_KEY set   -> Paystack checkout (MoMo and cards). A sk_test_ key uses Paystack test mode.
//   not set                   -> built-in TEST payment screen: no money moves, but stock and sales are real.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

module.exports = function store(d) {
  const { sbCall, sbOn, send, readBody, serverLog, shopMain, clientIp, sendEmail, HEADERS } = d;
  const BR = { kum: { pf: '', name: 'Kumasi branch', city: 'Kumasi' }, acc: { pf: 'accra_', name: 'Accra branch', city: 'Accra' } };
  const brOf = (b) => (BR[b] ? b : 'kum');
  const KEY = () => process.env.PAYSTACK_SECRET_KEY || '';
  const mode = () => (KEY() ? (KEY().startsWith('sk_test_') ? 'paystack-test' : 'paystack') : 'test');
  const WHO = { id: null, name: 'Online shop' };
  const r2 = (n) => Math.round(n * 100) / 100;
  const accraDay = (t) => new Date(t).toLocaleDateString('en-CA', { timeZone: 'Africa/Accra' });
  const PAGE = path.join(__dirname, 'store.html');
  let pageCache = null;

  // ---- products ----
  // Product documents of both branches, kept up to date with the same change feed the tills use.
  const prodDocs = { kum: {}, acc: {} }; let prodRev = 0, prodAt = 0, prodBusy = null;
  async function refreshProducts() {
    let more = true;
    while (more) {
      const j = await sbCall('shop_db_pull', { p_since: prodRev });
      for (const x of j.docs || []) {
        const b = x.c === 'products' ? 'kum' : x.c === 'accra_products' ? 'acc' : null;
        if (b) { if (x.x) delete prodDocs[b][x.id]; else prodDocs[b][x.id] = x.d; }
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

  // ---- orders (kept in their own collection; the tills ignore it) ----
  const ORD = 'webOrders';
  const getOrder = (ref) => sbCall('shop_db_get', { p_col: ORD, p_id: ref });
  const putOrder = (ref, o) => sbCall('shop_db_put', { p_col: ORD, p_id: ref, p_data: o });
  const publicOrder = (o, ref) => ({ ref, branch: o.branch, branchName: (BR[o.branch] || BR.kum).name, status: o.status, items: o.items.map((i) => ({ name: i.name, qty: i.qty, price: i.price })), total: o.total, name: o.name, mode: o.mode, saleId: o.saleId || null, created: o.created, pay: o.pay || mode() });

  // Append one record to a list document ({recs:[...]}) the way the tills do: up to 300 per document.
  async function appendRec(col, base, rec) {
    for (let n = 0; n < 50; n++) {
      const id = base + '_web_' + n, cur = await sbCall('shop_db_get', { p_col: col, p_id: id });
      const recs = cur && Array.isArray(cur.recs) ? cur.recs : [];
      if (recs.length >= 300) continue;
      recs.push(Object.assign({ _c: id }, rec));
      await sbCall('shop_db_put', { p_col: col, p_id: id, p_data: { recs } });
      return;
    }
    throw new Error('no room in ' + col);
  }

  // Record a paid order in the POS. One at a time, so two orders can never sell the same last item.
  let q = Promise.resolve();
  function finalize(ref, pay) { const job = q.then(() => finalizeNow(ref, pay)); q = job.catch(() => {}); return job; }
  async function finalizeNow(ref, pay) {
    const o = await getOrder(ref);
    if (!o) throw new Error('order not found');
    if (o.status !== 'pending') return o;
    const b = brOf(o.branch), PF = BR[b].pf;
    const prods = [];
    for (const it of o.items) {
      const p = await getProd(b, it.id);
      if (!p || (p.stock || 0) < it.qty) {
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
    // 1. deduct stock (fresh copy of each product, only the stock changes)
    for (const [p, it] of prods) {
      p.stock = (p.stock || 0) - it.qty;
      await sbCall('shop_db_put', { p_col: PF + 'products', p_id: 'p' + p.id, p_data: p });
      await appendRec(PF + 'moves', accraDay(now).slice(0, 7), { ts: now, pid: p.id, name: p.name, qty: -it.qty, reason: 'Online order #' + saleId, by: 'Online shop' });
    }
    // 2. the sale, shaped like a till sale
    const items = prods.map(([p, it]) => ({ id: p.id, name: p.name, price: it.price, cost: p.cost || 0, qty: it.qty, disc: 0 }));
    const tax = set.tax ? o.total * set.tax / (100 + set.tax) : 0;
    const sale = { id: saleId, ts: now, items, sub: o.total, disc: 0, sdisc: 0, total: o.total, method: 'Online', pays: [{ m: 'Online', amt: o.total }], tend: null, change: null,
      cust: null, custName: o.name, by: null, byName: 'Online shop', tax, taxRate: set.tax || 0, refunds: [], dfee: 0,
      online: { ref, phone: o.phone, email: o.email || '', mode: o.mode, region: o.region || '', provider: pay.provider, payRef: pay.reference || ref } };
    // 3. delivery job if asked
    if (o.mode === 'delivery') {
      const dl = { id: ids[1], ts: now, sale: saleId, name: o.name, phone: o.phone, addr: o.addr, region: o.region || '', city: o.city || '', gps: '', note: ('Online order ' + ref + '. ' + (o.note || '')).trim(),
        items: items.map((i) => i.qty + ' × ' + i.name).join(', '), fee: 0, rider: null, status: 'Pending', by: 'Online shop', byId: null, when: '', cod: 0, codPaid: false };
      sale.dlv = dl.id;
      await appendRec(PF + 'deliveries', accraDay(now).slice(0, 7), dl);
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
  async function paystack(pathname, body) {
    const r = await fetch('https://api.paystack.co' + pathname, { method: body ? 'POST' : 'GET', headers: { Authorization: 'Bearer ' + KEY(), 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000) });
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
  function allow(req, max) { const k = clientIp(req), h = hits.get(k) || { n: 0, at: Date.now() }; if (Date.now() - h.at > 3600e3) { h.n = 0; h.at = Date.now(); } h.n++; hits.set(k, h); return h.n <= max; }
  setInterval(() => { const t = Date.now(); for (const [k, v] of hits) if (t - v.at > 3600e3) hits.delete(k); }, 600000).unref();
  const json = async (req) => { try { return JSON.parse(await readBody(req)); } catch (e) { return null; } };
  const REF_RX = /^RS[A-Z0-9]{10}$/;

  async function api(req, res, url) {
    if (!sbOn()) return send(res, 503, { error: 'The online shop is not set up yet.' });
    try {
      if (req.method === 'GET' && url === '/api/store/info') {
        const shop = await shopMain(false), set = (shop && shop.set) || {}; CUR = set.cur || CUR;
        const b = brOf(new URL(req.url, 'http://x').searchParams.get('b')), names = set.brNames || {};
        const list = await listed(b, false);
        return send(res, 200, { name: set.name || 'Renatel Shop', phone: set.phone || '', addr: b === 'kum' ? set.addr || '' : '', city: BR[b].city, cur: set.cur || 'GH₵', mode: mode(),
          branch: b, branches: Object.fromEntries(Object.entries(BR).map(([k, v]) => [k, { name: names[k] || v.name, city: v.city }])),
          products: list.map((p) => ({ id: p.id, name: p.name, cat: p.cat || '', unit: p.unit || 'pcs', price: p.price, left: Math.max(0, p.stock || 0), img: /^[a-f0-9]{24}$/.test(p.img || '') ? p.img : '' })).sort((x, y) => x.name.localeCompare(y.name)) });
      }
      if (req.method === 'POST' && url === '/api/store/order') {
        if (!allow(req, 15)) return send(res, 429, { error: 'Too many orders from here. Try again in an hour.' });
        const m = await json(req); if (!m) return send(res, 400, { error: 'Not valid data.' });
        const name = String(m.name || '').trim().slice(0, 80), phone = String(m.phone || '').replace(/[^\d+]/g, '').slice(0, 16), email = String(m.email || '').trim().toLowerCase().slice(0, 120);
        const branch = brOf(m.branch), region = String(m.region || '').trim().slice(0, 40);
        const dmode = m.mode === 'delivery' ? 'delivery' : 'pickup', addr = String(m.addr || '').trim().slice(0, 200), city = String(m.city || '').trim().slice(0, 60), note = String(m.note || '').trim().slice(0, 300);
        if (!name) return send(res, 400, { error: 'Enter your name.' });
        if (phone.replace(/\D/g, '').length < 10) return send(res, 400, { error: 'Enter a valid phone number, e.g. 024 000 0000.' });
        if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return send(res, 400, { error: 'That email address doesn’t look right.' });
        if (dmode === 'delivery' && !addr) return send(res, 400, { error: 'Enter the delivery address or a landmark.' });
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
        const o = { status: 'pending', created: Date.now(), branch, region, items, total, name, phone, email, mode: dmode, addr, city, note, pay: mode(), ip: clientIp(req) };
        await putOrder(ref, o);
        if (mode() === 'test') return send(res, 200, { ref, pay_url: '/store/pay/' + ref });
        const host = 'https://' + String(req.headers['x-forwarded-host'] || req.headers.host || 'renatel.shop').split(',')[0].trim();
        const t = await paystack('/transaction/initialize', { email: email || phone.replace(/\D/g, '') + '@customers.renatel.shop', amount: Math.round(total * 100), currency: 'GHS', reference: ref,
          callback_url: host + '/store/done/' + ref, channels: ['mobile_money', 'card'], metadata: { name, phone, shop_order: ref, branch } });
        return send(res, 200, { ref, pay_url: t.authorization_url });
      }
      const om = url.match(/^\/api\/store\/order\/(RS[A-Z0-9]{10})$/);
      if (req.method === 'GET' && om) {
        let o = await getOrder(om[1]);
        if (o && o.status === 'pending' && o.pay !== 'test' && KEY()) { try { o = await verifyPaystack(om[1]); } catch (e) { console.error('verify', e.message); } }
        return o ? send(res, 200, publicOrder(o, om[1])) : send(res, 404, { error: 'Order not found.' });
      }
      if (req.method === 'POST' && url === '/api/store/testpay') {
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

  return { api, page };
};
