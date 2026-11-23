// NextRole — reads the collector output plus the curated list, and keeps the
// user's status and notes in localStorage on this device.

// Stored status values stay in Hebrew so statuses saved by the earlier version keep working.
const STATUSES = [
  ['טרם הוגש', 'Not applied'], ['שמרתי', 'Saved'], ['הוגש', 'Applied'], ['ראיון', 'Interview'],
  ['מטלת בית', 'Assignment'], ['הצעה', 'Offer'], ['נדחה', 'Rejected'], ['לא רלוונטי', 'Not relevant'],
];
const LABEL = Object.fromEntries(STATUSES);
const STATUS_CLASS = { 'טרם הוגש': 'none', 'שמרתי': 'saved', 'הוגש': 'applied', 'ראיון': 'interview', 'מטלת בית': 'assignment', 'הצעה': 'offer', 'נדחה': 'rejected', 'לא רלוונטי': 'irrelevant' };
const stTag = (s) => `plain st-${STATUS_CLASS[s] || 'none'}`;
// Same company, same tile color, every time.
const tileColor = (name = '') => `c${[...String(name)].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7) % 6 + 1}`;
const NONE = 'טרם הוגש', SAVED = 'שמרתי';
const ACTIVE = ['הוגש', 'ראיון', 'מטלת בית', 'הצעה'];
const ENDED = ['נדחה', 'לא רלוונטי'];
const CHIPS = [['all', 'All'], ['new', 'New'], ['progress', 'In progress']];
const LEVELS = ['Junior', 'Mid', 'Senior+'];
const SOURCES = [['any', 'Everything'], ['boards', 'Company sites'], ['posts', 'LinkedIn posts'], ['mine', 'Added by me']];

const STORE = 'nextrole-state-v1';
const MINE = 'nextrole-mine-v1';
const PREFS = 'nextrole-prefs-v1';
const NEW_DAYS = 4;

const read = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

let jobs = [];
let logos = {};
let state = read(STORE, {});
let mine = read(MINE, []);
const prefs = { levels: ['Junior', 'Mid'], source: 'any', name: '', goal: 5, reviewed: [], ...read(PREFS, {}) };
const FOLLOW_UP_DAYS = 7;
let chip = 'all';
let appsTab = 'active';
let query = '';
let loaded = false;
const open = new Set();

const get = (k) => state[k] || { s: NONE, n: '' };
const setStatus = (k, s) => { state[k] = { ...get(k), s, t: new Date().toISOString() }; write(STORE, state); };
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9א-ת]+/g, ' ').trim();
const daysAgo = (iso) => (Date.now() - new Date(iso).getTime()) / 864e5;
const fmtDate = (iso) => iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '';

function ago(iso) {
  if (!iso) return '';
  const d = Math.floor(daysAgo(iso));
  if (d < 1) return 'Today';
  if (d === 1) return '1 day ago';
  if (d < 14) return `${d} days ago`;
  if (d < 60) return `${Math.floor(d / 7)} weeks ago`;
  return `${Math.floor(d / 30)} months ago`;
}

function guessLevel(title = '') {
  if (/\b(intern|student|junior|jr|associate|entry)\b/i.test(title)) return 'Junior';
  if (/\b(senior|sr|staff|principal|lead|head|director|manager)\b/i.test(title)) return 'Senior+';
  return 'Mid';
}

function workplace(j) {
  const t = `${j.location || ''} ${j.title || ''} ${(j.description || j.about || '').slice(0, 3000)}`;
  if (/hybrid|היברידי/i.test(t)) return 'Hybrid';
  if (/\bremote\b|מהבית/i.test(t)) return 'Remote';
  if (/on[- ]?site|in[- ]office|from the office/i.test(t)) return 'On-site';
  return '';
}

function employment(j) {
  const t = `${j.title || ''} ${(j.description || '').slice(0, 3000)}`;
  if (/\bintern(ship)?\b|\bstudent\b|סטודנט/i.test(j.title || '')) return 'Internship';
  if (/part[- ]time|משרה חלקית/i.test(t)) return 'Part-time';
  if (/\bfreelance\b|\bcontract(or)? (role|position)\b/i.test(t)) return 'Contract';
  return 'Full-time';
}

