'use strict';
// Server-side protection for the shop's main record (shop/main): the staff list and security settings.
// The page hides staff and settings from roles that may not use them; this enforces the same rules on
// the server, so a logged-in staff member can't change them by calling the API directly.
//
// 1. hide(): before shop/main is sent to a device, other people's password hashes, reset codes and the
//    recovery code are replaced with a placeholder. Logins and resets are checked on the server, so the
//    page never needs them. Each person still gets their own hash (used to check "current password").
// 2. guard(): when a device saves shop/main, placeholders are swapped back for the real values, and any
//    change the caller is not allowed to make is undone (the rest of the save goes through):
//      - only the owner (or the shop code) adds or removes staff, or changes anyone's role, access,
//        permissions or branch, and only the owner changes security settings (recovery code, sign out
//        everyone, password rules, auto-lock, discount limit, report recipients, branches);
//      - everyone may change their own details and password;
//      - a manager may also reset the password and contact details of, and unlock, staff below manager
//        (the same rule as canApprove in index.html);
//      - anyone may record failed tries or lock an account (that is what wrong passwords do).

const HID = 'p2$hidden$0', HID_OLD = 'old$hidden';
const isHid = (v) => v === HID || v === HID_OLD;
const SECRET_KEYS = ['pin', 'rst'];
const OWNER_ONLY_STAFF = ['role', 'access', 'perms', 'branch'];
const OWNER_ONLY_SET = ['rc', 'sessEpoch', 'strongPw', 'idleMin', 'maxDisc', 'rcpts', 'branches', 'brNames'];
const FREE = ['fails', 'nextTry'];
// The page fills these in with its defaults when a shop has never set them (index.html: DEF); that is not a change.
const SET_DEFAULTS = { maxDisc: 20, rcpts: [] };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const clone = (o) => JSON.parse(JSON.stringify(o));

function hide(doc, me) {
  if (!doc || typeof doc !== 'object') return doc;
  const out = Object.assign({}, doc);
  if (Array.isArray(doc.staff)) {
    out.staff = doc.staff.map((s) => {
      if (!s || (me && s.id === me.id)) return s;
      const t = Object.assign({}, s);
      if (t.pin) t.pin = String(t.pin).startsWith('p2$') ? HID : HID_OLD;
      if (t.rst) t.rst = HID;
      return t;
    });
  }
  if (doc.set && doc.set.rc) out.set = Object.assign({}, doc.set, { rc: HID });
  return out;
}

// me: the logged-in staff member, or null for a device using the shop code (treated like the owner).
// Returns { doc, blocked: [what was undone] }.
function guard(cur, next, me) {
  const doc = clone(next), blocked = [];
  const curStaff = (cur && Array.isArray(cur.staff)) ? cur.staff : [];
  const byId = new Map(curStaff.map((s) => [s.id, s]));
  // put the real secrets back where the device sent placeholders
  if (Array.isArray(doc.staff)) {
    for (const s of doc.staff) {
      if (!s) continue;
      const c = byId.get(s.id);
      for (const k of SECRET_KEYS) if (isHid(s[k])) { if (c && c[k] !== undefined) s[k] = c[k]; else delete s[k]; }
    }
  }
  if (doc.set && isHid(doc.set.rc)) { if (cur && cur.set && cur.set.rc) doc.set.rc = cur.set.rc; else delete doc.set.rc; }
  const owner = !me || me.role === 'owner';
  if (owner || !cur) {
    if (!owner && !cur) blocked.push('set up the shop'); // never happens with a working shop; keep the doc as sent
    return { doc, blocked };
  }

  // ---- staff list ----
  const nextStaff = Array.isArray(doc.staff) ? doc.staff : [];
  const nextIds = new Set(nextStaff.filter(Boolean).map((s) => s.id));
  const kept = [];
  for (const s of nextStaff) {
    if (!s) continue;
    const c = byId.get(s.id);
    if (!c) { blocked.push('add staff member ' + String(s.name || s.id).slice(0, 40)); continue; }
    const self = s.id === me.id;
    const below = me.role === 'manager' && !['owner', 'manager'].includes(c.role);
    const keys = new Set(Object.keys(s).concat(Object.keys(c)));
    for (const k of keys) {
      if (same(s[k], c[k])) continue;
      let ok;
      if (OWNER_ONLY_STAFF.includes(k)) ok = false;
      else if (FREE.includes(k)) ok = true;
      else if (k === 'locked') ok = s[k] === true || below; // anyone may lock; unlocking needs a manager over that person
      else ok = self || below;
      if (!ok) {
        blocked.push(k + ' of ' + String(c.name || c.id).slice(0, 40));
        if (c[k] === undefined) delete s[k]; else s[k] = clone(c[k]);
      }
    }
    kept.push(s);
  }
  for (const c of curStaff) if (c && !nextIds.has(c.id)) { blocked.push('remove staff member ' + String(c.name || c.id).slice(0, 40)); kept.push(clone(c)); }
  if (Array.isArray(doc.staff) || curStaff.length) doc.staff = kept;

  // ---- security settings ----
  const cs = (cur && cur.set) || {};
  doc.set = doc.set && typeof doc.set === 'object' ? doc.set : {};
  for (const k of OWNER_ONLY_SET) {
    if (same(doc.set[k], cs[k])) continue;
    if (cs[k] === undefined && k in SET_DEFAULTS && same(doc.set[k], SET_DEFAULTS[k])) continue;
    blocked.push('setting ' + k);
    if (cs[k] === undefined) delete doc.set[k]; else doc.set[k] = clone(cs[k]);
  }
  return { doc, blocked };
}

