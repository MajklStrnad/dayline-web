/* Dayline — web/PWA port of the Android app (Compose → vanilla JS, no dependencies). */
(() => {
'use strict';

/* ================================================================= helpers */
const h = (tag, props, ...kids) => {
  const el = document.createElement(tag);
  if (props) for (const k in props) {
    const v = props[k];
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(c));
  return el;
};
const pad = n => String(n).padStart(2, '0');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const RM = matchMedia('(prefers-reduced-motion: reduce)');
const vibrate = ms => { try { navigator.vibrate && navigator.vibrate(ms); } catch (e) {} };
const SLOP = 8;   // touch slop, px
const desk = matchMedia('(min-width: 900px)');   // desktop layout
let suppressUntil = 0;   // swallow the click that follows a drag

/* Dates are JS Dates pinned to 12:00 local (immune to DST edges); keys are 'YYYY-MM-DD' / 'YYYY-MM'. */
const D = {
  key: d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
  parse: k => { const [y, m, dd] = k.split('-').map(Number); return new Date(y, m - 1, dd, 12); },
  today: () => { const n = new Date(); return new Date(n.getFullYear(), n.getMonth(), n.getDate(), 12); },
  add: (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; },
  mkey: d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`,
  mparse: k => { const [y, m] = k.split('-').map(Number); return new Date(y, m - 1, 1, 12); },
  month: d => new Date(d.getFullYear(), d.getMonth(), 1, 12),
  addMonths: (d, n) => new Date(d.getFullYear(), d.getMonth() + n, 1, 12),
  dow: d => (d.getDay() + 6) % 7,                       // Monday = 0
  diff: (a, b) => Math.round((b - a) / 86400000),
};
const dueMs = t => { const [y, m, d] = t.date.split('-').map(Number); const [hh, mm] = t.time.split(':').map(Number); return new Date(y, m - 1, d, hh, mm).getTime(); };

/* ================================================================= animation engine */
const bezier = (x1, y1, x2, y2) => {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const X = t => ((ax * t + bx) * t + cx) * t, Y = t => ((ay * t + by) * t + cy) * t;
  return x => {
    let t = x;
    for (let i = 0; i < 8; i++) { const e = X(t) - x; if (Math.abs(e) < 1e-5) break; const d = (3 * ax * t + 2 * bx) * t + cx; if (Math.abs(d) < 1e-6) break; t -= e / d; }
    return Y(Math.min(1, Math.max(0, t)));
  };
};
const FASTOUT = bezier(.4, 0, .2, 1);   // Compose's FastOutSlowInEasing (default for tween)

/** An animatable number. spring {z: dampingRatio, k: stiffness} (mass 1, like Compose) or tween {ms}. */
class Val {
  constructor(v = 0) { this.v = v; this.vel = 0; this._tok = 0; this._done = null; this.on = null; }
  snap(v) { this._tok++; this.v = v; this.vel = 0; this._cancel(); this.on && this.on(v); }
  _cancel() { const d = this._done; this._done = null; d && d(false); }
  to(target, spec) {
    const tok = ++this._tok;
    this._cancel();
    if (RM.matches) { this.v = target; this.vel = 0; this.on && this.on(target); return Promise.resolve(true); }
    return new Promise(resolve => {
      this._done = resolve;
      const finish = () => { if (this._done === resolve) this._done = null; resolve(true); };
      let last = performance.now();
      if (spec.ms != null) {
        const from = this.v, t0 = last;
        const step = now => {
          if (this._tok !== tok) return;
          const p = Math.min(1, (now - t0) / spec.ms);
          this.v = from + (target - from) * FASTOUT(p); this.vel = 0; this.on && this.on(this.v);
          if (p >= 1) { this.v = target; this.on && this.on(target); finish(); } else requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      } else {
        const k = spec.k, c = 2 * spec.z * Math.sqrt(k);
        const step = now => {
          if (this._tok !== tok) return;
          const dt = Math.min((now - last) / 1000, 0.05); last = now;
          const n = Math.max(1, Math.ceil(dt * 240)), s = dt / n;
          for (let i = 0; i < n; i++) { const a = -k * (this.v - target) - c * this.vel; this.vel += a * s; this.v += this.vel * s; }
          if (Math.abs(this.v - target) < 0.01 && Math.abs(this.vel) < 0.5) { this.v = target; this.vel = 0; this.on && this.on(target); finish(); return; }
          this.on && this.on(this.v);
          requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      }
    });
  }
}
const SPR_FAST = { z: .63, k: 640 }, SPR_SOFT = { z: .8, k: 190 }, SPR_TH = { z: .8, k: 300 };
const SPR_PAGER = { z: .84, k: 260 }, SPR_SNAP = { z: 1, k: 450 };

/** The squishy capsule: a round-capped line between two springs. The front end is stiff and leads, the back end is soft and follows. */
class Squish {
  constructor(parent, cls = '') {
    this.el = h('div', { class: 'cap ' + cls }); parent.prepend(this.el);
    this.ax = new Val(); this.ay = new Val(); this.bx = new Val(); this.by = new Val(); this.th = new Val(); this.al = new Val();
    for (const v of [this.ax, this.ay, this.bx, this.by, this.th, this.al]) v.on = () => this.render();
    this.rest = 0; this.placed = false; this.span = 100;
  }
  hide() { this.placed = false; this.al.snap(0); }
  to(ca, cb, thickness, visible, fastB, animate = true) {
    this.rest = Math.hypot(cb.x - ca.x, cb.y - ca.y);
    if (!this.placed || !animate) {
      this.placed = true;
      this.ax.snap(ca.x); this.ay.snap(ca.y); this.bx.snap(cb.x); this.by.snap(cb.y); this.th.snap(thickness); this.al.snap(visible ? 1 : 0);
    } else {
      const sa = fastB ? SPR_SOFT : SPR_FAST, sb = fastB ? SPR_FAST : SPR_SOFT;
      this.ax.to(ca.x, sa); this.ay.to(ca.y, sa); this.bx.to(cb.x, sb); this.by.to(cb.y, sb);
      this.th.to(thickness, SPR_TH); this.al.to(visible ? 1 : 0, { ms: 140 });
    }
  }
  render() {
    const al = this.al.v, th = this.th.v, st = this.el.style;
    if (al <= .01 || th <= .5) { st.opacity = 0; return; }
    const dx = this.bx.v - this.ax.v, dy = this.by.v - this.ay.v, dist = Math.hypot(dx, dy);
    const s = Math.min(1, Math.max(0, dist - this.rest) / this.span), t = th * (1 - .2 * s), len = dist + t;
    const cx = (this.ax.v + this.bx.v) / 2, cy = (this.ay.v + this.by.v) / 2;
    st.width = len + 'px'; st.height = t + 'px'; st.opacity = al;
    st.transform = `translate(${cx - len / 2}px,${cy - t / 2}px) rotate(${Math.atan2(dy, dx)}rad)`;
  }
}

/** Three pages (prev / current / next) that follow the finger, then settle with a spring. Pages are keyed so nodes are reused. */
class Pager {
  constructor(root, make, keyAt) {
    this.root = root; this.make = make; this.keyAt = keyAt; this.w = 0; this.pages = []; this.busy = false;
    this.xv = new Val(0); this.xv.on = () => this.layout();
    new ResizeObserver(([e]) => { this.w = e.contentRect.width; this.layout(); this.onSize && this.onSize(); }).observe(root);
  }
  rebuild(center) {
    const old = new Map(this.pages.map(p => [p.key, p]));
    this.pages = [-1, 0, 1].map(o => {
      const key = this.keyAt(center, o); let p = old.get(key);
      if (p) old.delete(key); else { p = this.make(key); p.key = key; this.root.append(p.el); }
      p.o = o; return p;
    });
    old.forEach(p => p.el.remove());
    this.layout();
  }
  layout() {
    for (const p of this.pages) { p.el.style.transform = `translate3d(${p.o * this.w + this.xv.v}px,0,0)`; p.el.style.visibility = this.w > 0 ? 'visible' : 'hidden'; }
  }
  /** dir 1 = next page, -1 = previous, 0 = spring back. onDone runs once the page has landed. */
  settle(dir, v0, onDone) {
    if (this.busy) return;
    this.busy = true; this.xv.vel = v0 || 0;
    this.xv.to(-dir * this.w, SPR_PAGER).then(() => {
      if (dir) onDone && onDone();     // swap the content and reset the offset in the same frame, so there is no jump
      this.xv.snap(0); this.busy = false;
    });
  }
}

/* ================================================================= gestures */
/** Tap and long-press that give up as soon as the finger moves (so swipes and scrolls win). */
function tapGesture(el, { onTap, onLong, longMs = 400, skip }) {
  let st = null;
  const clear = () => { if (st) { clearTimeout(st.timer); st = null; } };
  el.addEventListener('pointerdown', e => {
    if (e.button > 0 || (skip && skip(e))) return;
    clear();
    st = { x: e.clientX, y: e.clientY, id: e.pointerId, fired: false };
    if (onLong) st.timer = setTimeout(() => { if (st) { st.fired = true; onLong(e); } }, longMs);
  });
  el.addEventListener('pointermove', e => {
    if (st && e.pointerId === st.id && Math.hypot(e.clientX - st.x, e.clientY - st.y) > SLOP) clear();
  });
  el.addEventListener('pointerup', e => {
    if (!st || e.pointerId !== st.id) return;
    const s = st; clear();
    if (!s.fired && onTap) onTap(e);
  });
  el.addEventListener('pointercancel', clear);
  el.addEventListener('pointerleave', clear);          // mouse moved off the element
  el.addEventListener('lostpointercapture', clear);   // a parent swipe took over the pointer
  el.addEventListener('contextmenu', e => e.preventDefault());
}

/** Velocity (px/s) from the last ~100 ms of samples. */
const velocity = s => {
  const last = s[s.length - 1]; let first = s[0];
  for (const p of s) if (last.t - p.t <= 100) { first = p; break; }
  const dt = last.t - first.t; return dt > 0 ? (last.x - first.x) / dt * 1000 : 0;
};

/** Drag sideways: the pager follows the finger. Past ~a quarter of the width, or a quick flick, it moves to the next/previous page. */
function followSwipe(el, pager, decide, done) {
  let g = null;
  const end = (e, cancelled) => {
    if (!g || e.pointerId !== g.id) return;
    const s = g; g = null;
    if (!s.drag) return;
    suppressUntil = performance.now() + 250;
    try { el.releasePointerCapture(e.pointerId); } catch (_) {}
    const w = pager.w, vx = cancelled ? 0 : velocity(s.samples), tot = s.tot;
    const dir = !cancelled && (tot < -w * .22 || (vx < -600 && tot < -16)) ? 1 : !cancelled && (tot > w * .22 || (vx > 600 && tot > 16)) ? -1 : 0;
    if (dir) decide(dir);
    pager.settle(dir, vx, () => done(dir));
  };
  el.addEventListener('pointerdown', e => {
    if (e.button > 0 || pager.busy || (e.pointerType === 'mouse' && desk.matches)) return;
    g = { id: e.pointerId, x0: e.clientX, y0: e.clientY, drag: false, tot: 0, off: 0, samples: [{ t: e.timeStamp, x: e.clientX }] };
  });
  el.addEventListener('pointermove', e => {
    if (!g || e.pointerId !== g.id) return;
    const dx = e.clientX - g.x0, dy = e.clientY - g.y0;
    if (!g.drag) {
      if (Math.abs(dx) > SLOP && Math.abs(dx) > Math.abs(dy)) { g.drag = true; g.off = Math.sign(dx) * SLOP; el.setPointerCapture(e.pointerId); }
      else return;
    }
    g.tot = dx - g.off; pager.xv.snap(g.tot);
    g.samples.push({ t: e.timeStamp, x: e.clientX }); if (g.samples.length > 12) g.samples.shift();
  });
  el.addEventListener('pointerup', e => end(e, false));
  el.addEventListener('pointercancel', e => end(e, true));
}

/** A simpler horizontal swipe (long enough drag or quick flick) for the second screen. */
function swipe(el, cb) {
  let g = null;
  el.addEventListener('pointerdown', e => { if (e.button === 0 && !(e.pointerType === 'mouse' && desk.matches)) g = { id: e.pointerId, x0: e.clientX, y0: e.clientY, drag: false, samples: [{ t: e.timeStamp, x: e.clientX }] }; });
  el.addEventListener('pointermove', e => {
    if (!g || e.pointerId !== g.id) return;
    const dx = e.clientX - g.x0, dy = e.clientY - g.y0;
    if (!g.drag && Math.abs(dx) > SLOP && Math.abs(dx) > Math.abs(dy)) g.drag = true;
    if (g.drag) { g.samples.push({ t: e.timeStamp, x: e.clientX }); if (g.samples.length > 12) g.samples.shift(); }
  });
  el.addEventListener('pointerup', e => {
    if (!g || e.pointerId !== g.id) return;
    const s = g; g = null; if (!s.drag) return;
    suppressUntil = performance.now() + 250;
    const tot = e.clientX - s.x0, vx = velocity(s.samples);
    if (Math.abs(tot) > 48 || (Math.abs(vx) > 600 && Math.abs(tot) > 16)) cb(tot < 0 ? 1 : -1);
  });
  el.addEventListener('pointercancel', () => { g = null; });
}

/** Drag a bottom sheet down to dismiss. Past the threshold (or a flick) it finishes sliding off-screen first, then dismisses. */
function sheetDrag(el, dismiss) {
  let g = null;
  const reset = () => requestAnimationFrame(() => { el.style.transition = 'none'; el.style.transform = ''; void el.offsetHeight; el.style.transition = ''; });
  el.addEventListener('pointerdown', e => {
    if (e.button > 0 || g || desk.matches || e.target.closest('input')) return;
    g = { id: e.pointerId, x0: e.clientX, y0: e.clientY, drag: false, off: 0, samples: [{ t: e.timeStamp, x: e.clientY }] };
  });
  el.addEventListener('pointermove', e => {
    if (!g || e.pointerId !== g.id) return;
    const dx = e.clientX - g.x0, dy = e.clientY - g.y0;
    if (!g.drag) {
      if (dy > SLOP && dy > Math.abs(dx)) { g.drag = true; el.setPointerCapture(e.pointerId); el.style.transition = 'none'; }
      else return;
    }
    g.off = Math.max(0, dy - SLOP); el.style.transform = `translateY(${g.off}px)`;
    g.samples.push({ t: e.timeStamp, x: e.clientY }); if (g.samples.length > 12) g.samples.shift();
  });
  const end = async (e, cancelled) => {
    if (!g || e.pointerId !== g.id) return;
    const s = g; g = null; if (!s.drag) return;
    suppressUntil = performance.now() + 250;
    try { el.releasePointerCapture(e.pointerId); } catch (_) {}
    if (!cancelled && (s.off > 64 || velocity(s.samples) > 1800)) {
      el.style.transition = 'transform .16s cubic-bezier(.4,0,.2,1)'; el.style.transform = `translateY(${el.offsetHeight}px)`;
      await sleep(RM.matches ? 0 : 160); dismiss(); reset();
    } else {
      el.style.transition = 'transform .3s cubic-bezier(.2,1.25,.4,1)'; el.style.transform = '';
      setTimeout(() => { el.style.transition = ''; }, 320);
    }
  };
  el.addEventListener('pointerup', e => end(e, false));
  el.addEventListener('pointercancel', e => end(e, true));
}

/* ================================================================= back-button / history layers */
const layers = []; let ignorePops = 0;
function openLayer(id, onClose) { layers.push({ id, onClose }); history.pushState({ layer: id }, ''); }
function closeLayer(id) {
  const i = layers.findIndex(l => l.id === id); if (i < 0) return;
  const [l] = layers.splice(i, 1); l.onClose(); ignorePops++; history.back();
}
const closeTop = () => { const l = layers[layers.length - 1]; if (l) closeLayer(l.id); };
addEventListener('popstate', () => {
  if (ignorePops > 0) { ignorePops--; return; }
  const l = layers.pop(); if (l) l.onClose();
});

/* ================================================================= storage */
const mem = {};
const LS = {
  get(k, d = null) { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch (e) { return k in mem ? mem[k] : d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) { mem[k] = v; } },
};
function loadTasks() {
  try {
    const a = JSON.parse(LS.get('dayline.tasks', '[]'));
    return a.filter(t => t && typeof t.title === 'string' && /^\d{4}-\d\d-\d\d$/.test(t.date) && /^\d\d:\d\d$/.test(t.time))
      .map(t => ({ id: Number(t.id), title: t.title, date: t.date, time: t.time, done: !!t.done, rems: Array.isArray(t.rems) ? t.rems.filter(Number.isFinite) : [0] }));
  } catch (e) { return []; }
}
let persistAsked = false;
function saveTasks() {
  LS.set('dayline.tasks', JSON.stringify(tasks));
  if (!persistAsked && navigator.storage && navigator.storage.persist) { persistAsked = true; navigator.storage.persist().catch(() => {}); }
}

/* ================================================================= strings */
const EN = { clear: 'All clear', today: 'Today', open: 'open', free: 'A free day.', hint: 'Tap + to add a task.', ph: 'New task', ph2: 'What needs doing?', over: 'Overdue', set: 'Set time', time: 'Time', notif: 'Notify me', r0: 'At due time', r1440: '1 day before', r4320: '3 days before', add: 'Add task', cancel: 'Cancel', all: 'All tasks', in: 'in', done: 'Done', r0s: 'On time', roff: 'Off', passed: "already passed, won't fire", del: 'Delete', delq: 'Delete this task?', edit: 'Edit task', save: 'Save', setd: 'Set date', prev: 'Previous month', next: 'Next month', theme: 'Switch theme', back: 'Back', now: 'Due now', pday: 'Previous day', nday: 'Next day', kday: 'Previous / next day', ktoday: 'Jump to today', knew: 'New task', kclose: 'Close' };
const CS = { clear: 'Vše hotovo', today: 'Dnes', open: 'otevřeno', free: 'Volný den.', hint: 'Úkol přidáš tlačítkem +.', ph: 'Nový úkol', ph2: 'Co je potřeba udělat?', over: 'Po termínu', set: 'Nastavit čas', time: 'Čas', notif: 'Upozornit', r0: 'V čas termínu', r1440: '1 den předem', r4320: '3 dny předem', add: 'Přidat úkol', cancel: 'Zrušit', all: 'Všechny úkoly', in: 'za', done: 'Hotovo', r0s: 'V čas', roff: 'Vypnuto', passed: 'už uplynulo, nespustí se', del: 'Smazat', delq: 'Smazat tento úkol?', edit: 'Upravit úkol', save: 'Uložit', setd: 'Nastavit datum', prev: 'Předchozí měsíc', next: 'Další měsíc', theme: 'Přepnout motiv', back: 'Zpět', now: 'Právě teď', pday: 'Předchozí den', nday: 'Další den', kday: 'Předchozí / další den', ktoday: 'Přejít na dnes', knew: 'Nový úkol', kclose: 'Zavřít' };
function dueIn(mins, cs) {
  switch (mins) {
    case 10: return cs ? 'Za 10 minut' : 'Due in 10 minutes';
    case 4320: return cs ? 'Za 3 dny' : 'Due in 3 days';
    case 60: return cs ? 'Za 1 hodinu' : 'Due in 1 hour';
    case 1440: return cs ? 'Za 1 den' : 'Due in 1 day';
    case 10080: return cs ? 'Za 1 týden' : 'Due in 1 week';
    default: return cs ? `Za ${mins} min` : `Due in ${mins} min`;
  }
}
const fmtDur = s => s < 3600 ? `${Math.floor(s / 60)}m ${pad(s % 60)}s` : s >= 86400 ? `${Math.floor(s / 86400)}d ${Math.floor(s % 86400 / 3600)}h` : `${Math.floor(s / 3600)}h ${Math.floor(s % 3600 / 60)}m`;

/* ================================================================= state */
let tasks = loadTasks();
let lang = LS.get('dayline.lang') || ((navigator.language || 'en').toLowerCase().startsWith('cs') ? 'cs' : 'en');
let mode = LS.get('dayline.mode') || 'system';
let T = lang === 'cs' ? CS : EN;
const locOf = () => lang === 'cs' ? 'cs-CZ' : 'en-GB';
let now = new Date();
let sel = D.today(), ym = D.month(sel);
let screen = 0, adding = false;
let editing = null, title = '', dateVal = D.today(), timeVal = { h: 9, m: 0 }, rems = new Set([0]), delTask = null;
let lastId = 0, spins = 0;
const REM_OPTS = [4320, 1440, 0];
const openCount = () => tasks.filter(t => !t.done).length;
const cmp = (a, b) => (a.done - b.done) || (a.time < b.time ? -1 : a.time > b.time ? 1 : 0);

const monthName = d => { const s = new Intl.DateTimeFormat(locOf(), { month: 'long' }).format(d); return `${s.charAt(0).toUpperCase()}${s.slice(1)} ${d.getFullYear()}`; };
function dayLong(d, short) {                       // "EEEE d MMM" (header) / "EEE d MMM" (pills, capitalised)
  const loc = locOf();
  const wd = new Intl.DateTimeFormat(loc, { weekday: short ? 'short' : 'long' }).format(d);
  const mo = new Intl.DateTimeFormat(loc, { month: 'short' }).format(d).replace(/\.$/, '');   // month alone, so Czech gives "lis", not "11"
  const s = `${wd} ${d.getDate()} ${mo}`;
  return short ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}
const hhmm = t => t.time;

/* ================================================================= reminders */
/* Web apps can't schedule exact alarms while closed, so reminders are checked every second while Dayline is open
   (including installed/background-but-alive) and delivered as system notifications via the service worker. Nothing
   that came due before the app was opened is re-fired — same rule the Android boot receiver follows. */
let fired = {}; try { fired = JSON.parse(LS.get('dayline.fired', '{}')) || {}; } catch (e) { fired = {}; }
let lastCheck = Date.now();
const firedKey = (id, m) => `${id}:${m}`;
function persistFired() {
  const cut = Date.now() - 7 * 864e5;
  for (const k in fired) if (fired[k] < cut) delete fired[k];
  LS.set('dayline.fired', JSON.stringify(fired));
}
function clearFired(id) { let ch = false; for (const k in fired) if (k.startsWith(id + ':')) { delete fired[k]; ch = true; } if (ch) persistFired(); }
async function swReg() { try { return 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : null; } catch (e) { return null; } }
async function cancelShown(id) {
  try { const r = await swReg(); if (r) (await r.getNotifications()).filter(n => (n.tag || '').startsWith(`dayline-${id}-`)).forEach(n => n.close()); } catch (e) {}
}
function askNotify() {
  try { if (rems.size && 'Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => {}); } catch (e) {}
}
async function fire(t, m) {
  const cs = lang === 'cs';
  const body = m === 0 ? T.now : `${dueIn(m, cs)} · ${t.time}`;
  let shown = false;
  try {
    if ('Notification' in window && Notification.permission === 'granted') {
      const opts = { body, icon: 'icons/icon-192.png', badge: 'icons/badge-96.png', tag: `dayline-${t.id}-${m}`, lang };
      const r = await swReg();
      if (r) { await r.showNotification(t.title, opts); shown = true; }
      else { new Notification(t.title, opts); shown = true; }
    }
  } catch (e) {}
  if (!shown) toast(t.title, body);   // no permission / unsupported: at least show it in the app
}
function checkDue() {
  const n = Date.now(); let ch = false;
  for (const t of tasks) {
    if (t.done) continue;
    const base = dueMs(t);
    for (const m of t.rems) {
      const at = base - m * 60000, k = firedKey(t.id, m);
      if (at <= n && at > lastCheck && !fired[k]) { fired[k] = at; ch = true; fire(t, m); }
    }
  }
  lastCheck = n; if (ch) persistFired();
}

/* ================================================================= UI: top bar */
const shell = document.getElementById('shell');
const metaTheme = document.querySelector('meta[name="theme-color"]');
const darkMQ = matchMedia('(prefers-color-scheme: dark)');
const isDark = () => mode === 'dark' || (mode === 'system' && darkMQ.matches);
function applyTheme() {
  if (mode === 'system') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = mode;
  metaTheme.content = isDark() ? '#141219' : '#FAF9FC';
}
darkMQ.addEventListener('change', applyTheme);

const allBtn = h('button', { class: 'pill-all', type: 'button', onclick: () => openAll() });
const langBtns = { en: h('button', { type: 'button', onclick: () => setLang('en') }, 'EN'), cs: h('button', { type: 'button', onclick: () => setLang('cs') }, 'CS') };
const langBox = h('div', { class: 'lang' }, langBtns.en, langBtns.cs);
const langCap = new Squish(langBox);
const themeIcon = h('span', { text: '◐' });
const themeBtn = h('button', { class: 'theme-btn', type: 'button', onclick: () => toggleTheme() }, themeIcon);
const spin = new Val(0); spin.on = v => { themeIcon.style.transform = `rotate(${v}deg)`; };
const top = h('div', { class: 'top' }, allBtn, h('div', { class: 'right' }, langBox, themeBtn));

function toggleTheme() {
  spins++; mode = isDark() ? 'light' : 'dark'; LS.set('dayline.mode', mode); applyTheme();
  spin.to(spins * 180, { z: .5, k: 100 });
}
function placeLang(animate) {
  const idx = lang === 'cs' ? 1 : 0, cx = 26 + 46 * idx, cy = 21, half = 5;
  langCap.to({ x: cx - half, y: cy }, { x: cx + half, y: cy }, 36, true, idx === 1, animate);
  langBtns.en.classList.toggle('on', lang === 'en'); langBtns.cs.classList.toggle('on', lang === 'cs');
}
function setLang(l) {
  if (l === lang) return;
  lang = l; T = l === 'cs' ? CS : EN; LS.set('dayline.lang', l); document.documentElement.lang = l;
  refreshText(); placeLang(true);
}
const updateAllBtn = () => { allBtn.textContent = `${T.all}  ·  ${openCount()}`; };

/* ================================================================= UI: calendar */
const mTitle = h('div', { class: 't' });
const prevBtn = h('button', { type: 'button', onclick: () => stepMonth(-1) }, '‹');
const nextBtn = h('button', { type: 'button', onclick: () => stepMonth(1) }, '›');
const wdRow = h('div', { class: 'wd' });
const mRoot = h('div', { class: 'mpager' });
const cal = h('div', { class: 'cal' }, h('div', { class: 'mh' }, prevBtn, mTitle, nextBtn), wdRow, mRoot);
const updateMonthTitle = () => { mTitle.textContent = monthName(ym); };
function buildWeekdays(host = wdRow) {
  host.textContent = '';
  const f = new Intl.DateTimeFormat(locOf(), { weekday: 'narrow' });
  for (let i = 0; i < 7; i++) host.append(h('span', { text: f.format(new Date(2024, 0, 1 + i)) }));   // 1 Jan 2024 is a Monday
}

function makeMonthPage(key) {
  const m = D.mparse(key), start = D.add(m, -D.dow(m));
  const el = h('div', { class: 'page grid' });
  const cap = new Squish(el);
  const cells = [];
  for (let i = 0; i < 42; i++) {
    const d = D.add(start, i), c = h('div', { class: 'c' }, String(d.getDate())), cell = h('div', { class: 'cell' }, c);
    tapGesture(cell, { longMs: 250, onTap: () => setSel(d), onLong: () => { vibrate(15); openAdd(d); } });   // a tap only selects; hold a date to add
    el.append(cell); cells.push({ d, c, k: D.key(d) });
  }
  const page = { el, key };
  page.styleCells = () => {
    const today = D.key(D.today()), sk = D.key(sel), open = new Set(tasks.filter(t => !t.done).map(t => t.date));
    for (const { d, c, k } of cells) {
      c.classList.toggle('sel', k === sk); c.classList.toggle('today', k === today); c.classList.toggle('out', d.getMonth() !== m.getMonth());
      const dot = c.querySelector('.dot');
      if (open.has(k) && !dot) c.append(h('div', { class: 'dot' })); else if (!open.has(k) && dot) dot.remove();
    }
  };
  page.placeCap = animate => {
    const w = el.clientWidth; if (w <= 0) return;
    const idx = D.diff(start, sel);
    if (idx >= 0 && idx <= 41) { const p = { x: (idx % 7 + .5) * w / 7, y: (Math.floor(idx / 7) + .5) * 46 }; cap.to(p, { ...p }, 42, true, false, animate); }
    else cap.hide();   // the selected day isn't in this month's grid
  };
  new ResizeObserver(() => page.placeCap(page.o === 0)).observe(el);
  page.styleCells();
  return page;
}
const monthPager = new Pager(mRoot, makeMonthPage, (c, o) => D.mkey(D.addMonths(D.mparse(c), o)));
const styleGrids = () => monthPager.pages.forEach(p => p.styleCells());
const refreshGrids = () => monthPager.pages.forEach(p => { p.styleCells(); p.placeCap(p.o === 0); });
function setMonth(m) { ym = m; monthPager.rebuild(D.mkey(ym)); updateMonthTitle(); }
function stepMonth(dir) { monthPager.settle(dir, 0, () => setMonth(D.addMonths(ym, dir))); }

/* ================================================================= UI: day list */
const dRoot = h('div', { class: 'dpager' });
const dayzone = h('div', { class: 'dayzone' }, dRoot);
const rowTm = (t, late) => (late ? `${T.over} · ` : '') + t.time;

function taskRow(t) {
  const late = !t.done && dueMs(t) < now.getTime();
  const tm = h('div', { class: 'tm' + (late ? ' late' : ''), text: rowTm(t, late) });
  const chk = h('div', { class: 'chk', role: 'checkbox', 'aria-checked': String(t.done) }, t.done ? '✓' : '');
  chk.addEventListener('click', e => { e.stopPropagation(); setDone(t, !t.done); });
  const rdel = h('button', { class: 'rdel', type: 'button', 'aria-label': T.del, title: T.del }, '✕');   // shown on hover (desktop)
  rdel.addEventListener('click', e => { e.stopPropagation(); openDelete(t); });
  const row = h('div', { class: 'row' + (t.done ? ' done' : ''), tabindex: '0' }, chk, h('div', { class: 'tt', text: t.title }), tm, rdel);
  row._t = t; row._tm = tm; row._late = late;
  tapGesture(row, { skip: e => !!e.target.closest('.chk,.rdel'), onTap: () => openEdit(t), onLong: () => { vibrate(15); openDelete(t); } });
  row.addEventListener('keydown', e => { if (e.key === 'Enter') openEdit(t); else if (e.key === 'Delete') openDelete(t); });
  return row;
}
function fillDay(page) {
  const d = D.parse(page.key), list = tasks.filter(t => t.date === page.key).sort(cmp);
  const old = page.list, top = old ? old.scrollTop : 0, prev = new Map();
  if (old) old.querySelectorAll('.row').forEach(r => prev.set(r._t.id, r.getBoundingClientRect().top));
  page.el.textContent = '';
  page.el.append(h('div', { class: 'dh' },
    h('div', { class: 't', text: page.key === D.key(now) ? T.today : dayLong(d, false) }),
    h('div', { class: 'n', text: `${list.filter(t => !t.done).length} ${T.open}` })));
  if (!list.length) page.el.append(h('div', { class: 'empty' }, T.free, h('small', { text: T.hint })));
  const ul = h('div', { class: 'list' }); page.list = ul; page.rows = [];
  for (const t of list) { const r = taskRow(t); ul.append(r); page.rows.push(r); }
  page.el.append(ul); ul.scrollTop = top;
  if (old && !RM.matches) page.rows.forEach(r => {        // rows glide to their new place; new rows fade in
    const was = prev.get(r._t.id);
    if (was == null) r.animate([{ opacity: 0 }], { duration: 220, easing: 'ease-out' });
    else { const dy = was - r.getBoundingClientRect().top; if (Math.abs(dy) > 1) r.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: 300, easing: 'cubic-bezier(.4,0,.2,1)' }); }
  });
}
function makeDayPage(key) { const page = { el: h('div', { class: 'dpage' }), key, rows: [], list: null }; fillDay(page); return page; }
const dayPager = new Pager(dRoot, makeDayPage, (c, o) => D.key(D.add(D.parse(c), o)));
const refreshDays = () => dayPager.pages.forEach(fillDay);
function updateLate() {
  const n = now.getTime();
  for (const p of dayPager.pages) for (const r of p.rows || []) {
    const late = !r._t.done && dueMs(r._t) < n;
    if (late !== r._late) { r._late = late; r._tm.className = 'tm' + (late ? ' late' : ''); r._tm.textContent = rowTm(r._t, late); }
  }
}

function setSel(d, follow) {
  sel = d;
  if (follow && D.month(d).getTime() !== ym.getTime()) setMonth(D.month(d));
  refreshGrids();
  if (!dayPager.busy) dayPager.rebuild(D.key(sel));
}
/* Day swipe: the capsule starts moving as soon as you let go; the list pages keep their keys until they have landed. */
function decideDay(dir) {
  sel = D.add(sel, dir); refreshGrids();
  const nm = D.month(sel);
  if (nm.getTime() !== ym.getTime()) {
    const md = nm > ym ? 1 : -1;
    if (!monthPager.busy) monthPager.settle(md, 0, () => setMonth(D.addMonths(ym, md))); else setMonth(nm);
  }
}
const doneDay = () => dayPager.rebuild(D.key(sel));
function goDay(dir) { if (dayPager.busy) return; decideDay(dir); dayPager.settle(dir, 0, () => doneDay(dir)); }

followSwipe(cal, monthPager, () => {}, dir => setMonth(D.addMonths(ym, dir)));
followSwipe(dayzone, dayPager, decideDay, doneDay);

/* ================================================================= UI: desktop toolbar + shortcut hints (hidden on phones) */
const prevDayBtn = h('button', { class: 'tb arrow', type: 'button', onclick: () => goDay(-1) }, '‹');
const nextDayBtn = h('button', { class: 'tb arrow', type: 'button', onclick: () => goDay(1) }, '›');
const todayBtn = h('button', { class: 'tb', type: 'button', onclick: () => { const t = D.today(); if (D.key(sel) !== D.key(t)) setSel(t, true); } });
const newLabel = h('span'), newBtn = h('button', { class: 'tb newb', type: 'button', onclick: () => openAdd(sel) }, newLabel, h('span', { class: 'kbd', text: 'N' }));
const dtools = h('div', { class: 'dtools' }, prevDayBtn, todayBtn, nextDayBtn, h('div', { class: 'sp' }), newBtn);
const keysHint = h('div', { class: 'keys' });
function renderDesk() {
  todayBtn.textContent = T.today; newLabel.textContent = T.knew;
  prevDayBtn.setAttribute('aria-label', T.pday); nextDayBtn.setAttribute('aria-label', T.nday);
  keysHint.textContent = '';
  for (const [ks, label] of [[['←', '→'], T.kday], [['T'], T.ktoday], [['N'], T.knew], [['Esc'], T.kclose]])
    keysHint.append(h('div', null, ...ks.map(k => h('span', { class: 'kbd', text: k })), ` ${label}`));
}

/* ================================================================= UI: add button + all-tasks screen */
const fab = h('button', { class: 'fab', type: 'button', 'aria-label': 'Add task', onclick: () => openAdd(sel) }, h('span', { text: '+' }));
const updateFab = () => fab.classList.toggle('hide', !(screen === 0 && !adding));
const setOpen = (el, on) => el.classList.toggle('open', on);

const aTitle = h('div', { class: 't' }), aCount = h('div', { class: 'n' });
const backBtn = h('button', { class: 'back', type: 'button', onclick: () => closeLayer('all') }, '‹');
const aList = h('div', { class: 'alist' });
const allScrim = h('div', { class: 'scrim alls', onclick: () => closeLayer('all') });
const allScreen = h('div', { class: 'screen' }, h('div', { class: 'sh' }, backBtn, aTitle, aCount), aList);
swipe(allScreen, d => { if (d === -1) closeLayer('all'); });

function nextCard(t) {
  const cd = h('div', { class: 'cd' });
  const ck = h('div', { class: 'ck', role: 'checkbox', 'aria-checked': String(t.done) }, '✓');
  ck.addEventListener('click', e => { e.stopPropagation(); setDone(t, !t.done); });
  const card = h('div', { class: 'nc' + (t.done ? ' done' : ''), tabindex: '0' },
    h('div', { class: 'body' }, h('div', { class: 'd', text: `${dayLong(D.parse(t.date), true)} · ${t.time}` }), h('div', { class: 'tt', text: t.title }), t.done ? null : cd), ck);
  card._t = t; card._cd = cd;
  card.addEventListener('click', () => { closeLayer('all'); setSel(D.parse(t.date), true); });
  card.addEventListener('keydown', e => { if (e.key === 'Enter') card.click(); });
  updateCd(card); return card;
}
function updateCd(card) {
  const t = card._t; if (t.done) return;
  const secs = Math.trunc((dueMs(t) - now.getTime()) / 1000), late = secs < 0;
  card._cd.className = 'cd' + (late ? ' late' : '');
  card._cd.textContent = late ? `${T.over} · ${fmtDur(-secs)}` : `${T.in} ${fmtDur(secs)}`;
}
function renderAll() {
  const open = tasks.filter(t => !t.done).sort((a, b) => dueMs(a) - dueMs(b)), done = tasks.filter(t => t.done).sort((a, b) => dueMs(b) - dueMs(a));
  const top = aList.scrollTop; aList.textContent = '';
  if (!open.length) aList.append(h('div', { class: 'clear', text: T.clear }));
  open.forEach(t => aList.append(nextCard(t)));
  if (done.length) { aList.append(h('div', { class: 'dl', text: T.done })); done.forEach(t => aList.append(nextCard(t))); }
  aList.scrollTop = top; aTitle.textContent = T.all; aCount.textContent = `${open.length} ${T.open}`; backBtn.setAttribute('aria-label', T.back);
}
const updateCds = () => aList.querySelectorAll('.nc').forEach(updateCd);
function openAll() {
  if (screen === 1) return;
  screen = 1; renderAll(); setOpen(allScreen, true); setOpen(allScrim, true); updateFab();
  openLayer('all', () => { screen = 0; setOpen(allScreen, false); setOpen(allScrim, false); updateFab(); });
}

/* ================================================================= UI: add / edit sheet */
const addScrim = h('div', { class: 'scrim add', onclick: () => closeLayer('add') });
const aHead = h('div', { class: 't' });
const datePill = h('button', { class: 'pillbtn datepill', type: 'button', onclick: () => openDatePick() });
const timePill = h('button', { class: 'pillbtn timepill', type: 'button', onclick: () => openTimePick() });
const input = h('input', { type: 'text', enterkeyhint: 'done', autocomplete: 'off', autocapitalize: 'sentences', maxlength: '200', 'aria-label': 'Task' });
const field = h('div', { class: 'field' }, input, timePill);
const nLabel = h('div', { class: 'l' }), nSummary = h('div', { class: 's' }), nArrow = h('div', { class: 'ar' });
const nrow = h('button', { class: 'nrow', type: 'button', onclick: () => toggleRemsOpen() }, nLabel, nSummary, nArrow);
let remsOpen = false;
const optRows = REM_OPTS.map(m => {
  const l = h('div', { class: 'l' }), sub = h('span', { class: 'sub' }), ck = h('div', { class: 'ck', text: '✓' });
  const row = h('button', { class: 'opt', type: 'button', onclick: () => toggleRem(m) }, h('div', { class: 'col' }, l, sub), ck);
  const o = { m, row, l, sub, cap: new Squish(row, 'soft') };
  new ResizeObserver(() => placeOpt(o, true)).observe(row);
  return o;
});
const optsBox = h('div', { class: 'opts' }, h('div', null, ...optRows.map(o => o.row)));
const cancelBtn = h('button', { class: 'txtbtn', type: 'button', onclick: () => closeLayer('add') });
const submitBtn = h('button', { class: 'btn', type: 'button', onclick: () => submit() });
const addSheet = h('div', { class: 'sheet s-add' }, h('div', { class: 'grab' }),
  h('div', { class: 'ah' }, aHead, datePill), field, nrow, optsBox, h('div', { class: 'btns' }, cancelBtn, submitBtn));
sheetDrag(addSheet, () => closeLayer('add'));
input.addEventListener('input', () => { title = input.value; submitBtn.disabled = !title.trim(); });
input.addEventListener('focus', () => field.classList.add('focus'));
input.addEventListener('blur', () => { field.classList.remove('focus'); if (!adding) return; });
input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); submit(); } });

const dueOf = (d, t, m) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), t.h, t.m).getTime() - m * 60000;
function placeOpt(o, animate) {
  const w = o.row.offsetWidth, hh = o.row.offsetHeight; if (!w) return;
  if (rems.has(o.m)) o.cap.to({ x: hh / 2, y: hh / 2 }, { x: w - hh / 2, y: hh / 2 }, hh, true, false, animate);   // grows out of the tick, front edge first
  else { const chk = w - 24; o.cap.to({ x: chk, y: hh / 2 }, { x: chk, y: hh / 2 }, 20, false, true, animate); }  // folds back into it
}
function updateModal() {
  aHead.textContent = editing ? T.edit : T.ph;
  datePill.textContent = dayLong(dateVal, true);
  timePill.textContent = `${pad(timeVal.h)}:${pad(timeVal.m)}`;
  input.placeholder = T.ph2;
  nLabel.textContent = T.notif;
  nSummary.textContent = rems.size ? [...rems].sort((a, b) => b - a).map(m => m === 0 ? T.r0s : m === 1440 ? '1d' : m === 4320 ? '3d' : `${m}m`).join(' · ') : T.roff;
  nArrow.textContent = remsOpen ? '▴' : '▾';
  cancelBtn.textContent = T.cancel; submitBtn.textContent = editing ? T.save : T.add; submitBtn.disabled = !title.trim();
  for (const o of optRows) {
    o.l.textContent = T['r' + o.m]; o.row.classList.toggle('on', rems.has(o.m));
    o.row.setAttribute('aria-pressed', String(rems.has(o.m)));
  }
  updateModalPassed();
}
function updateModalPassed() {
  for (const o of optRows) { const txt = dueOf(dateVal, timeVal, o.m) < now.getTime() ? T.passed : ''; if (o.sub.textContent !== txt) o.sub.textContent = txt; }
}
function checkScroll(sheet) { sheet.classList.toggle('scrolls', sheet.scrollHeight > sheet.clientHeight + 1); }
function toggleRemsOpen() { remsOpen = !remsOpen; optsBox.classList.toggle('open', remsOpen); updateModal(); setTimeout(() => checkScroll(addSheet), 230); }
function toggleRem(m) { rems = new Set(rems); if (rems.has(m)) rems.delete(m); else rems.add(m); updateModal(); placeOpt(optRows.find(o => o.m === m), true); }

function showAdd() {
  if (adding) return;
  adding = true; input.value = title; remsOpen = false; optsBox.classList.remove('open');
  updateModal(); optRows.forEach(o => { o.cap.placed = false; placeOpt(o, false); });
  setOpen(addSheet, true); setOpen(addScrim, true); updateFab();
  requestAnimationFrame(() => checkScroll(addSheet));
  openLayer('add', () => { adding = false; setOpen(addSheet, false); setOpen(addScrim, false); input.blur(); updateFab(); });
  setTimeout(() => { if (adding && !layers.some(l => l.id === 'time' || l.id === 'date')) input.focus({ preventScroll: true }); }, 340);
}
function openAdd(d) {
  if (adding) return;
  setSel(d, true); dateVal = d; title = ''; rems = new Set([0]); editing = null;
  // sensible default time: the next full hour if the day is today (23:59 near midnight), otherwise 09:00
  const n = new Date(), isToday = D.key(d) === D.key(n);
  timeVal = !isToday ? { h: 9, m: 0 } : n.getHours() + 1 > 23 ? { h: 23, m: 59 } : { h: n.getHours() + 1, m: 0 };
  showAdd();
}
function openEdit(t) {
  if (adding) return;
  setSel(D.parse(t.date), true);
  const [hh, mm] = t.time.split(':').map(Number);
  title = t.title; timeVal = { h: hh, m: mm }; dateVal = D.parse(t.date); rems = new Set(t.rems); editing = t;
  showAdd();
}
function submit() {
  const text = title.trim(); if (!text || !adding) return;
  const date = D.key(dateVal), time = `${pad(timeVal.h)}:${pad(timeVal.m)}`, rl = [...rems].sort((a, b) => b - a);
  const i = editing ? tasks.findIndex(x => x.id === editing.id) : -1;
  if (i >= 0) { const u = { ...tasks[i], title: text, date, time, rems: rl }; cancelShown(u.id); clearFired(u.id); tasks[i] = u; }   // drop the old reminders, plan the new ones
  else { const id = Math.max(Date.now(), lastId + 1); lastId = id; tasks.push({ id, title: text, date, time, done: false, rems: rl }); }
  saveTasks(); askNotify();
  const d = dateVal; closeLayer('add'); title = ''; rems = new Set([0]);
  setSel(d, true); tasksChanged();   // follow the task to its (possibly new) day
}

/* ================================================================= UI: delete sheet */
const delScrim = h('div', { class: 'scrim del', onclick: () => closeLayer('del') });
const delQ = h('div', { class: 'q' }), delName = h('div', { class: 'n' });
const delBtn = h('button', { class: 'btn big warn', type: 'button', onclick: () => confirmDelete() });
const delCancel = h('button', { class: 'txtbtn', type: 'button', onclick: () => closeLayer('del') });
const delSheet = h('div', { class: 'sheet s-del' }, h('div', { class: 'grab' }), delQ, delName, delBtn, delCancel);
sheetDrag(delSheet, () => closeLayer('del'));
function updateDel() { delQ.textContent = T.delq; delBtn.textContent = T.del; delCancel.textContent = T.cancel; if (delTask) delName.textContent = delTask.title; }
function openDelete(t) {
  if (layers.some(l => l.id === 'del')) return;
  delTask = t; updateDel(); setOpen(delSheet, true); setOpen(delScrim, true);
  openLayer('del', () => { setOpen(delSheet, false); setOpen(delScrim, false); });
}
function confirmDelete() {
  const t = delTask; closeLayer('del'); if (!t) return;
  tasks = tasks.filter(x => x.id !== t.id); cancelShown(t.id); clearFired(t.id); saveTasks(); tasksChanged();
}

/* ================================================================= UI: time sheet (the clock dial) */
const pickScrim = h('div', { class: 'scrim pick', onclick: () => closeTop() });
const timeSheet = h('div', { class: 'sheet s-time' });
const dateSheet = h('div', { class: 'sheet s-date' });
sheetDrag(timeSheet, () => closeLayer('time')); sheetDrag(dateSheet, () => closeLayer('date'));

const SVGNS = 'http://www.w3.org/2000/svg';
const svgEl = (tag, attrs) => { const e = document.createElementNS(SVGNS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); return e; };

function buildTime(root, onSet) {
  let hh = -1, mm = 0, phase = 0, busy = false;   // nothing picked yet: the dial opens clean, handle on top
  const rot = new Val(0), len = new Val(100), fade = new Val(1);
  const hEl = h('button', { class: 'hm on', type: 'button', onclick: () => goHours() });
  const mEl = h('button', { class: 'hm', type: 'button', onclick: () => { if (phase === 0 && hh >= 0) goMinutes(); } });
  const svg = svgEl('svg', { viewBox: '0 0 260 260', width: 260, height: 260, 'aria-hidden': 'true' });
  const line = svgEl('line', { x1: 130, y1: 130, x2: 130, y2: 30, 'stroke-width': 2, style: 'stroke:var(--accent)' });
  const hub = svgEl('circle', { cx: 130, cy: 130, r: 4, style: 'fill:var(--accent)' });
  const knob = svgEl('circle', { cx: 130, cy: 30, r: 19, style: 'fill:var(--accent)' });
  svg.append(svgEl('circle', { cx: 130, cy: 130, r: 130, style: 'fill:var(--bg)' }), line, hub, knob);
  const nums = h('div', { class: 'nums' });
  const dial = h('div', { class: 'dial', role: 'group', 'aria-label': T.time }, svg, nums);
  const setBtn = h('button', { class: 'btn big', type: 'button', text: T.set, disabled: true, onclick: () => onSet(hh, mm) });
  const tin = h('input', { type: 'time', class: 'tin desk-only', 'aria-label': T.time });   // desktop: just type the time
  tin.addEventListener('input', () => {
    const m = /^(\d\d):(\d\d)$/.exec(tin.value); if (!m) return;
    hh = +m[1]; mm = +m[2]; header(); styleNums(); swing(tDeg(), tLen(), SPR_SNAP);
  });
  tin.addEventListener('keydown', e => { if (e.key === 'Enter' && hh >= 0) { e.preventDefault(); onSet(hh, mm); } });

  const draw = () => {
    const a = rot.v * Math.PI / 180, r = len.v, x = 130 + Math.sin(a) * r, y = 130 - Math.cos(a) * r;
    line.setAttribute('x2', x); line.setAttribute('y2', y); knob.setAttribute('cx', x); knob.setAttribute('cy', y);
  };
  rot.on = len.on = draw; fade.on = v => { nums.style.opacity = v; };
  const cur = () => phase === 0 ? hh : mm;
  const tDeg = () => phase === 0 ? (hh < 0 ? 0 : hh % 12 * 30) : mm / 5 * 30;
  const tLen = () => (phase === 1 || hh < 0 || (hh >= 1 && hh <= 12)) ? 100 : 62;
  const shortest = (from, to) => ((to - from) % 360 + 540) % 360 - 180;
  // angles run clockwise from the top, so counterclockwise means decreasing
  const ccwDelta = (from, to) => { const d = -(((from - to) % 360 + 360) % 360); return d < -350 ? d + 360 : d; };
  const swing = (deg, radius, spec, ccw = false) =>
    Promise.all([len.to(radius, spec), rot.to(rot.v + (ccw ? ccwDelta(rot.v, deg) : shortest(rot.v, deg)), spec)]);

  function renderNums() {
    nums.textContent = '';
    for (let i = 0; i < 12; i++) {
      const a = i * 30 * Math.PI / 180;
      const add = (v, label, r, small) => nums.append(h('div', { class: 'num' + (small ? ' sm' : ''), 'data-v': v, text: label,
        style: `left:${130 + r * Math.sin(a) - 19}px;top:${130 - r * Math.cos(a) - 19}px` }));
      if (phase === 0) { add(i === 0 ? 12 : i, String(i === 0 ? 12 : i), 100, false); const n = i === 0 ? 0 : i + 12; add(n, pad(n), 62, true); }
      else add(i * 5, pad(i * 5), 100, false);
    }
    styleNums();
  }
  const styleNums = () => nums.childNodes.forEach(n => n.classList.toggle('sel', Number(n.dataset.v) === cur()));
  function header() {
    hEl.textContent = hh < 0 ? '--' : pad(hh); mEl.textContent = hh < 0 ? '--' : pad(mm);
    hEl.classList.toggle('on', phase === 0); mEl.classList.toggle('on', phase === 1); setBtn.disabled = hh < 0;
    if (document.activeElement !== tin) tin.value = hh < 0 ? '' : `${pad(hh)}:${pad(mm)}`;
  }
  async function goMinutes(hold = 0) {
    if (busy) return; busy = true;
    swing(tDeg(), tLen(), SPR_SNAP);                                   // 1. settle onto the picked hour (runs during the hold)
    await sleep(hold);                                                 // 2. a short beat so the pick reads
    const glide = swing(mm / 5 * 30, 100, { ms: 520 }, true);          // 3. glide back to the top, always counterclockwise...
    await fade.to(0, { ms: 170 }); phase = 1; renderNums(); header();   //    ...while the numbers swap
    fade.to(1, { ms: 260 });
    await glide; busy = false;
  }
  async function goHours() {
    if (busy || phase === 0) return; busy = true;
    const glide = swing(hh < 0 ? 0 : hh % 12 * 30, (hh < 0 || (hh >= 1 && hh <= 12)) ? 100 : 62, { ms: 480 });
    await fade.to(0, { ms: 170 }); phase = 0; renderNums(); header();
    fade.to(1, { ms: 260 });
    await glide; busy = false;
  }
  function pick(e) {
    const r = dial.getBoundingClientRect(), dx = e.clientX - r.left - 130, dy = e.clientY - r.top - 130;
    const ang = (Math.atan2(dx, -dy) * 180 / Math.PI + 360) % 360, i = Math.round(ang / 30) % 12, before = cur();
    if (phase === 0) hh = Math.hypot(dx, dy) > 81 ? (i === 0 ? 12 : i) : (i === 0 ? 0 : i + 12); else mm = i * 5;
    if (cur() !== before) { swing(tDeg(), tLen(), SPR_SNAP); styleNums(); header(); }   // only when the number changes does the handle glide
  }
  let dragging = false;
  dial.addEventListener('pointerdown', e => {
    e.stopPropagation(); if (busy || e.button > 0) return;
    e.preventDefault(); dial.setPointerCapture(e.pointerId); dragging = true; pick(e);
  });
  dial.addEventListener('pointermove', e => { if (dragging) pick(e); });
  const up = () => { if (!dragging) return; dragging = false; if (phase === 0) goMinutes(200); };
  dial.addEventListener('pointerup', up); dial.addEventListener('pointercancel', up);

  root.textContent = '';
  root.append(h('div', { class: 'grab' }), h('div', { class: 'thead' }, hEl, h('div', { class: 'co', text: ':' }), mEl), dial, tin, setBtn);
  renderNums(); header(); draw(); nums.style.opacity = 1;
}
function openTimePick() {
  if (layers.some(l => l.id === 'time' || l.id === 'date')) return;
  input.blur();
  buildTime(timeSheet, (hh, mm) => { timeVal = { h: hh, m: mm }; closeLayer('time'); updateModal(); });
  setOpen(timeSheet, true); setOpen(pickScrim, true);
  if (desk.matches) setTimeout(() => { const i = timeSheet.querySelector('.tin'); if (i) i.focus({ preventScroll: true }); }, 300);
  openLayer('time', () => { setOpen(timeSheet, false); setOpen(pickScrim, false); });
}

/* ================================================================= UI: date sheet */
function buildDate(root, init, onSet) {
  let vm = D.month(init), pickD = init;
  const today = D.today(), tl = h('div', { class: 't' }), wd = h('div', { class: 'wd' }), grid = h('div', { class: 'dgrid' });
  buildWeekdays(wd);
  const render = () => {
    tl.textContent = monthName(vm); grid.textContent = '';
    const start = D.add(vm, -D.dow(vm));
    for (let i = 0; i < 42; i++) {
      const d = D.add(start, i), k = D.key(d);
      const c = h('div', { class: 'c' + (k === D.key(pickD) ? ' sel' : '') + (k === D.key(today) ? ' today' : '') + (d.getMonth() !== vm.getMonth() ? ' out' : ''), text: String(d.getDate()) });
      const cell = h('div', { class: 'cell' }, c);
      cell.addEventListener('click', () => { pickD = d; if (d.getMonth() !== vm.getMonth()) vm = D.month(d); render(); });
      grid.append(cell);
    }
  };
  root.textContent = '';
  root.append(h('div', { class: 'grab' }),
    h('div', { class: 'dhead' }, h('button', { type: 'button', 'aria-label': T.prev, onclick: () => { vm = D.addMonths(vm, -1); render(); } }, '‹'), tl,
      h('button', { type: 'button', 'aria-label': T.next, onclick: () => { vm = D.addMonths(vm, 1); render(); } }, '›')),
    wd, grid, h('button', { class: 'btn big', type: 'button', text: T.setd, onclick: () => onSet(pickD) }));
  render();
}
function openDatePick() {
  if (layers.some(l => l.id === 'time' || l.id === 'date')) return;
  input.blur();
  buildDate(dateSheet, dateVal, d => { dateVal = d; closeLayer('date'); updateModal(); });
  setOpen(dateSheet, true); setOpen(pickScrim, true);
  openLayer('date', () => { setOpen(dateSheet, false); setOpen(pickScrim, false); });
}

/* ================================================================= toast */
const toastEl = h('div', { class: 'toast', role: 'status', onclick: () => toastEl.classList.remove('show') }, h('b'), h('span'));
let toastTimer;
function toast(t, x) {
  toastEl.firstChild.textContent = t; toastEl.lastChild.textContent = x; toastEl.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => toastEl.classList.remove('show'), 7000);
}

/* ================================================================= glue */
function setDone(t, d) {
  const i = tasks.findIndex(x => x.id === t.id); if (i < 0) return;
  tasks[i] = { ...tasks[i], done: d }; saveTasks();
  if (d) cancelShown(t.id); else clearFired(t.id);
  tasksChanged();
}
function tasksChanged() { refreshDays(); styleGrids(); updateAllBtn(); renderAll(); }
function refreshText() {
  updateAllBtn(); updateMonthTitle(); buildWeekdays(); refreshDays(); renderAll(); updateModal(); updateDel(); renderDesk();
  fab.setAttribute('aria-label', T.add); themeBtn.setAttribute('aria-label', T.theme);
  prevBtn.setAttribute('aria-label', T.prev); nextBtn.setAttribute('aria-label', T.next);
}

let lastToday = D.key(now);
function tick() {
  now = new Date();
  const k = D.key(now); if (k !== lastToday) { lastToday = k; styleGrids(); refreshDays(); }
  updateLate(); if (screen === 1) updateCds(); if (adding) updateModalPassed();
  checkDue();
}
setInterval(tick, 1000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });

addEventListener('keydown', e => {
  if (e.key === 'Escape') { if (layers.length) { e.preventDefault(); closeTop(); } return; }
  if (layers.length || e.target.closest('input,textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === 'ArrowLeft') goDay(-1); else if (e.key === 'ArrowRight') goDay(1); else if (e.key === 'n' || e.key === 'N') { e.preventDefault(); openAdd(sel); }
  else if (e.key === 't' || e.key === 'T') { const t = D.today(); if (D.key(sel) !== D.key(t)) setSel(t, true); }
});
// a drag that began on a button/row must not also "click" it
addEventListener('click', e => { if (performance.now() < suppressUntil) { e.stopPropagation(); e.preventDefault(); } }, true);

/* keep the app inside the *visible* viewport (soft keyboard on iOS / Android) */
const rootEl = document.getElementById('root');
function fitViewport() {
  const v = window.visualViewport; if (!v || v.scale > 1.01) return;
  rootEl.style.height = v.height + 'px'; rootEl.style.transform = `translateY(${v.offsetTop}px)`;
}
if (window.visualViewport) { visualViewport.addEventListener('resize', fitViewport); visualViewport.addEventListener('scroll', fitViewport); fitViewport(); }

/* ================================================================= start */
shell.append(h('div', { class: 'main' }, top, cal, dayzone, dtools, keysHint), fab, allScrim, allScreen, addScrim, addSheet, delScrim, delSheet, pickScrim, timeSheet, dateSheet, toastEl);
lastId = tasks.reduce((a, t) => Math.max(a, t.id), 0);
document.documentElement.lang = lang; applyTheme();
buildWeekdays(); updateMonthTitle(); updateAllBtn(); placeLang(false);
monthPager.rebuild(D.mkey(ym)); dayPager.rebuild(D.key(sel));
renderAll(); updateModal(); updateDel(); updateFab(); renderDesk();
fab.setAttribute('aria-label', T.add); themeBtn.setAttribute('aria-label', T.theme); prevBtn.setAttribute('aria-label', T.prev); nextBtn.setAttribute('aria-label', T.next);
history.replaceState({ root: 1 }, '');

if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
if (new URLSearchParams(location.search).get('new') === '1') {          // the "New task" app shortcut
  history.replaceState({ root: 1 }, '', location.pathname); setTimeout(() => openAdd(D.today()), 50);
}
})();
