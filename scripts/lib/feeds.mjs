// Sources that are not one company's board: they list many companies' jobs.
// Their results are partial on any given day, so a missing job is not proof it closed;
// the collector closes feed jobs only after they go unseen for a while.

import { htmlToText, postedOnToIso } from './ats.mjs';

const UA = 'nextrole-job-radar (+https://github.com/shanilei/nextrole)';

const tag = (xml, name) => {
  const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? m[1].replace(/^<!\[CDATA\[|\]\]>$/g, '').trim() : '';
};

// Secret Tel Aviv Jobs, UX/UI category RSS.
export async function secretTelAviv() {
  const url = 'https://jobs.secrettelaviv.com/wpjobboard/xml/rss/?filter=active&category=50';
  const res = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for Secret Tel Aviv RSS`);
  const xml = await res.text();
  const items = xml.split(/<item[\s>]/i).slice(1);
  return items.map((it) => {
    const title = htmlToText(tag(it, 'title'));
    const link = tag(it, 'link') || tag(it, 'guid');
    const desc = htmlToText(tag(it, 'description') || tag(it, 'content:encoded'));
    const company = htmlToText(tag(it, 'wpjb:company_name') || tag(it, 'job_listing:company') || tag(it, 'dc:creator'));
    const location = htmlToText(tag(it, 'wpjb:job_city') || tag(it, 'wpjb:location')) || 'Tel Aviv, Israel';
    return {
      key: `secrettlv:${link}`,
      title, company, location, url: link,
      postedAt: tag(it, 'pubDate') ? new Date(tag(it, 'pubDate')).toISOString() : null,
      description: desc.slice(0, 6000),
      via: 'Secret Tel Aviv',
    };
  }).filter((j) => j.title && j.url);
}

// Google search through SerpApi (free plan: 250 searches a month). Google Jobs itself does
// not cover Israel, so this uses regular search for two things:
//  1. LinkedIn job pages that Google has indexed (title, company, location, snippet);
//  2. design roles on Comeet / Greenhouse / Lever / Ashby boards, whose board IDs are
//     returned so the collector can start checking those companies every day.
import { boardFromUrl, parseLinkedInTitle } from './discover.mjs';

// Simple queries: Google handles one site: filter and a quoted phrase far better than
// long OR chains. Ordered so a small budget still covers LinkedIn and board discovery.
export const GOOGLE_QUERIES = [
  { kind: 'linkedin', q: 'site:linkedin.com/jobs "product designer" Israel', tbs: 'qdr:w' },
  { kind: 'boards', q: 'site:comeet.com/jobs "product designer"', tbs: 'qdr:m' },
  { kind: 'boards', q: 'site:job-boards.greenhouse.io "product designer" Tel Aviv', tbs: 'qdr:m' },
  { kind: 'linkedin', q: 'site:linkedin.com/jobs "UX designer" Israel', tbs: 'qdr:w' },
  { kind: 'boards', q: 'site:comeet.com/jobs "UX/UI designer"', tbs: 'qdr:m' },
  { kind: 'boards', q: 'site:jobs.ashbyhq.com OR site:jobs.lever.co "product designer" Tel Aviv', tbs: 'qdr:m' },
];

export async function googleSearch(apiKey, maxSearches = Number(process.env.SERPAPI_MAX_SEARCHES || 6)) {
  const jobs = [];
  const boards = new Map();
  const perQuery = [];
  let used = 0;
  for (const { kind, q, tbs } of GOOGLE_QUERIES) {
    if (used >= maxSearches) break;
    const params = new URLSearchParams({ engine: 'google', q, tbs, hl: 'en', gl: 'il', api_key: String(apiKey).trim() });
    const res = await fetch(`https://serpapi.com/search.json?${params}`, { signal: AbortSignal.timeout(30000) });
    used++;
    const data = await res.json().catch(() => ({}));
    if (data.error) { if (/hasn't returned any results/i.test(data.error)) continue; throw new Error(`SerpApi: ${data.error}`); }
    if (!res.ok) throw new Error(`SerpApi HTTP ${res.status}`);
    perQuery.push({ q, results: (data.organic_results || []).length, links: (data.organic_results || []).slice(0, 3).map((r) => r.link) });
    for (const r of data.organic_results || []) {
      const b = boardFromUrl(r.link);
      if (b) boards.set(`${b.ats}:${b.id}`, { ...b, url: r.link, title: r.title });
      if (kind === 'linkedin' && /linkedin\.com\/jobs\/view/.test(r.link || '')) {
        const p = parseLinkedInTitle(r.title);
        const url = r.link.split('?')[0];
        jobs.push({
          key: `linkedin:${url}`,
          title: p.title, company: p.company, location: p.location || 'Israel',
          url, postedAt: null, description: r.snippet || '', via: 'LinkedIn',
        });
      }
    }
  }
  return { jobs, boards: [...boards.values()], searches: used, perQuery };
}
