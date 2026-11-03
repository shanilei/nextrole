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
const FEED_STALE_DAYS = 10; // a feed job unseen this long is treated as closed
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
  for (const { c, entry, jobs, source } of fetched) {
    report.companies.push(entry);
    if (!jobs) continue; // board failed this run: keep its jobs as they were
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
      let added = 0, dup = 0;
      const seenDup = new Set();
      for (const j of matches) {
        if (!j.company) j.company = inferCompany(j, boardByTitle, companies) || '';
        const dk = dupKey(j);
        if (boardKeys.has(dk) || seenDup.has(dk)) { dup++; continue; }
        seenDup.add(dk);
        upsert(byKey, j, { source: `feed:${name}` });
        added++;
      }
      report.feeds.push({ feed: name, status: 'ok', total: all.length, matches: matches.length, added, duplicates: dup });
    } catch (e) {
      report.feeds.push({ feed: name, status: 'error', error: String(e.message || e) });
    }
  }
  // Feed jobs unseen for a while are closed.
  const stale = Date.now() - FEED_STALE_DAYS * 864e5;
  for (const [key, j] of byKey) {
    if (j.source?.startsWith('feed:') && j.status === 'open' && new Date(j.lastSeen).getTime() < stale) byKey.set(key, { ...j, status: 'closed', closedAt: now });
  }

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
