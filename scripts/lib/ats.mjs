// Adapters for public job-board APIs. Each returns an array of normalized jobs,
// or throws NotFound when the board does not exist.

export class NotFound extends Error {}

const UA = 'nextrole-job-radar (+https://github.com/shanilei/nextrole)';

async function get(url, { as = 'json', timeoutMs = 20000 } = {}) {
  const res = await fetch(url, {
    headers: { 'user-agent': UA, accept: as === 'json' ? 'application/json' : 'text/html' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.status === 404 || res.status === 410) throw new NotFound(`${res.status} ${url}`);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return as === 'json' ? res.json() : res.text();
}

export function htmlToText(html = '') {
  return String(html)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/<\s*(br|\/p|\/li|\/h\d|\/div)\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

// "Posted 3 Days Ago", "Posted Today", "3 days ago", "Posted 30+ Days Ago" -> ISO date
export function postedOnToIso(text, now = Date.now()) {
  if (!text) return null;
  const t = String(text).toLowerCase();
  if (/today|just|hour|minute/.test(t)) return new Date(now).toISOString();
  if (/yesterday/.test(t)) return new Date(now - 864e5).toISOString();
  const m = t.match(/(\d+)\+?\s*(day|week|month)/);
  if (!m) return null;
  const days = Number(m[1]) * ({ day: 1, week: 7, month: 30 })[m[2]];
  return new Date(now - days * 864e5).toISOString();
}

const toIso = (v) => {
  if (v == null || v === '') return null;
  const d = typeof v === 'number' ? new Date(v) : new Date(String(v));
  return isNaN(d) ? null : d.toISOString();
};

function job({ ats, board, id, title, location, url, postedAt, description, remote = false }) {
  return {
    key: `${ats}:${board}:${id}`,
    title: (title || '').trim(),
    location: (location || '').trim(),
    url,
    postedAt: toIso(postedAt),
    remote: Boolean(remote),
    description: (description || '').slice(0, 6000),
  };
}

export const adapters = {
  async greenhouse(board) {
    const data = await get(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(board)}/jobs?content=true`);
    return (data.jobs || []).map((j) => job({
      ats: 'greenhouse', board, id: j.id, title: j.title,
      location: j.location?.name, url: j.absolute_url,
      postedAt: j.first_published || j.updated_at,
      description: htmlToText(j.content),
    }));
  },

  async lever(board, host = 'api.lever.co', ats = 'lever') {
    const data = await get(`https://${host}/v0/postings/${encodeURIComponent(board)}?mode=json`);
    if (!Array.isArray(data)) throw new NotFound(`lever ${board}`);
    return data.map((j) => job({
      ats, board, id: j.id, title: j.text,
      location: [j.categories?.location, ...(j.categories?.allLocations || [])].filter(Boolean).join(' / '),
      url: j.hostedUrl, postedAt: j.createdAt,
      remote: j.workplaceType === 'remote',
      description: [j.descriptionPlain, ...(j.lists || []).map((l) => `${l.text}\n${htmlToText(l.content)}`)].filter(Boolean).join('\n'),
    }));
  },

  async lever_eu(board) {
    return adapters.lever(board, 'api.eu.lever.co', 'lever_eu');
  },

  // Workday career sites. board = "<tenant>/<wd-host>/<site>", e.g. "nvidia/wd5/NVIDIAExternalCareerSite".
  // Big tenants list thousands of jobs, so search for design titles only and read the
  // location of each hit from its detail page when the list shows "N Locations".
  async workday(board) {
    const [tenant, host, site] = board.split('/');
    const base = `https://${tenant}.${host}.myworkdayjobs.com`;
    const api = `${base}/wday/cxs/${tenant}/${site}`;
    const seen = new Map();
    for (const searchText of ['designer', 'UX']) {
      for (let offset = 0; offset < 200; offset += 20) {
        const res = await fetch(`${api}/jobs`, {
          method: 'POST',
          headers: { 'user-agent': UA, 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ appliedFacets: {}, limit: 20, offset, searchText }),
          signal: AbortSignal.timeout(20000),
        });
        if (res.status === 404) throw new NotFound(`workday ${board}`);
        if (!res.ok) throw new Error(`HTTP ${res.status} for workday ${board}`);
        const data = await res.json();
        for (const p of data.jobPostings || []) if (p.externalPath) seen.set(p.externalPath, p);
        if (!data.jobPostings || data.jobPostings.length < 20) break;
      }
    }
    const out = [];
    for (const [path, p] of seen) {
      let location = p.locationsText || '';
      let description = '';
      if (/^\d+ locations?$/i.test(location) || !location) {
        try {
          const det = await get(`${api}${path}`);
          const info = det.jobPostingInfo || {};
          location = [info.location, ...(info.additionalLocations || [])].filter(Boolean).join(' / ');
          description = htmlToText(info.jobDescription);
        } catch { /* keep the summary location */ }
      }
      out.push(job({
        ats: 'workday', board, id: p.bulletFields?.[0] || path, title: p.title,
        location, url: `${base}/${site}${path}`, postedAt: postedOnToIso(p.postedOn), description,
      }));
    }
    return out;
  },

  async ashby(board) {
    const data = await get(`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(board)}`);
    return (data.jobs || []).filter((j) => j.isListed !== false).map((j) => job({
      ats: 'ashby', board, id: j.id, title: j.title,
      location: [j.location, ...(j.secondaryLocations || []).map((s) => s.location), j.address?.postalAddress?.addressCountry].filter(Boolean).join(' / '),
      url: j.jobUrl, postedAt: j.publishedAt, remote: j.isRemote,
      description: j.descriptionPlain || htmlToText(j.descriptionHtml),
    }));
  },

  async workable(board) {
    const data = await get(`https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(board)}?details=true`);
    return (data.jobs || []).map((j) => job({
      ats: 'workable', board, id: j.shortcode, title: j.title,
      location: [j.city, j.state, j.country].filter(Boolean).join(', '),
      url: j.url || j.application_url, postedAt: j.published_on || j.created_at,
      remote: j.telecommuting,
      description: htmlToText(j.description),
    }));
  },

  async smartrecruiters(board) {
    const out = [];
    for (let offset = 0; offset < 1000; offset += 100) {
      const data = await get(`https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(board)}/postings?limit=100&offset=${offset}`);
      const page = data.content || [];
      out.push(...page.map((j) => job({
        ats: 'smartrecruiters', board, id: j.id, title: j.name,
        location: [j.location?.city, j.location?.country?.toUpperCase?.()].filter(Boolean).join(', '),
        url: `https://jobs.smartrecruiters.com/${board}/${j.id}`,
        postedAt: j.releasedDate, remote: j.location?.remote,
        description: '',
      })));
      if (page.length < 100) break;
    }
    return out;
  },

  // Comeet has no keyless API; its hosted careers page embeds the positions as JSON.
  // board = "<company-slug>/<company-uid>", e.g. "vastdata/43.001"
  async comeet(board) {
    const html = await get(`https://www.comeet.com/jobs/${board}`, { as: 'html' });
    const m = html.match(/COMPANY_POSITIONS_DATA\s*=\s*(\[[\s\S]*?\]);\s*\n/);
    if (!m) throw new Error(`comeet ${board}: positions data not found on page`);
    const list = JSON.parse(m[1]);
    return list.map((j) => job({
      ats: 'comeet', board, id: j.uid, title: j.name,
      location: [j.location?.name, j.location?.city, j.location?.country].filter(Boolean).join(', '),
      url: j.url_comeet_hosted_page || j.url_active_page || `https://www.comeet.com/jobs/${board}`,
      postedAt: j.time_updated, remote: j.location?.is_remote,
      description: (j.custom_fields?.details || []).map((d) => `${d.name}\n${htmlToText(d.value)}`).join('\n'),
    }));
  },
};

// Order matters: the first ATS that answers with at least one job wins.
export const PROBE_ORDER = ['greenhouse', 'lever', 'ashby', 'workable', 'smartrecruiters'];
