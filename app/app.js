// NextRole — placeholder UI. Reads the collector output plus the curated list,
// and keeps the user's status and notes in localStorage on this device.

const STATUSES = ['טרם הוגש', 'שמרתי', 'הוגש', 'ראיון', 'מטלת בית', 'הצעה', 'נדחה', 'לא רלוונטי'];
const ACTIVE = ['הוגש', 'ראיון', 'מטלת בית', 'הצעה'];
const FILTERS = [
  ['fit', 'מתאים לי'], ['new', 'חדשות'], ['saved', 'שמרתי'], ['active', 'בתהליך'],
  ['Junior', 'Junior'], ['Mid', 'Mid'], ['Senior+', 'Senior+'], ['all', 'הכל'],
];
const NEW_DAYS = 4;
const STORE = 'nextrole-state-v1';

let jobs = [];
let state = load();
let filter = 'fit';
let query = '';
const open = new Set();

function load() { try { return JSON.parse(localStorage.getItem(STORE) || '{}'); } catch { return {}; } }
function persist() { try { localStorage.setItem(STORE, JSON.stringify(state)); } catch {} }
const get = (k) => state[k] || { s: 'טרם הוגש', n: '' };

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9א-ת]+/g, ' ').trim();
const daysAgo = (iso) => (Date.now() - new Date(iso).getTime()) / 864e5;
const fmtDate = (iso) => iso ? new Date(iso).toLocaleDateString('he-IL', { day: 'numeric', month: 'numeric', year: '2-digit' }) : '';

// Pull a short requirements list out of a free-text description.
function requirementsFrom(desc = '') {
  const i = desc.search(/(requirements|qualifications|what you bring|what we.re looking for|you have|who you are|what you.ll need|what you need|your skills|about you|this is the perfect job)/i);
  if (i < 0) return [];
  return desc.slice(i).split(/\n|•|(?<=[.!])\s+(?=[A-Z])/)
    .map((s) => s.replace(/^[\s\-–•*]+/, '').trim())
    .filter((s) => s.length > 12 && s.length < 220)
    .slice(1, 8);
}

async function fetchJson(path) {
  try { const r = await fetch(`${path}?v=${Date.now()}`, { cache: 'no-store' }); return r.ok ? r.json() : null; } catch { return null; }
}

async function init() {
  const [collected, manual] = await Promise.all([fetchJson('data/jobs.json'), fetchJson('data/manual.json')]);
  const byName = new Map();
  for (const j of collected?.jobs || []) {
    const rec = { ...j, about: (j.description || '').slice(0, 260), requirements: requirementsFrom(j.description), origin: j.source, source: 'auto' };
    byName.set(norm(j.company) + '|' + norm(j.title), rec);
  }
  for (const j of manual?.jobs || []) {
    if (j.status === 'merged') continue; // the company board's own listing is shown instead
    const k = norm(j.company) + '|' + norm(j.title);
    const auto = byName.get(k);
    if (auto) { auto.about = j.about || auto.about; if (j.requirements?.length) auto.requirements = j.requirements; auto.note = j.note; auto.experience = j.experience; }
    else byName.set(k, { ...j, firstSeen: j.firstSeen || j.postedAt });
  }
  jobs = [...byName.values()];
  const updated = collected?.updatedAt || manual?.updatedAt;
  document.getElementById('updated').textContent =
    `UX ו-Product Design בישראל · עודכן ${updated ? new Date(updated).toLocaleString('he-IL', { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'}`;
  render();
}

// How sure we are that the role is still open.
function trust(j) {
  if (j.status === 'closed') return { ok: false, text: 'המשרה ירדה מאתר החברה או לא נראתה כבר שבוע' };
  const seen = j.lastSeen ? fmtDate(j.lastSeen) : '';
  if (j.source === 'auto' && !String(j.origin || '').startsWith('feed:')) return { ok: true, text: `✓ נבדק באתר הגיוס של החברה ב-${seen}` };
  if (j.source === 'auto') return { ok: false, text: `מ-${j.via || 'פיד'} · נראה לאחרונה ב-${seen} · לא מאומת מול אתר החברה, כדאי לבדוק בקישור` };
  return { ok: false, text: 'נוסף ידנית · אין לחברה אתר גיוס שאנחנו בודקים, כדאי לבדוק בקישור לפני הגשה' };
}

const isNew = (j) => j.source === 'auto' && j.firstSeen && daysAgo(j.firstSeen) <= NEW_DAYS;

function pass(j) {
  const s = get(j.key).s;
  if (query && !norm(`${j.company} ${j.title} ${j.location}`).includes(norm(query))) return false;
  if (j.status === 'closed' && s === 'טרם הוגש') return false;
  switch (filter) {
    case 'fit': return j.level !== 'Senior+' && !['נדחה', 'לא רלוונטי'].includes(s);
    case 'new': return isNew(j);
    case 'saved': return s === 'שמרתי';
    case 'active': return ACTIVE.includes(s);
    case 'all': return true;
    default: return j.level === filter;
  }
}

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