// "Tel Aviv, Israel, Tel Aviv-Yafo, IL" -> "Tel Aviv"
function shortLoc(loc = '') {
  const parts = String(loc).split(/[,;|]/).map((x) => x.trim()).filter(Boolean);
  const city = parts.find((x) => !/^(israel|il|ישראל|remote)$/i.test(x));
  return (city || parts[0] || '').replace(/-Yafo$/i, '');
}

// LinkedIn in Hebrew: "Product Designer ב Acme, Inc. — Tel Aviv" -> "Product Designer"
const cleanTitle = (t = '') => String(t).replace(/\s+(ב|στο|bei|chez)\s+.*$/, '').trim() || t;

// Same key the collector uses for data/logos.json ("Wix.com Ltd." = "Wix").
const companyKey = (s = '') => s.toLowerCase()
  .replace(/\b(ltd|inc|llc|gmbh|technologies|technology|labs|group|israel|io|ai|global)\b|\.com|[^a-z0-9א-ת]/g, '');

// Company tile: the logo from the company's careers page when it is roughly square,
// else the icon of the company's site, else colored initials. Wide wordmarks would be
// unreadable at this size, and any image that fails falls back too.
function companyMark(name = '') {
  const mark = el('span', `mark ${tileColor(name)}`, initials(name));
  mark.setAttribute('aria-hidden', 'true');
  const l = logos[companyKey(name)];
  const tries = [];
  if (l?.logo) tries.push({ src: l.logo, ok: (w, h) => w >= 32 && w / h <= 1.6 });
  if (l?.site) tries.push({ src: `https://www.google.com/s2/favicons?domain=${new URL(l.site).hostname}&sz=128`, ok: (w) => w >= 32 });
  const next = () => {
    const t = tries.shift();
    if (!t) return;
    const img = new Image();
    img.alt = ''; img.decoding = 'async'; img.referrerPolicy = 'no-referrer';
    img.onload = () => {
      if (!t.ok(img.naturalWidth, img.naturalHeight)) return next();
      mark.textContent = ''; mark.classList.add('has-img'); mark.append(img);
    };
    img.onerror = next;
    img.src = t.src;
  };
  next();
  return mark;
}

