#!/usr/bin/env node
// Collects UX / product design openings in Israel from company job boards.
// Writes data/jobs.json (all tracked jobs, open and closed), data/boards.json (resolved
// boards per company) and data/report.json (what happened on this run).

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { adapters, NotFound, PROBE_ORDER } from './lib/ats.mjs';
import { isDesignRole, isInIsrael, guessLevel, minYears } from './lib/filters.mjs';

const ROOT = new URL('..', import.meta.url);
const path = (p) => new URL(p, ROOT);
const readJson = async (p, fallback) => {
  try { return JSON.parse(await readFile(path(p), 'utf8')); } catch { return fallback; }
};

const CONCURRENCY = 6;
const now = new Date().toISOString();

async function pool(items, worker) {
  const results = [];
  let i = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (i < items.length) { const idx = i++; results[idx] = await worker(items[idx]); }
  }));
  return results;
}

// Find which ATS hosts a company's board. Returns { ats, id, jobs } or null.
async function probe(company) {
  for (const id of company.candidates || []) {
    for (const ats of PROBE_ORDER) {
      try {
        const jobs = await adapters[ats](id);
        if (jobs.length > 0) return { ats, id, jobs };
      } catch (e) {
        if (!(e instanceof NotFound)) { /* network or format issue: try the next one */ }
      }
    }
  }
  return null;
}

async function main() {
  const { companies } = await readJson('companies.json', { companies: [] });
  const boards = await readJson('data/boards.json', {});
  const previous = await readJson('data/jobs.json', { jobs: [] });
  const byKey = new Map(previous.jobs.map((j) => [j.key, j]));

  const report = { runAt: now, companies: [] };

  const fetched = await pool(companies, async (c) => {
    const entry = { company: c.name };
    try {
      let ats = c.ats, id = c.id, jobs;
      if (!ats && boards[c.name]) ({ ats, id } = boards[c.name]);
      if (ats) {
        jobs = await adapters[ats](id);
      } else {
        const hit = await probe(c);
        if (!hit) { Object.assign(entry, { status: 'not_found', tried: c.candidates }); return { c, entry, jobs: null }; }
        ({ ats, id, jobs } = hit);
        boards[c.name] = { ats, id, detectedAt: now };
        entry.detected = true;
      }
      // Remote roles count only when the posting names Israel; "Remote - Portugal" does not.
      const matches = jobs.filter((j) => isDesignRole(j.title) && isInIsrael(j.location));
      Object.assign(entry, { status: 'ok', ats, id, total: jobs.length, matches: matches.length });
      return { c, entry, jobs: matches };
    } catch (e) {
      Object.assign(entry, { status: 'error', error: String(e.message || e) });
      return { c, entry, jobs: null };
    }
  });

  const seenNow = new Set();
  for (const { c, entry, jobs } of fetched) {
    report.companies.push(entry);
    if (!jobs) continue; // board failed this run: keep its jobs as they were
    for (const j of jobs) {
      seenNow.add(j.key);
      const prev = byKey.get(j.key);
      byKey.set(j.key, {
        ...j,
        company: c.name,
        level: guessLevel(j.title, j.description),
        minYears: minYears(j.description),
        firstSeen: prev?.firstSeen || now,
        lastSeen: now,
        status: 'open',
      });
    }
    // Jobs from this company that disappeared from its board are closed.
    for (const [key, j] of byKey) {
      if (j.company === c.name && j.status === 'open' && !seenNow.has(key)) {
        byKey.set(key, { ...j, status: 'closed', closedAt: now });
      }
    }
  }

  const jobs = [...byKey.values()].sort((a, b) =>
    (a.status === b.status ? 0 : a.status === 'open' ? -1 : 1) ||
    String(b.postedAt || b.firstSeen).localeCompare(String(a.postedAt || a.firstSeen)));

  const open = jobs.filter((j) => j.status === 'open');
  report.summary = {
    companies: companies.length,
    boardsOk: report.companies.filter((r) => r.status === 'ok').length,
    notFound: report.companies.filter((r) => r.status === 'not_found').map((r) => r.company),
    errors: report.companies.filter((r) => r.status === 'error').map((r) => `${r.company}: ${r.error}`),
    openJobs: open.length,
    newToday: open.filter((j) => j.firstSeen === now).length,
  };

  await mkdir(path('data/'), { recursive: true });
  await writeFile(path('data/jobs.json'), JSON.stringify({ updatedAt: now, jobs }, null, 2) + '\n');
  await writeFile(path('data/boards.json'), JSON.stringify(boards, null, 2) + '\n');
  await writeFile(path('data/report.json'), JSON.stringify(report, null, 2) + '\n');

  console.log(JSON.stringify(report.summary, null, 2));
  for (const r of report.companies) {
    console.log(`${r.status.padEnd(9)} ${r.company.padEnd(16)} ${r.ats ? `${r.ats}:${r.id}` : ''} ${r.total != null ? `${r.matches}/${r.total}` : r.error || ''}`);
  }
  for (const j of open.slice(0, 80)) console.log(`  [${j.level}] ${j.company} — ${j.title} — ${j.location}`);
  if (process.env.GITHUB_STEP_SUMMARY) await writeFile(process.env.GITHUB_STEP_SUMMARY, summaryMarkdown(report, open));
}

function summaryMarkdown(report, open) {
  const s = report.summary;
  const rows = open.slice(0, 100).map((j) => `| ${j.company} | [${j.title}](${j.url}) | ${j.level} | ${j.location} | ${(j.postedAt || j.firstSeen).slice(0, 10)} |`);
  return [
    `## nextrole run — ${s.openJobs} open roles (${s.newToday} new)`,
    `Boards OK: ${s.boardsOk}/${s.companies}. Not found: ${s.notFound.join(', ') || '—'}.`,
    s.errors.length ? `\nErrors:\n${s.errors.map((e) => `- ${e}`).join('\n')}` : '',
    '', '| Company | Role | Level | Location | Posted |', '|---|---|---|---|---|', ...rows, '',
  ].join('\n');
}

main().catch((e) => { console.error(e); process.exit(1); });