// ---------------------------------------------------------------------------------------------------
// 3. records(): the same idea for everything else a device saves (sales, stock, expenses, customers,
//    stock movements and the activity trail). Rules follow what the page lets each role do; a change
//    the caller may not make is undone and the rest of the save goes through.
//      - activity trail (log): nobody but the owner can remove or change entries; everyone adds.
//      - stock movements (moves, whMoves): only the owner or a manager removes or changes entries.
//      - sales: deleting a sale needs the owner or "may delete" permission (canDel in index.html);
//        changing items, prices, totals, discounts, date, seller or customer needs the owner, a
//        manager or "may edit sales" (canEditSale); refunds already given can't be removed or changed
//        except by them; others may add refunds (a cancelled delivery) and settle pay-on-delivery.
//      - expenses: only the owner, a manager or the accountant (or staff given Expenses/Purchases)
//        changes or removes them; everyone may add.
//      - products: cashiers and delivery staff (no stock, purchases or warehouse access) may only
//        change the stock count; they can't change prices or delete products.
//      - customers: only staff with Customers access delete a customer or lower what they owe.
//      - deleting a whole record: only the owner or a manager (and sales only with delete permission).
const ROLE_TABS = {
  owner: ['home', 'sell', 'docs', 'cust', 'del', 'inv', 'po', 'wh', 'web', 'exp', 'rep', 'staff', 'set'],
  manager: ['home', 'sell', 'docs', 'cust', 'del', 'inv', 'po', 'wh', 'exp', 'rep'],
  accountant: ['home', 'docs', 'cust', 'po', 'exp', 'rep'],
  cashier: ['home', 'sell', 'docs'],
  warehouse: ['home', 'wh'],
  stock: ['home', 'inv', 'po'],
  delivery: ['home', 'del']
};
const tabsOf = (me) => me.role === 'owner' ? ROLE_TABS.owner : Array.isArray(me.access) ? me.access : (ROLE_TABS[me.role] || []);
const has = (me, t) => tabsOf(me).includes(t);
const trusted = (me) => !me || me.role === 'owner' || me.role === 'manager';
const canDel = (me) => !me || me.role === 'owner' || !!(me.perms && me.perms.del);
const canEditSale = (me) => trusted(me) || !!(me.perms && me.perms.edit);
const key = (r) => (r && r.id != null ? 'id:' + r.id : 'j:' + JSON.stringify(r));
const SALE_CORE = ['id', 'ts', 'items', 'sub', 'disc', 'sdisc', 'total', 'tax', 'taxRate', 'dfee', 'by', 'byName', 'cust', 'custName', 'edits'];
const sum = (L) => Math.round((L || []).reduce((t, p) => t + (+p.amt || 0), 0) * 100) / 100;

