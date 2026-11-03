// Turn a job-board URL into the board it belongs to, so companies found through
// search can be added to the daily board check automatically.

const PATTERNS = [
  ['comeet', /comeet\.com\/jobs\/([^/?#]+)\/([0-9A-F]{2}\.[0-9A-F]{3})/i, (m) => `${m[1]}/${m[2]}`],
  ['greenhouse', /(?:job-boards|boards)(?:\.eu)?\.greenhouse\.io\/(?:embed\/job_board\?for=)?([a-z0-9_-]+)/i, (m) => m[1]],
  ['lever', /jobs\.lever\.co\/([a-z0-9_.-]+)/i, (m) => m[1]],
  ['lever_eu', /jobs\.eu\.lever\.co\/([a-z0-9_.-]+)/i, (m) => m[1]],
  ['ashby', /jobs\.ashbyhq\.com\/([^/?#]+)/i, (m) => decodeURIComponent(m[1])],
  ['workable', /apply\.workable\.com\/([a-z0-9_-]+)/i, (m) => m[1]],
  ['smartrecruiters', /jobs\.smartrecruiters\.com\/([A-Za-z0-9_-]+)/i, (m) => m[1]],
];

const IGNORE = new Set(['embed', 'api', 'v1', 'jobs', 'search', 'oneclick-ui']);

export function boardFromUrl(url = '') {
  for (const [ats, re, id] of PATTERNS) {
    const m = String(url).match(re);
    if (m && !IGNORE.has(m[1].toLowerCase())) return { ats, id: id(m) };
  }
  return null;
}

export function nameFromBoard({ ats, id }) {
  const slug = ats === 'comeet' ? id.split('/')[0] : id;
  return slug.replace(/[-_]+/g, ' ').replace(/\d+$/, '').trim().replace(/\b\w/g, (c) => c.toUpperCase());
}

// "Wix hiring Product Designer in Tel Aviv-Yafo, Israel | LinkedIn"
// "Product Designer - Wix - LinkedIn"
export function parseLinkedInTitle(title = '') {
  const t = title.replace(/\s*[|\-–]\s*LinkedIn\s*$/i, '').trim();
  let m = t.match(/^(.+?) hiring (.+?)(?: in (.+))?$/i);
  if (m) return { company: m[1].trim(), title: m[2].trim(), location: (m[3] || '').trim() };
  m = t.match(/^(.+?)\s+[-–]\s+(.+?)(?:\s+[-–]\s+(.+))?$/);
  if (m) return { title: m[1].trim(), company: m[2].trim(), location: (m[3] || '').trim() };
  return { title: t, company: '', location: '' };
}