function renderStats() {
  const openJobs = jobs.filter((j) => j.status !== 'closed');
  const count = (f) => jobs.filter((j) => f(get(j.key).s)).length;
  const box = document.getElementById('stats'); box.replaceChildren();
  [[openJobs.length, 'משרות'], [openJobs.filter(isNew).length, 'חדשות'], [count((s) => ACTIVE.includes(s)), 'הגשתי'], [count((s) => s === 'ראיון' || s === 'מטלת בית'), 'בראיונות']]
    .forEach(([n, l]) => { const s = el('div', 'stat'); s.append(el('b', null, n), l); box.append(s); });
}

function renderChips() {
  const box = document.getElementById('chips'); box.replaceChildren();
  for (const [k, l] of FILTERS) {
    const b = el('button', 'chip', l); b.type = 'button'; b.setAttribute('aria-pressed', filter === k);
    b.onclick = () => { filter = k; render(); }; box.append(b);
  }
}

function card(j) {
  const st = get(j.key);
  const c = el('article', 'card' + (['נדחה', 'לא רלוונטי'].includes(st.s) || j.status === 'closed' ? ' dim' : ''));
  const top = el('button', 'top'); top.type = 'button'; top.setAttribute('aria-expanded', open.has(j.key));
  const r1 = el('div', 'row1'); r1.append(el('div', 'title', j.title), el('span', `lvl ${j.level || 'Mid'}`, j.level || 'Mid'));
  const meta = el('div', 'meta');
  meta.append(el('span', 'company', j.company || 'חברה לא צוינה'), el('span', null, j.location));
  if (j.via) meta.append(el('span', null, `דרך ${j.via.replace(/^Google Jobs · /, '')}`));
  const when = j.postedAt || j.firstSeen; if (when) meta.append(el('span', null, fmtDate(when)));
  const yrs = j.experience || (j.minYears ? `${j.minYears}+` : null); if (yrs) meta.append(el('span', null, `${yrs} שנים`));
  if (isNew(j)) meta.append(el('span', 'tag new', 'חדש'));
  if (j.status === 'closed') meta.append(el('span', 'tag closed', 'נסגרה'));
  if (st.s !== 'טרם הוגש') meta.append(el('span', 'tag' + (st.s === 'נדחה' ? ' no' : ''), st.s));
  top.append(r1, meta);
  top.onclick = () => { open.has(j.key) ? open.delete(j.key) : open.add(j.key); render(); };
  c.append(top);

  if (open.has(j.key)) {
    const b = el('div', 'body');
    if (j.about) { const a = el('div'); a.append(el('p', 'lbl', 'על החברה והתפקיד'), el('p', 'text' + (/[א-ת]/.test(j.about) ? '' : ' ltr'), j.about)); b.append(a); }
    if (j.requirements?.length) {
      const r = el('div'); r.append(el('p', 'lbl', 'דרישות')); const ul = el('ul', 'req');
      j.requirements.forEach((x) => ul.append(el('li', null, x))); r.append(ul); b.append(r);
    }
    b.append(el('p', 'trust' + (trust(j).ok ? ' ok' : ''), trust(j).text));
    if (j.note && j.source === 'manual') b.append(el('p', 'text', j.note));
    const act = el('div', 'actions');
    const go = el('a', 'go', 'למשרה ↗'); go.href = j.url; go.target = '_blank'; go.rel = 'noopener';
    const sel = el('select'); sel.id = 's-' + j.key; sel.setAttribute('aria-label', 'סטטוס');
    STATUSES.forEach((s) => { const o = el('option', null, s); o.value = s; o.selected = s === st.s; sel.append(o); });
    sel.onchange = () => { state[j.key] = { ...get(j.key), s: sel.value, t: new Date().toISOString() }; persist(); render(); };
    act.append(go, sel);
    const nt = el('textarea'); nt.id = 'n-' + j.key; nt.placeholder = 'הערות: איש קשר, תאריך ראיון, מה שלחתי…'; nt.value = st.n || '';
    let t; nt.oninput = () => { clearTimeout(t); t = setTimeout(() => { state[j.key] = { ...get(j.key), n: nt.value }; persist(); renderStats(); }, 600); };
    b.append(act, nt); c.append(b);
  }
  return c;
}

function render() {
  renderStats(); renderChips();
  const list = document.getElementById('list'); list.replaceChildren();
  const items = jobs.filter(pass).sort((a, b) =>
    (isNew(b) - isNew(a)) || String(b.postedAt || b.firstSeen || '').localeCompare(String(a.postedAt || a.firstSeen || '')));
  if (!items.length) { list.append(el('p', 'empty', jobs.length ? 'אין משרות בסינון הזה.' : 'טוען…')); return; }
  items.forEach((j) => list.append(card(j)));
}

document.getElementById('q').addEventListener('input', (e) => { query = e.target.value; render(); });
init();
