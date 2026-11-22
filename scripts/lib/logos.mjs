// Company logos, read from each company's own public careers page (the board the
// collector already checks). Results are cached in data/logos.json and refreshed
// once a month, so this costs a handful of requests a day.

const UA = 'Mozilla/5.0 (nextrole job radar; +https://github.com/shanilei/nextrole)';

const PAGE = {
  greenhouse: (id) => `https://job-boards.greenhouse.io/${id}`,
  lever: (id) => `https://jobs.lever.co/${id}`,
  ashby: (id) => `https://jobs.ashbyhq.com/${id}`,
  workable: (id) => `https://apply.workable.com/${id}/`,
  smartrecruiters: (id) => `https://careers.smartrecruiters.com/${id}`,
  comeet: (id) => `https://www.comeet.com/jobs/${id}`,
};

// The ATS's own branding is not the company's logo.
const ATS_ASSET = /(greenhouse|lever|ashby|workable|smartrecruiters|comeet)[-_ ]?(logo|brand)|powered[-_]?by|favicon|placeholder|default[-_]?(logo|company)|\/(assets|static)\/(images\/)?(logo|brand)/i;
const ATS_SITE = /(^|\.)(greenhouse\.io|lever\.co|ashbyhq\.com|workable\.com|smartrecruiters\.com|comeet\.com|comeet\.co|linkedin\.com|facebook\.com|twitter\.com|x\.com|instagram\.com|glassdoor\.com|google\.com|apple\.com|youtube\.com)$/i;

const unescape = (s) => s.replace(/\\u002F/gi, '/').replace(/\\\//g, '/').replace(/&amp;/g, '&');
const absolute = (u, base) => { try { return new URL(unescape(u), base).href; } catch { return null; } };

export function extractLogo(html, pageUrl) {
  const candidates = [];
  const push = (u, why) => { const a = u && absolute(u, pageUrl); if (a && /^https:/.test(a) && !ATS_ASSET.test(a)) candidates.push({ url: a, why }); };
  // 1. Logo fields in embedded JSON (Comeet, Ashby, SmartRecruiters, Workable).
  for (const m of html.matchAll(/"(?:logo_url|logoUrl|logo_image_url|logoImageUrl|companyLogo|company_logo|logo)"\s*:\s*"(https?:[^"]+)"/gi)) push(m[1], 'json');
  // 2. <img> whose class, id, alt or src says logo (Greenhouse, Lever).
  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
    const tag = m[0];
    if (!/logo/i.test(tag)) continue;
    const src = tag.match(/\bsrc=["']([^"']+)["']/i)?.[1];
    if (src && !src.startsWith('data:')) push(src, 'img');
  }
  // 3. Open Graph image, often the logo on hosted boards.
  const og = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)?.[1]
    || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i)?.[1];
  push(og, 'og');

  // The company's own website, for a favicon when no logo is found.
  let site = null;
  const siteField = html.match(/"(?:website|website_url|websiteUrl|company_website|companyWebsite|url_website)"\s*:\s*"(https?:[^"]+)"/i)?.[1];
  const logoLink = html.match(/<a\b[^>]*(?:class|id)=["'][^"']*logo[^"']*["'][^>]*href=["'](https?:[^"']+)["']/i)?.[1]
    || html.match(/<a\b[^>]*href=["'](https?:[^"']+)["'][^>]*(?:class|id)=["'][^"']*logo[^"']*["']/i)?.[1];
  for (const u of [siteField, logoLink]) {
    const a = u && absolute(u, pageUrl);
    if (a && !ATS_SITE.test(new URL(a).hostname)) { site = new URL(a).origin; break; }
  }
  return { logo: candidates[0]?.url || null, via: candidates[0]?.why || null, site };
}

export async function findLogo(ats, id) {
  const page = PAGE[ats]?.(id);
  if (!page) return { logo: null, site: null };
  const res = await fetch(page, { headers: { 'user-agent': UA, accept: 'text/html' }, redirect: 'follow', signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return extractLogo(await res.text(), res.url || page);
}