function initials(name = '') {
  const words = String(name).replace(/[^\p{L}\p{N} ]+/gu, ' ').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

// linkedin.com/jobs/view/product-designer-at-acme-123456 -> "Acme"
function companyFromUrl(url = '') {
  const m = String(url).match(/\/jobs\/view\/[^/?#]*-at-([a-z0-9-]+?)-\d{6,}/i);
  if (m) return m[1].replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  const b = String(url).match(/(?:comeet\.com\/jobs|greenhouse\.io|lever\.co|ashbyhq\.com|workable\.com|smartrecruiters\.com)\/([^/?#]+)/i);
  return b ? b[1].replace(/[-_]+/g, ' ').replace(/\d+$/, '').trim().replace(/\b\w/g, (c) => c.toUpperCase()) : '';
}

// Pull a short requirements list out of a free-text description.
function requirementsFrom(desc = '') {
  const i = desc.search(/(requirements|qualifications|what you bring|what we.re looking for|you have|who you are|what you.ll need|what you need|your skills|about you)/i);
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
  const [collected, manual, logoData] = await Promise.all([fetchJson('data/jobs.json'), fetchJson('data/manual.json'), fetchJson('data/logos.json')]);
  logos = logoData || {};
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
  jobs = [...byName.values(), ...mine.map((m) => ({ ...m, source: 'mine' }))];
  const updated = collected?.updatedAt || manual?.updatedAt;
  updatedAt = updated;
  document.getElementById('updated').textContent = updated
    ? `Last updated ${new Date(updated).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`
    : 'Could not load the latest update.';
  loaded = true;
  render();
}

// How sure we are that the role is still open.
function trust(j) {
  if (j.source === 'mine') return { cls: '', text: `You added this on ${fmtDate(j.firstSeen)}.` };
  if (j.kind === 'post') return { cls: '', text: `LinkedIn post${j.author ? ` by ${j.author}` : ''}, found ${fmtDate(j.firstSeen)}. Best to message the author directly.` };
  if (j.status === 'closed') return { cls: 'warn', text: 'This role is no longer on the company site.' };
  const seen = j.lastSeen ? fmtDate(j.lastSeen) : '';
  if (j.source === 'auto' && !String(j.origin || '').startsWith('feed:')) return { cls: 'ok', text: `✓ Checked on the company's career site on ${seen}.` };
  if (j.source === 'auto') return { cls: '', text: `From ${j.via || 'a job feed'}, last seen ${seen}. Not confirmed on the company site, so check the link.` };
  return { cls: '', text: 'Added by hand. The company has no career site we check, so check the link before applying.' };
}

const isNew = (j) => j.source === 'auto' && j.firstSeen && daysAgo(j.firstSeen) <= NEW_DAYS;
const years = (j) => j.experience || j.minYears || null;
const needsFollowUp = (j) => { const st = get(j.key); return st.s === 'הוגש' && st.t && daysAgo(st.t) >= FOLLOW_UP_DAYS; };
// Week starts on Sunday, as in Israel.
const weekStart = () => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - d.getDay()); return d; };
const appliedThisWeek = () => jobs.filter((j) => { const st = get(j.key); return ACTIVE.includes(st.s) && st.t && new Date(st.t) >= weekStart(); }).length;
const reviewQueue = () => jobs.filter((j) => j.status !== 'closed' && isNew(j) && get(j.key).s === NONE
  && prefs.levels.includes(j.level || 'Mid') && !prefs.reviewed.includes(j.key)).sort(byDate);
const matches = (j) => !query || norm(`${j.company} ${j.title} ${j.location} ${j.author || ''}`).includes(norm(query));
const byDate = (a, b) => String(b.postedAt || b.firstSeen || '').localeCompare(String(a.postedAt || a.firstSeen || ''));

function homeItems() {
  return jobs.filter((j) => {
    const s = get(j.key).s;
    if (!matches(j)) return false;
    if (j.status === 'closed' && s === NONE) return false;
    if (ENDED.includes(s)) return false;
    if (!prefs.levels.includes(j.level || 'Mid')) return false;
    if (prefs.source === 'posts' && j.kind !== 'post') return false;
    if (prefs.source === 'mine' && j.source !== 'mine') return false;
    if (prefs.source === 'boards' && (j.kind === 'post' || j.source === 'mine' || String(j.origin || '').startsWith('feed:'))) return false;
    if (chip === 'new') return isNew(j);
    if (chip === 'progress') return ACTIVE.includes(s);
    return true;
  }).sort(byDate);
}

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const icon = (name) => { const i = el('span', `i i-${name}`); i.setAttribute('aria-hidden', 'true'); return i; };
const tag = (text, iconName, extra = '') => { const t = el('span', `tag ${extra}`.trim()); if (iconName) t.append(icon(iconName)); t.append(text); return t; };

function details(j) {
  const st = get(j.key);
  const b = el('div', 'details');
  b.id = `d-${j.key}`;
  const meta = [j.level, j.experience ? `${j.experience} years` : j.minYears ? `${j.minYears}+ years` : '', j.via && j.kind !== 'post' ? `via ${j.via}` : ''].filter(Boolean).join(' · ');
  if (meta) b.append(el('p', 't-small', meta));
  if (j.about) { const p = el('p', 'text', j.about); p.dir = 'auto'; b.append(p); }
  if (j.requirements?.length) {
    const ul = el('ul', 'req'); ul.dir = 'auto';
    j.requirements.forEach((x) => ul.append(el('li', null, x)));
    b.append(el('p', 'lbl', 'Requirements'), ul);
  }
  const t = trust(j); b.append(el('p', `trust ${t.cls}`, t.text));
  if (j.note && j.source === 'manual') { const n = el('p', 'text', j.note); n.dir = 'auto'; b.append(n); }

  const act = el('div', 'actions');
  const go = el('a', 'btn', j.kind === 'post' ? 'Open post ↗' : 'Open job ↗'); go.href = j.url; go.target = '_blank'; go.rel = 'noopener';
  const sel = el('select'); sel.setAttribute('aria-label', 'Status');
  STATUSES.forEach(([v, l]) => { const o = el('option', null, l); o.value = v; o.selected = v === st.s; sel.append(o); });
  sel.onchange = () => { setStatus(j.key, sel.value); render(); };
  act.append(go, sel);
  if (j.source === 'mine') {
    const del = el('button', 'btn ghost', 'Remove'); del.type = 'button';
    del.onclick = () => { mine = mine.filter((m) => m.key !== j.key); write(MINE, mine); jobs = jobs.filter((x) => x.key !== j.key); render(); };
    act.append(del);
  }
  const nt = el('textarea'); nt.dir = 'auto'; nt.placeholder = 'Notes: contact, interview date, what you sent…'; nt.value = st.n || '';
  nt.setAttribute('aria-label', 'Notes');
  let timer; nt.oninput = () => { clearTimeout(timer); timer = setTimeout(() => { state[j.key] = { ...get(j.key), n: nt.value }; write(STORE, state); }, 500); };
  const tools = el('div', 'actions');
  if (needsFollowUp(j)) {
    const fu = el('button', 'btn lime', 'I followed up'); fu.type = 'button';
    fu.onclick = () => { setStatus(j.key, 'הוגש'); render(); };
    tools.append(fu);
  }
  const who = j.company || j.author || '';
  const prompt = `Help me write a short, specific cover letter for the ${cleanTitle(j.title)} role${who ? ` at ${who}` : ''}.\nJob link: ${j.url}\n${j.about ? `About the role: ${j.about.slice(0, 600)}` : ''}`;
  const cl = el('a', 'btn ghost', 'Cover letter ↗'); cl.href = `https://claude.ai/new?q=${encodeURIComponent(prompt)}`; cl.target = '_blank'; cl.rel = 'noopener';
  tools.append(cl);
  if (who) {
    const fp = el('a', 'btn ghost', 'Find people ↗'); fp.target = '_blank'; fp.rel = 'noopener';
    fp.href = `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(`${who} design`)}`;
    tools.append(fp);
  }
  b.append(act, tools, nt);
  return b;
}

function openButton(j, inner) {
  const btn = el('button', 'open-btn'); btn.type = 'button';
  btn.setAttribute('aria-expanded', open.has(j.key));
  btn.setAttribute('aria-controls', `d-${j.key}`);
  btn.append(...inner);
  btn.onclick = () => { open.has(j.key) ? open.delete(j.key) : open.add(j.key); render(); };
  return btn;
}

function titles(j) {
  const box = el('span', 'titles');
  const t = el('span', 't-subtitle', cleanTitle(j.title)); t.dir = 'auto';
  const who = j.company || (j.kind === 'post' && j.author ? j.author : 'Company not listed');
  const s = el('span', 't-small', [who, shortLoc(j.location)].filter(Boolean).join(' · ')); s.dir = 'auto';
  box.append(t, s);
  return box;
}

// Home and Saved: component "Job card", Default
function jobCard(j) {
  const st = get(j.key);
  const c = el('article', 'card' + (j.status === 'closed' ? ' dim' : ''));
  const head = el('div', 'card-head');
  const mark = companyMark(j.company || j.author);
  const save = el('button', 'save'); save.type = 'button';
  const saved = st.s === SAVED;
  save.setAttribute('aria-pressed', saved);
  save.setAttribute('aria-label', `Save ${j.title}${j.company ? ` at ${j.company}` : ''}`);
  save.append(icon('bookmark'));
  save.onclick = () => { setStatus(j.key, saved ? NONE : SAVED); render(); };
  head.append(openButton(j, [mark, titles(j)]), save);

  const tags = el('div', 'tags');
  const wp = workplace(j);
  if (wp) tags.append(tag(wp, 'pin'));
  if (j.kind === 'post') tags.append(tag('LinkedIn post', 'clock'));
  else if (employment(j) !== 'Full-time') tags.append(tag(employment(j), 'clock'));
  const lv = j.level || 'Mid';
  tags.append(tag(lv, null, `plain lv-${lv.replace('+', '')}`));
  if (years(j)) tags.append(tag(`${years(j)}+ yrs`, null, 'plain yrs'));
  if (j.status === 'closed') tags.append(tag('Closed', null, 'plain danger'));
  else if (ACTIVE.includes(st.s)) tags.append(tag(LABEL[st.s], null, stTag(st.s)));
  else if (isNew(j)) tags.append(tag('New', null, 'plain new'));
  tags.append(el('span', 't-small', ago(j.postedAt || j.firstSeen)));
  c.append(head, tags);
  if (open.has(j.key)) c.append(details(j));
  return c;
}

// Applications: component "Job card", Variant2
function appCard(j) {
  const st = get(j.key);
  const c = el('article', 'card card-app');
  const head = el('div', 'card-head');
  head.append(openButton(j, [titles(j)]));
  const row = el('div', 'tags');
  row.append(tag(LABEL[st.s], null, stTag(st.s)));
  if (needsFollowUp(j)) row.append(tag('Follow up?', null, 'plain followup'));
  if (j.status === 'closed' && !ENDED.includes(st.s)) row.append(tag('Role closed', null, 'plain danger'));
  row.append(el('span', 't-small', ago(st.t || j.firstSeen)));
  c.append(head, el('div', 'divider'), row);
  if (open.has(j.key)) c.append(details(j));
  return c;
}

function fill(listId, items, make, emptyText) {
  const list = document.getElementById(listId);
  list.replaceChildren();
  if (!items.length) { list.append(el('p', 'empty', loaded ? emptyText : 'Loading jobs…')); return; }
  items.forEach((j) => list.append(make(j)));
}

function renderChips() {
  const mk = (box, items, isOn, onClick) => {
    box.replaceChildren();
    for (const [k, l] of items) {
      const b = el('button', 'tag chip', l); b.type = 'button'; b.setAttribute('aria-pressed', isOn(k));
      b.onclick = () => onClick(k); box.append(b);
    }
  };
  mk(document.getElementById('chips'), CHIPS, (k) => chip === k, (k) => { chip = k; render(); });
  mk(document.getElementById('lvl-chips'), LEVELS.map((l) => [l, l]), (k) => prefs.levels.includes(k), (k) => {
    prefs.levels = prefs.levels.includes(k) ? prefs.levels.filter((x) => x !== k) : [...prefs.levels, k];
    write(PREFS, prefs); render();
  });
  mk(document.getElementById('src-chips'), SOURCES, (k) => prefs.source === k, (k) => { prefs.source = k; write(PREFS, prefs); render(); });
  const custom = prefs.source !== 'any' || prefs.levels.join() !== 'Junior,Mid';
  document.getElementById('filter-dot').hidden = !custom;
}

function renderStats() {
  const live = jobs.filter((j) => j.status !== 'closed');
  const n = (f) => jobs.filter((j) => f(get(j.key).s)).length;
  const box = document.getElementById('stats'); box.replaceChildren();
  [[live.length, 'Open roles'], [live.filter(isNew).length, 'New'], [n((s) => ACTIVE.includes(s)), 'Applied'], [n((s) => s === 'ראיון' || s === 'מטלת בית'), 'Interviews']]
    .forEach(([v, l]) => { const s = el('div', 'stat'); s.append(el('b', null, v), el('span', 't-small', l)); box.append(s); });
}

let updatedAt = null;
const greeting = () => { const h = new Date().getHours(); return h < 5 ? 'Good night' : h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'; };

// Home header: what's new and where the search stands.
function renderHero() {
  const box = document.getElementById('hero'); box.replaceChildren();
  const fits = jobs.filter((j) => j.status !== 'closed' && prefs.levels.includes(j.level || 'Mid') && !ENDED.includes(get(j.key).s));
  const fresh = fits.filter(isNew).length;
  const n = (f) => jobs.filter((j) => f(get(j.key).s)).length;
  const hi = el('p', 'hero-hi', prefs.name ? `${greeting()}, ${prefs.name}` : greeting());
  const big = el('p', 'hero-big');
  if (!loaded) big.textContent = 'Checking for new roles…';
  else if (fresh) { const b = el('button', 'hero-link', `${fresh} new ${fresh === 1 ? 'role' : 'roles'}`); b.type = 'button'; b.onclick = () => { chip = 'new'; render(); }; big.append(b, ` for you this week`); }
  else big.textContent = `${fits.length} open roles, nothing new since yesterday`;
  const sub = el('p', 'hero-sub');
  if (updatedAt) sub.textContent = `${fits.length} open roles · checked ${new Date(updatedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
  const stats = el('div', 'hero-stats');
  [[n((s) => ACTIVE.includes(s)), 'Applied', '#applications'], [n((s) => s === 'ראיון' || s === 'מטלת בית'), 'Interviews', '#applications'], [n((s) => s === SAVED), 'Saved', '#saved']]
    .forEach(([v, l, href]) => { const a = el('a', 'hero-stat'); a.href = href; a.append(el('b', null, v), el('span', null, l)); stats.append(a); });
  // Weekly goal ring
  const done = appliedThisWeek(), goal = Math.max(1, prefs.goal || 5);
  const ring = el('a', 'goal'); ring.href = '#applications';
  ring.setAttribute('aria-label', `${done} of ${goal} applications this week`);
  const C = 2 * Math.PI * 30, frac = Math.min(1, done / goal);
  ring.innerHTML = `<svg viewBox="0 0 72 72" width="72" height="72" aria-hidden="true"><circle cx="36" cy="36" r="30" class="goal-track"/><circle cx="36" cy="36" r="30" class="goal-fill" stroke-dasharray="${C}" stroke-dashoffset="${C * (1 - frac)}"/></svg>`;
  const lbl = el('span', 'goal-lbl'); lbl.append(el('b', null, `${done}/${goal}`), el('span', null, 'this week'));
  lbl.setAttribute('aria-hidden', 'true'); ring.append(lbl);
  box.append(ring, hi, big, sub, stats);
  // Quick review of new roles
  const q = reviewQueue();
  if (loaded && q.length) {
    const rv = el('button', 'btn lime review-btn'); rv.type = 'button';
    rv.append(`Review ${q.length} new ${q.length === 1 ? 'role' : 'roles'}`, el('span', 'arrow', '→'));
    rv.onclick = openReview;
    box.append(rv);
  }
}

// Review: one new role at a time. Swipe right or Save to keep it, left or Skip to drop it.
let reviewList = [], reviewAt = 0;
function openReview() {
  reviewList = reviewQueue(); reviewAt = 0;
  const ov = document.getElementById('review'); ov.hidden = false; document.body.classList.add('lock');
  drawReview();
  ov.querySelector('.rv-close').focus();
}
function closeReview() {
  document.getElementById('review').hidden = true; document.body.classList.remove('lock'); render();
  document.getElementById('hero').querySelector('a, button')?.focus();
}
function decide(keep) {
  const j = reviewList[reviewAt]; if (!j) return;
  if (keep) setStatus(j.key, SAVED);
  prefs.reviewed = [...prefs.reviewed, j.key].slice(-500); write(PREFS, prefs);
  const card = document.querySelector('#review .rv-card');
  const go = () => { reviewAt++; drawReview(); };
  if (card && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    card.style.transition = 'transform .25s ease, opacity .25s ease';
    card.style.transform = `translateX(${keep ? 120 : -120}%) rotate(${keep ? 12 : -12}deg)`; card.style.opacity = '0';
    setTimeout(go, 220);
  } else go();
}
function drawReview() {
  const stage = document.getElementById('rv-stage'); stage.replaceChildren();
  const count = document.getElementById('rv-count');
  const j = reviewList[reviewAt];
  document.getElementById('rv-actions').hidden = !j;
  if (!j) {
    count.textContent = '';
    const done = el('div', 'rv-done');
    const saved = reviewList.filter((x) => get(x.key).s === SAVED).length;
    done.append(el('p', 'rv-done-big', 'All caught up'), el('p', 'hint', `You kept ${saved} of ${reviewList.length}. Kept roles are in Saved.`));
    const b = el('a', 'btn', 'Go to Saved'); b.href = '#saved'; b.onclick = () => closeReview();
    done.append(b); stage.append(done); return;
  }
  count.textContent = `${reviewAt + 1} of ${reviewList.length}`;
  const c = el('article', 'rv-card');
  const head = el('div', 'card-head'); head.append(companyMark(j.company || j.author), titles(j));
  const tags = el('div', 'tags');
  const wp = workplace(j); if (wp) tags.append(tag(wp, 'pin'));
  const lv = j.level || 'Mid'; tags.append(tag(lv, null, `plain lv-${lv.replace('+', '')}`));
  if (years(j)) tags.append(tag(`${years(j)}+ yrs`, null, 'plain yrs'));
  tags.append(el('span', 't-small', ago(j.postedAt || j.firstSeen)));
  c.append(head, tags);
  if (j.about) { const p = el('p', 'rv-about', j.about); p.dir = 'auto'; c.append(p); }
  if (j.requirements?.length) {
    const ul = el('ul', 'req'); ul.dir = 'auto'; j.requirements.slice(0, 4).forEach((x) => ul.append(el('li', null, x))); c.append(ul);
  }
  const link = el('a', 'rv-link', 'Read the full job ↗'); link.href = j.url; link.target = '_blank'; link.rel = 'noopener';
  c.append(link);
  // Drag to decide
  let x0 = null, dx = 0;
  c.addEventListener('pointerdown', (e) => { if (e.target.closest('a')) return; x0 = e.clientX; dx = 0; c.setPointerCapture(e.pointerId); c.style.transition = 'none'; });
  c.addEventListener('pointermove', (e) => {
    if (x0 == null) return; dx = e.clientX - x0;
    c.style.transform = `translateX(${dx}px) rotate(${dx / 20}deg)`;
    c.dataset.lean = dx > 40 ? 'keep' : dx < -40 ? 'skip' : '';
  });
  const end = () => {
    if (x0 == null) return; x0 = null;
    if (Math.abs(dx) > 100) return decide(dx > 0);
    c.style.transition = 'transform .2s ease'; c.style.transform = ''; c.dataset.lean = '';
  };
  c.addEventListener('pointerup', end); c.addEventListener('pointercancel', end);
  stage.append(c);
}

// Home list, in sections by the date shown on each card.
const thisWeek = (j) => { const d = j.postedAt || j.firstSeen; return d && daysAgo(d) <= 7; };
function renderHome(items) {
  const box = document.getElementById('home-list'); box.replaceChildren();
  if (!items.length) { box.append(el('p', 'empty', loaded ? (chip === 'progress' ? 'Nothing in progress yet. Set a status on a job to track it here.' : 'No roles match these filters.') : 'Loading jobs…')); return; }
  const groups = chip === 'all'
    ? [['This week', items.filter(thisWeek)], ['Earlier', items.filter((j) => !thisWeek(j))]]
    : [[null, items]];
  for (const [title, list] of groups) {
    if (!list.length) continue;
    const sec = el('section', 'group');
    if (title) {
      const h = el('h2', 'group-title'); h.append(title, el('span', 'group-n', list.length));
      if (title === 'This week') h.classList.add('is-new');
      sec.append(h);
    }
    const l = el('div', 'list'); list.forEach((j) => l.append(jobCard(j))); sec.append(l);
    box.append(sec);
  }
}

function render() {
  renderChips();
  const home = homeItems();
  document.getElementById('home-count').textContent = loaded ? `${home.length} ${home.length === 1 ? 'role' : 'roles'}` : '';
  renderHero();
  renderHome(home);

  const appsAll = jobs.filter((j) => matches(j) && (appsTab === 'active' ? ACTIVE.includes(get(j.key).s) : ENDED.includes(get(j.key).s)))
    .sort((a, b) => (needsFollowUp(b) - needsFollowUp(a)) || String(get(b.key).t || '').localeCompare(String(get(a.key).t || '')));
  document.getElementById('tab-active').setAttribute('aria-selected', appsTab === 'active');
  document.getElementById('tab-closed').setAttribute('aria-selected', appsTab === 'closed');
  const waiting = appsTab === 'active' ? appsAll.filter(needsFollowUp).length : 0;
  const fuNote = document.getElementById('apps-note');
  fuNote.hidden = !waiting;
  fuNote.textContent = waiting ? `${waiting} ${waiting === 1 ? 'application has' : 'applications have'} had no answer for over a week. A short follow-up note often gets a reply.` : '';
  fill('apps-list', appsAll, appCard, appsTab === 'active'
    ? 'No active applications. Open a job and set its status to Applied.'
    : 'Nothing closed yet. Jobs marked Rejected or Not relevant show here.');

  const saved = jobs.filter((j) => get(j.key).s === SAVED).sort(byDate);
  fill('saved-list', saved, jobCard, 'No saved jobs. Tap the bookmark on a job to keep it here.');
  renderStats();
}

// Views
const VIEWS = ['home', 'applications', 'saved', 'profile'];
function route() {
  const v = VIEWS.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'home';
  VIEWS.forEach((x) => { document.getElementById(`view-${x}`).hidden = x !== v; });
  document.querySelectorAll('.nav-item').forEach((a) => {
    if (a.dataset.view === v) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', route);

document.querySelectorAll('[data-search]').forEach((input) => input.addEventListener('input', (e) => {
  query = e.target.value;
  document.querySelectorAll('[data-search]').forEach((o) => { if (o !== e.target) o.value = query; });
  render();
}));

const filterBtn = document.getElementById('filter-open');
filterBtn.onclick = () => {
  const panel = document.getElementById('filter-panel');
  panel.hidden = !panel.hidden; filterBtn.setAttribute('aria-expanded', !panel.hidden);
};

const tabs = [['tab-active', 'active'], ['tab-closed', 'closed']];
tabs.forEach(([id, v]) => { document.getElementById(id).onclick = () => { appsTab = v; render(); }; });
document.querySelector('.toggle').addEventListener('keydown', (e) => {
  if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
  appsTab = appsTab === 'active' ? 'closed' : 'active'; render();
  document.getElementById(appsTab === 'active' ? 'tab-active' : 'tab-closed').focus();
});

// Add a job or post by link. Saved on this device.
const form = document.getElementById('add-form');
document.getElementById('add-url').addEventListener('change', (e) => {
  const c = document.getElementById('add-company');
  if (!c.value) c.value = companyFromUrl(e.target.value);
});
form.addEventListener('submit', (e) => {
  e.preventDefault();
  const url = document.getElementById('add-url').value.trim();
  const title = document.getElementById('add-title').value.trim() || 'Product Designer';
  const company = document.getElementById('add-company').value.trim() || companyFromUrl(url);
  const now = new Date().toISOString();
  const rec = { key: `mine:${Date.now()}`, url, title, company, location: '', level: guessLevel(title), firstSeen: now, postedAt: now, status: 'open', kind: /linkedin\.com\/(posts|feed)/i.test(url) ? 'post' : undefined };
  mine = [rec, ...mine]; write(MINE, mine);
  jobs = [{ ...rec, source: 'mine' }, ...jobs];
  setStatus(rec.key, SAVED);
  form.reset(); document.getElementById('add-title').value = 'Product Designer';
  open.add(rec.key); location.hash = '#saved'; render();
});

document.querySelector('#review .rv-close').onclick = closeReview;
document.getElementById('rv-skip').onclick = () => decide(false);
document.getElementById('rv-keep').onclick = () => decide(true);
document.addEventListener('keydown', (e) => {
  if (document.getElementById('review').hidden) return;
  if (e.key === 'Escape') closeReview();
  if (e.key === 'ArrowLeft') decide(false);
  if (e.key === 'ArrowRight') decide(true);
});
const goalInput = document.getElementById('my-goal');
goalInput.value = prefs.goal;
goalInput.addEventListener('input', () => { const v = parseInt(goalInput.value, 10); if (v > 0) { prefs.goal = v; write(PREFS, prefs); renderHero(); } });

const nameInput = document.getElementById('my-name');
nameInput.value = prefs.name;
nameInput.addEventListener('input', () => { prefs.name = nameInput.value.trim(); write(PREFS, prefs); renderHero(); });

route();
render();
init();
