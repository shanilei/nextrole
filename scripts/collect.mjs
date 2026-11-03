#!/usr/bin/env node
// Collects UX / product design openings in Israel from company job boards and from
// multi-company feeds (Secret Tel Aviv, Google Jobs). Writes data/jobs.json (all tracked
// jobs, open and closed), data/boards.json (resolved boards) and data/report.json.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { adapters, NotFound, PROBE_ORDER } from './lib/ats.mjs';
import { secretTelAviv, googleSearch } from './lib/feeds.mjs';
import { nameFromBoard } from './lib/discover.mjs';
import { isDesignRole, isInIsrael, guessLevel, minYears } from './lib/filters.mjs';

const ROOT = new URL('..', import.meta.url);
const path = (p) => new URL(p, ROOT);
const readJson = async (p, fallback) => {
  try { return JSON.parse(await readFile(path(p), 'utf8')); } catch { return fallback; }
};

const CONCURRENCY = 8;
const FEED_STALE_DAYS = 7; // a feed job unseen this long is treated as closed
const MANUAL_MAX_DAYS = 45; // a hand-added job with no company board to check closes after this
const POST_MAX_DAYS = 14; // a LinkedIn hiring post is shown for two weeks
const PROBE_PER_RUN = 25; // unknown companies to look up per run
const PROBE_RETRY_DAYS = 21; // don't re-probe a company whose board wasn't found for this long
const now = new Date().toISOString();

async function pool(items, worker) {
  const results = [];
  let i = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (i < items.length) { const idx = i++; results[idx] = await worker(items[idx]); }
  }));
  return results;
}

async function probe(company) {
  const errors = [];
  for (const id of company.candidates || []) {
    for (const ats of PROBE_ORDER) {
      try {
        const jobs = await adapters[ats](id);
        if (jobs.length > 0) return { ats, id, jobs };
      } catch (e) {
        if (!(e instanceof NotFound)) errors.push(`${ats}:${id} ${e.message}`);
      }
    }
  }
  return { errors };
}

// "Wix.com Ltd." and "Wix" are the same company for matching purposes.
export const companyKey = (s = '') => s.toLowerCase()
  .replace(/\b(ltd|inc|llc|gmbh|technologies|technology|labs|group|israel|io|ai|global)\b|\.com|[^a-z0-9א-ת]/g, '');
const titleKey = (s = '') => s.toLowerCase().replace(/[^a-z0-9א-ת]/g, '');
const dupKey = (j) => `${companyKey(j.company)}|${titleKey(j.title)}`;

// Some feeds (Secret Tel Aviv) omit the company. Postings almost always name it near the
// top of the description, so look for a watched company there: first among companies
// with a board job of the same title, then among all watched companies.
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export function inferCompany(j, boardByTitle, companies) {
  const head = (j.description || '').slice(0, 600);
  // Case-sensitive on purpose: "NICE" and "Via" are companies, "nice" and "via" are words.
  const mentions = (name) => name.length > 2 && new RegExp(`(^|[^A-Za-z0-9])${escapeRe(name)}([^A-Za-z0-9]|$)`).test(head);
  for (const name of boardByTitle.get(titleKey(j.title)) || []) if (mentions(name)) return name;
  const hits = companies.map((c) => c.name).filter(mentions).sort((a, b) => b.length - a.length);
  if (hits[0]) return hits[0];
  // A long, specific title held by exactly one board ("Charm Security-Product Designer")
  // is the same job; short generic ones ("Senior Product Designer") are not.
  const sameTitle = boardByTitle.get(titleKey(j.title)) || [];
  if (sameTitle.length === 1 && (j.title || '').length >= 24) return sameTitle[0];
  return null;
}