// Merge the records of one chunk ({recs:[...]}) by rule. fix(old, neu) returns the record to keep
// (neu, or a repaired copy) or pushes to blocked; removed(old) says whether removing it is allowed.
function mergeRecs(cur, next, fix, mayRemove, blocked, what) {
  const old = (cur && Array.isArray(cur.recs)) ? cur.recs : [], neu = (next && Array.isArray(next.recs)) ? next.recs : [];
  const oldBy = new Map(old.map((r) => [key(r), r])), seen = new Set(), out = [];
  for (const r of neu) {
    const k = key(r), o = oldBy.get(k);
    if (o === undefined && k.startsWith('j:')) { out.push(r); continue; } // a new entry
    if (o === undefined) { out.push(r); continue; }
    seen.add(k);
    out.push(same(o, r) ? r : fix(o, r));
  }
  for (const o of old) {
    const k = key(o);
    if (seen.has(k) || (k.startsWith('j:') && neu.some((r) => same(r, o)))) continue;
    if (mayRemove(o)) continue;
    blocked.push('remove ' + what + (o.id != null ? ' #' + o.id : ''));
    out.push(clone(o));
  }
  return Object.assign({}, next, { recs: out });
}

// col: the collection without a branch prefix. Returns { doc, blocked } (doc null = allow the delete).
function records(col, cur, next, me) {
  const blocked = [];
  if (!me || me.role === 'owner') return { doc: next, blocked };
  const del = next === null;
  if (del) {
    if (!cur || ['devices', 'trReq', 'mailed'].includes(col)) return { doc: null, blocked };
    const ok = trusted(me) && (col !== 'sales' || canDel(me)) && col !== 'log';
    if (ok) return { doc: null, blocked };
    blocked.push('delete ' + col + ' record'); return { doc: clone(cur), blocked };
  }
  if (!cur) return { doc: next, blocked }; // something new
  const undo = (what) => (o) => { blocked.push('change ' + what + (o.id != null ? ' #' + o.id : '')); return clone(o); };
  if (col === 'log') return { doc: mergeRecs(cur, next, undo('activity entry'), () => false, blocked, 'activity entry'), blocked };
  if (col === 'moves' || col === 'whMoves') {
    if (trusted(me)) return { doc: next, blocked };
    return { doc: mergeRecs(cur, next, undo('stock movement'), () => false, blocked, 'stock movement'), blocked };
  }
  if (col === 'sales') {
    const doc = mergeRecs(cur, next, (o, r) => {
      if (canEditSale(me)) {
        // editing a sale is allowed, but past refunds stay unless the person may delete
        return r;
      }
      const t = clone(r), bad = [];
      for (const k of SALE_CORE) if (!same(o[k], r[k])) { bad.push(k); if (o[k] === undefined) delete t[k]; else t[k] = clone(o[k]); }
      const ro = o.refunds || [], rn = Array.isArray(r.refunds) ? r.refunds : [];
      if (!same(ro, rn.slice(0, ro.length))) { bad.push('refunds'); t.refunds = clone(ro); }
      if (!same(o.pays, r.pays) || o.method !== r.method) { // only settling pay-on-delivery, for the same amount
        const cod = (o.pays || []).some((p) => p.m === 'On delivery'), same$ = sum(o.pays || [{ amt: o.total }]) === sum(r.pays || [{ amt: r.total }]);
        if (!(cod && same$)) { bad.push('payment'); t.pays = clone(o.pays); if (o.method === undefined) delete t.method; else t.method = o.method; }
      }
      if (bad.length) blocked.push('change sale #' + o.id + ' (' + bad.join(', ') + ')');
      return t;
    }, () => canDel(me), blocked, 'sale');
    return { doc, blocked };
  }
  if (col === 'expenses') {
    if (trusted(me) || has(me, 'exp') || has(me, 'po')) return { doc: next, blocked };
    return { doc: mergeRecs(cur, next, undo('expense'), () => false, blocked, 'expense'), blocked };
  }
  if (col === 'products') {
    if (trusted(me) || has(me, 'inv') || has(me, 'po') || has(me, 'wh')) return { doc: next, blocked };
    const t = clone(cur); t.stock = next.stock; // only the count follows the sale
    const bad = Object.keys(Object.assign({}, cur, next)).filter((k) => k !== 'stock' && !same(cur[k], next[k]));
    if (bad.length) { blocked.push('change product ' + (cur.name || '') + ' (' + bad.join(', ') + ')'); return { doc: t, blocked }; }
    return { doc: next, blocked };
  }
  if (col === 'customers') {
    if (trusted(me) || has(me, 'cust')) return { doc: next, blocked };
    if ((+next.owed || 0) < (+cur.owed || 0) - 0.004) { blocked.push('lower what ' + (cur.name || 'a customer') + ' owes'); return { doc: Object.assign({}, next, { owed: cur.owed }), blocked }; }
    return { doc: next, blocked };
  }
  return { doc: next, blocked };
}

module.exports = { hide, guard, records, HID };
