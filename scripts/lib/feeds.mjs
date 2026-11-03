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

// Google Jobs through SerpApi. Free plan: 250 searches a month, so keep the
// daily budget small (SERPAPI_MAX_SEARCHES, default 6).
export const GOOGLE_QUERIES = ['product designer', 'UX designer', 'UI UX designer', 'מעצב UX UI'];

export async function googleJobs(apiKey, maxSearches = Number(process.env.SERPAPI_MAX_SEARCHES || 6)) {
  const out = [];
  let used = 0;
  for (const q of GOOGLE_QUERIES) {
    let token = null;
    for (let page = 0; page < 3 && used < maxSearches; page++) {
      // No `location` param: SerpApi wants its own canonical location names there, so the
      // country goes in the query and gl=il.
      const params = new URLSearchParams({ engine: 'google_jobs', q: `${q} Israel`, gl: 'il', hl: 'en', api_key: String(apiKey).trim() });
      if (token) params.set('next_page_token', token);
      const res = await fetch(`https://serpapi.com/search.json?${params}`, { signal: AbortSignal.timeout(30000) });
      used++;
      const data = await res.json().catch(() => ({}));
      if (!res.ok && !data.error) throw new Error(`SerpApi HTTP ${res.status}`);
      if (data.error) { if (/hasn't returned any results/i.test(data.error)) break; throw new Error(`SerpApi: ${data.error}`); }
      for (const j of data.jobs_results || []) {
        const apply = (j.apply_options || [])[0];
        out.push({
          key: `google:${(j.company_name || '').toLowerCase()}:${(j.title || '').toLowerCase()}`,
          title: j.title, company: j.company_name, location: j.location || '',
          url: apply?.link || j.share_link,
          postedAt: postedOnToIso(j.detected_extensions?.posted_at),
          description: [j.description, ...(j.job_highlights || []).flatMap((h) => [h.title, ...(h.items || [])])].filter(Boolean).join('\n').slice(0, 6000),
          via: apply?.title ? `Google Jobs · ${apply.title}` : (j.via || 'Google Jobs'),
        });
      }
      token = data.serpapi_pagination?.next_page_token;
      if (!token) break;
    }
    if (used >= maxSearches) break;
  }
  return { jobs: out, searches: used };
}