// 'closed' when a job page is gone (404/410) or says the role is no longer open;
// 'open' otherwise, including when the site can't be reached (we don't close on doubt).
const CLOSED_TEXT = /no longer (accepting applications|available|open)|position (has been|is) (filled|closed)|job (is )?(closed|expired|not found)|this job (has expired|is no longer)|המשרה (אינה|לא) (זמינה|רלוונטית|פעילה)|המשרה נסגרה|(job|posting|listing) (has )?expired|this posting has expired/i;
export async function linkState(url) {
  try {
    const res = await fetch(url, { redirect: 'follow', headers: { 'user-agent': 'Mozilla/5.0 (nextrole job radar)' }, signal: AbortSignal.timeout(15000) });
    if (res.status === 404 || res.status === 410) return 'closed';
    if (!res.ok) return 'unknown';
    const html = (await res.text()).slice(0, 200000);
    const text = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ');
    return CLOSED_TEXT.test(text) ? 'closed' : 'open';
  } catch { return 'unknown'; }
}

// Is this job (from a feed or the hand-added list) listed on its company's board today?
// Matches on company plus title, tolerating suffixes like " - Base44" or "(UX/UI)".
export function onCheckedBoard(j, checked) {
  const tk = titleKey(j.title);
  if (!tk) return false;
  const ck = companyKey(j.company);
  const candidates = checked.get(ck)?.jobs || [];
  // Also catch sub-brands posted under a parent board ("Base44" jobs on Wix's board).
  const extra = ck ? [...checked.values()].flatMap((b) => b.jobs.filter((x) => titleKey(x.title).includes(ck))) : [];
  return [...candidates, ...extra].some((b) => {
    const bk = titleKey(b.title);
    return bk === tk || (tk.length >= 12 && (bk.includes(tk) || tk.includes(bk)));
  });
}

function upsert(byKey, j, extra) {
  const prev = byKey.get(j.key);
  byKey.set(j.key, {
    ...j,
    ...extra,
    level: guessLevel(j.title, j.description),
    minYears: minYears(j.description),
    firstSeen: prev?.firstSeen || now,
    lastSeen: now,
    status: 'open',
    closedAt: undefined,
  });
}

