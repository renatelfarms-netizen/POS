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

module.exports = { hide, guard, HID };
