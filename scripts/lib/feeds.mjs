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
import { boardFromUrl, parseLinkedInTitle, companyFromLinkedInUrl } from './discover.mjs';

// LinkedIn job pages and hiring posts indexed by Google, past week. Six searches a day
// fits the free plan's 250 a month; the order means a smaller budget still covers both.
// (site: filters on Comeet / Greenhouse were ignored by Google in testing.)
export const GOOGLE_QUERIES = [
  { kind: 'linkedin', q: 'site:linkedin.com/jobs "product designer" Israel', tbs: 'qdr:w' },
  { kind: 'post', q: 'site:linkedin.com/posts hiring "product designer" Israel', tbs: 'qdr:w' },
  { kind: 'linkedin', q: 'site:linkedin.com/jobs "UX designer" Israel', tbs: 'qdr:w' },
  { kind: 'post', q: 'site:linkedin.com/posts (מגייסים OR מחפשים OR דרוש OR דרושה) (UX OR "מעצב מוצר" OR "מעצבת מוצר" OR "product designer")', tbs: 'qdr:w' },
  { kind: 'linkedin', q: 'site:linkedin.com/jobs "UI/UX designer" OR "UX/UI designer" Israel', tbs: 'qdr:w' },
  { kind: 'linkedin', q: 'site:linkedin.com/jobs "product designer" "Tel Aviv"', tbs: 'qdr:w' },
  { kind: 'post', q: 'site:linkedin.com/posts hiring "UX designer" OR "UI/UX designer" Israel', tbs: 'qdr:w' },
  { kind: 'linkedin', q: 'site:linkedin.com/jobs "junior" designer UX Israel', tbs: 'qdr:w' },
];

const HIRING = /hiring|we.re looking|looking for (a|an)|join (our|us)|open (role|position)|מגייס|מחפשים|מחפשת|דרוש|דרושה|מצטרף|מצטרפת/i;
const ROLE_IN_TEXT = /(junior |senior |lead )?(product designer|ux\/ui designer|ui\/ux designer|ux designer|ui designer|ux ui designer|ui ux designer|מעצב(?:\/ת|ת)? מוצר|מעצב(?:\/ת|ת)? ux(?:\/ui)?)/i;

// "Dana Cohen on LinkedIn: We're hiring a Product Designer…" / "#hiring … | Dana Cohen"
export function parseLinkedInPost(title = '', snippet = '', url = '') {
  const text = `${title} ${snippet}`;
  if (!HIRING.test(text)) return null;
  const role = text.match(ROLE_IN_TEXT);
  if (!role) return null;
  let author = (title.match(/^(.+?) on LinkedIn:/i) || title.match(/\|\s*([^|]+?)\s*$/) || [])[1] || '';
  if (!author) {
    const m = String(url).match(/linkedin\.com\/posts\/([^_/?#]+)/i);
    if (m) author = m[1].replace(/-[0-9a-f]{6,}$/i, '').replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }
  const at = text.match(/(?:\bat|@)\s+([A-Z][\w.&-]*(?:\s+[A-Z][\w.&-]*){0,2})/);
  // Hebrew role names become their English equivalents so filters and levels work.
  const raw = role[0];
  const title0 = /[א-ת]/.test(raw)
    ? (/ux/i.test(raw) ? 'UX Designer' : 'Product Designer')
    : raw.replace(/\b\w/g, (c) => c.toUpperCase()).replace(/\bUx\b/g, 'UX').replace(/\bUi\b/g, 'UI');
  return { title: title0, company: at ? at[1] : '', author: author.trim() };
}

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
        const url = r.link.split('?')[0];
        const p = parseLinkedInTitle(r.title);
        if (!p.company) p.company = companyFromLinkedInUrl(url);
        // Skip reposts by aggregators that list other companies' jobs as their own.
        if (/jobgether|jobs via|recruit(ment|ing) agency/i.test(`${p.company} ${r.title}`)) continue;
        jobs.push({
          key: `linkedin:${url}`,
          title: p.title, company: p.company, location: p.location || 'Israel',
          url, postedAt: null, description: r.snippet || '', via: 'LinkedIn',
        });
      }
      if (kind === 'post' && /linkedin\.com\/(posts|feed\/update)/.test(r.link || '')) {
        const url = r.link.split('?')[0];
        const p = parseLinkedInPost(r.title, r.snippet, url);
        if (!p) continue;
        jobs.push({
          key: `post:${url}`, kind: 'post',
          title: p.title, company: p.company, author: p.author, location: 'Israel',
          url, postedAt: r.date ? new Date(r.date).toISOString() : null,
          description: r.snippet || '', via: 'פוסט ב-LinkedIn',
        });
      }
    }
  }
  return { jobs, boards: [...boards.values()], searches: used, perQuery };
}