async function main() {
  const { companies: listed } = await readJson('companies.json', { companies: [] });
  const boards = await readJson('data/boards.json', {});
  // Boards found through search on earlier runs are checked like listed companies.
  const discovered = await readJson('data/discovered.json', { boards: [] });
  const known = new Set(listed.filter((c) => c.ats).map((c) => `${c.ats}:${String(c.id).toLowerCase()}`));
  for (const b of Object.values(boards)) known.add(`${b.ats}:${String(b.id).toLowerCase()}`);
  const companies = [...listed];
  for (const b of discovered.boards) {
    const k = `${b.ats}:${String(b.id).toLowerCase()}`;
    if (!known.has(k)) { known.add(k); companies.push({ name: b.name, ats: b.ats, id: b.id, discovered: true }); }
  }
  const previous = await readJson('data/jobs.json', { jobs: [] });
  const byKey = new Map(previous.jobs.map((j) => [j.key, j]));
  const report = { runAt: now, companies: [], feeds: [] };

  // 1. Company boards
  const fetched = await pool(companies, async (c) => {
    const entry = { company: c.name };
    try {
      let ats = c.ats, id = c.id, jobs;
      if (!ats && boards[c.name]) ({ ats, id } = boards[c.name]);
      if (ats) {
        jobs = await adapters[ats](id);
      } else {
        const hit = await probe(c);
        if (!hit.jobs) { Object.assign(entry, { status: 'not_found', tried: c.candidates, errors: hit.errors?.slice(0, 3) }); return { c, entry, jobs: null }; }
        ({ ats, id, jobs } = hit);
        boards[c.name] = { ats, id, detectedAt: now };
        entry.detected = true;
      }
      const matches = jobs.filter((j) => isDesignRole(j.title) && isInIsrael(j.location));
      Object.assign(entry, { status: 'ok', ats, id, total: jobs.length, matches: matches.length });
      return { c, entry, jobs: matches, source: `${ats}:${id}` };
    } catch (e) {
      Object.assign(entry, { status: 'error', error: String(e.message || e) });
      return { c, entry, jobs: null };
    }
  });

  const boardKeys = new Set();
  const boardByTitle = new Map(); // titleKey -> [company names], for feeds that omit the company
  const checked = new Map(); // companyKey -> { name, jobs } for every board that answered today
  for (const { c, entry, jobs, source } of fetched) {
    report.companies.push(entry);
    if (!jobs) continue; // board failed this run: keep its jobs as they were
    checked.set(companyKey(c.name), { name: c.name, jobs: [...(checked.get(companyKey(c.name))?.jobs || []), ...jobs] });
    const seen = new Set();
    for (const j of jobs) {
      seen.add(j.key);
      boardKeys.add(dupKey({ ...j, company: c.name }));
      const tk = titleKey(j.title);
      boardByTitle.set(tk, [...(boardByTitle.get(tk) || []), c.name]);
      upsert(byKey, j, { company: c.name, source });
    }
    // Jobs from this board that disappeared from it are closed.
    for (const [key, j] of byKey) {
      if (j.source === source && j.status === 'open' && !seen.has(key)) byKey.set(key, { ...j, status: 'closed', closedAt: now });
    }
  }

  // 2. Feeds. A feed job that duplicates a company-board job is dropped: the board is the better source.
  const feeds = [['secrettlv', () => secretTelAviv()]];
  if (process.env.SERPAPI_KEY) feeds.push(['google', async () => {
    const r = await googleSearch(process.env.SERPAPI_KEY);
    report.googleSearches = r.searches;
    report.googleQueries = r.perQuery;
    console.log('[google]', JSON.stringify(r.perQuery, null, 1));
    const fresh = r.boards.filter((b) => !known.has(`${b.ats}:${String(b.id).toLowerCase()}`));
    for (const b of fresh) {
      known.add(`${b.ats}:${String(b.id).toLowerCase()}`);
      discovered.boards.push({ name: nameFromBoard(b), ats: b.ats, id: b.id, foundAt: now, from: b.url });
    }
    report.newBoards = fresh.map((b) => `${b.ats}:${b.id}`);
    return r.jobs;
  }]);
  else report.feeds.push({ feed: 'google', status: 'skipped', reason: 'SERPAPI_KEY not set' });

  for (const [name, run] of feeds) {
    try {
      const all = await run();
      if (process.env.DEBUG_FEEDS) console.log(`[debug] ${name} sample:`, JSON.stringify(all.slice(0, 2), null, 1).slice(0, 1500));
      const matches = all.filter((j) => isDesignRole(j.title) && (isInIsrael(j.location) || name === 'secrettlv'));
      let added = 0, dup = 0, gone = 0;
      const seenDup = new Set();
      for (const j of matches) {
        if (!j.company) j.company = inferCompany(j, boardByTitle, companies) || '';
        const dk = dupKey(j);
        if (boardKeys.has(dk) || seenDup.has(dk) || onCheckedBoard(j, checked)) { dup++; continue; }
        // The company's own board answered today and does not list this role: the
        // repost on LinkedIn / Secret Tel Aviv is out of date.
        if (j.kind !== 'post' && checked.has(companyKey(j.company))) { gone++; continue; }
        seenDup.add(dk);
        upsert(byKey, j, { source: `feed:${name}` });
        added++;
      }
      report.feeds.push({ feed: name, status: 'ok', total: all.length, matches: matches.length, added, duplicates: dup, notOnCompanyBoard: gone });
    } catch (e) {
      report.feeds.push({ feed: name, status: 'error', error: String(e.message || e) });
    }
  }
  // Feed jobs unseen for a while, or that their company's own board no longer lists, are closed.
  const stale = Date.now() - FEED_STALE_DAYS * 864e5;
  for (const [key, j] of byKey) {
    if (!j.source?.startsWith('feed:') || j.status !== 'open') continue;
    if (j.kind === 'post') {
      if (Date.now() - new Date(j.firstSeen).getTime() > POST_MAX_DAYS * 864e5) byKey.set(key, { ...j, status: 'closed', closedAt: now, closedReason: 'post older than two weeks' });
      continue;
    }
    if (new Date(j.lastSeen).getTime() < stale) byKey.set(key, { ...j, status: 'closed', closedAt: now, closedReason: 'not seen for a week' });
    else if (checked.has(companyKey(j.company)) && !onCheckedBoard(j, checked)) byKey.set(key, { ...j, status: 'closed', closedAt: now, closedReason: 'not on company board' });
    else if (onCheckedBoard(j, checked)) byKey.delete(key); // the board's own listing covers it
  }

  // 3. Hand-added jobs (data/manual.json) are checked against the company boards too.
  const manual = await readJson('data/manual.json', { jobs: [] });
  const manualReport = { open: 0, onBoard: 0, closed: 0, unverified: 0 };
  for (const m of manual.jobs) {
    if (m.status === 'closed' || m.status === 'merged') { manualReport.closed++; continue; }
    const board = checked.get(companyKey(m.company));
    if (board) {
      if (onCheckedBoard(m, checked)) { m.status = 'merged'; m.mergedAt = now; manualReport.onBoard++; }
      else { m.status = 'closed'; m.closedAt = now; m.closedReason = 'not on company board'; manualReport.closed++; }
      continue;
    }
    const since = new Date(m.postedAt || m.addedAt || manual.updatedAt).getTime();
    if (Date.now() - since > MANUAL_MAX_DAYS * 864e5) { m.status = 'closed'; m.closedAt = now; m.closedReason = 'older than 45 days, no company board to check'; manualReport.closed++; }
    else { m.status = 'open'; m.verified = false; manualReport.unverified++; }
  }
  report.manual = manualReport;

  // 4. Find the career site of companies we only know from feeds or the hand-added list,
  //    so their roles can be checked on the company's own board from the next run on.
  const probed = await readJson('data/probed.json', {});
  const unknownCompanies = new Map();
  for (const j of [...byKey.values(), ...manual.jobs]) {
    if (j.status !== 'open' || !j.company || j.kind === 'post') continue;
    const ck = companyKey(j.company);
    if (!ck || checked.has(ck) || listed.some((c) => companyKey(c.name) === ck)) continue;
    if (probed[ck] && Date.now() - new Date(probed[ck]).getTime() < PROBE_RETRY_DAYS * 864e5) continue;
    unknownCompanies.set(ck, j.company);
  }
  const toProbe = [...unknownCompanies.values()].slice(0, PROBE_PER_RUN);
  const found = [];
  await pool(toProbe, async (name) => {
    const slug = name.toLowerCase().replace(/&/g, 'and');
    const candidates = [...new Set([
      slug.replace(/[^a-z0-9]/g, ''), slug.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
      slug.replace(/\b(ltd|inc|technologies|labs|group|israel)\b/g, '').replace(/[^a-z0-9]/g, ''),
    ])].filter((c) => c.length > 1);
    const hit = await probe({ name, candidates });
    probed[companyKey(name)] = now;
    if (hit.jobs) {
      const k = `${hit.ats}:${String(hit.id).toLowerCase()}`;
      if (!known.has(k)) { known.add(k); discovered.boards.push({ name, ats: hit.ats, id: hit.id, foundAt: now, from: 'probe' }); found.push(`${name} → ${hit.ats}:${hit.id}`); }
    }
  });
  report.probe = { tried: toProbe.length, found };

  // 5. Roles we cannot check on a company board: make sure the link itself still works.
  const linkTargets = [
    ...[...byKey.values()].filter((j) => j.status === 'open' && j.source?.startsWith('feed:') && j.kind !== 'post'),
    ...manual.jobs.filter((m) => m.status === 'open'),
  ].filter((j) => j.url && !/linkedin\.com/i.test(j.url));
  const dead = [];
  await pool(linkTargets, async (j) => {
    const state = await linkState(j.url);
    if (state !== 'closed') { j.linkCheckedAt = now; return; }
    dead.push(`${j.company} — ${j.title}`);
    if (byKey.has(j.key)) byKey.set(j.key, { ...byKey.get(j.key), status: 'closed', closedAt: now, closedReason: 'link no longer works' });
    else Object.assign(j, { status: 'closed', closedAt: now, closedReason: 'link no longer works' });
  });
  report.linkCheck = { checked: linkTargets.length, closed: dead };

  await writeFile(path('data/manual.json'), JSON.stringify(manual, null, 2) + '\n');
  await writeFile(path('data/probed.json'), JSON.stringify(probed, null, 2) + '\n');

  const jobs = [...byKey.values()].map(({ closedAt, ...j }) => (closedAt ? { ...j, closedAt } : j)).sort((a, b) =>
    (a.status === b.status ? 0 : a.status === 'open' ? -1 : 1) ||
    String(b.postedAt || b.firstSeen).localeCompare(String(a.postedAt || a.firstSeen)));

  const open = jobs.filter((j) => j.status === 'open');
  report.summary = {
    companies: companies.length,
    boardsOk: report.companies.filter((r) => r.status === 'ok').length,
    notFound: report.companies.filter((r) => r.status === 'not_found').map((r) => r.company),
    errors: report.companies.filter((r) => r.status === 'error').map((r) => `${r.company}: ${r.error}`),
    feeds: report.feeds.map((f) => `${f.feed}: ${f.status}${f.added != null ? ` +${f.added} (dup ${f.duplicates})` : ''}${f.error ? ` ${f.error}` : ''}${f.reason ? ` ${f.reason}` : ''}`),
    newBoards: report.newBoards || [],
    manual: report.manual,
    probe: report.probe,
    linkCheck: { checked: report.linkCheck?.checked, closed: report.linkCheck?.closed },
    openJobs: open.length,
    newToday: open.filter((j) => j.firstSeen === now).length,
  };

  await mkdir(path('data/'), { recursive: true });
  await writeFile(path('data/jobs.json'), JSON.stringify({ updatedAt: now, jobs }, null, 2) + '\n');
  await writeFile(path('data/boards.json'), JSON.stringify(boards, null, 2) + '\n');
  await writeFile(path('data/report.json'), JSON.stringify(report, null, 2) + '\n');
  await writeFile(path('data/discovered.json'), JSON.stringify(discovered, null, 2) + '\n');

  console.log(JSON.stringify(report.summary, null, 2));
  for (const r of report.companies) {
    console.log(`${r.status.padEnd(9)} ${r.company.padEnd(22)} ${r.ats ? `${r.ats}:${r.id}` : ''} ${r.total != null ? `${r.matches}/${r.total}` : r.error || (r.errors || []).join(' | ')}`);
  }
  for (const j of open.slice(0, 150)) console.log(`  [${j.level}] ${j.company} — ${j.title} — ${j.location} (${j.source})`);
  if (process.env.GITHUB_STEP_SUMMARY) await writeFile(process.env.GITHUB_STEP_SUMMARY, summaryMarkdown(report, open));
}

function summaryMarkdown(report, open) {
  const s = report.summary;
  const rows = open.slice(0, 150).map((j) => `| ${j.company} | [${j.title}](${j.url}) | ${j.level} | ${j.location} | ${(j.postedAt || j.firstSeen).slice(0, 10)} | ${j.source} |`);
  return [
    `## nextrole run — ${s.openJobs} open roles (${s.newToday} new)`,
    `Boards OK: ${s.boardsOk}/${s.companies}. Feeds: ${s.feeds.join('; ')}.`,
    `Not found: ${s.notFound.join(', ') || '—'}.`,
    s.errors.length ? `\nErrors:\n${s.errors.map((e) => `- ${e}`).join('\n')}` : '',
    '', '| Company | Role | Level | Location | Posted | Source |', '|---|---|---|---|---|---|', ...rows, '',
  ].join('\n');
}

main().catch((e) => { console.error(e); process.exit(1); });
