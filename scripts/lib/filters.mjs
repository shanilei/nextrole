// Which jobs count as UX / product design roles in Israel, and how senior they are.

const ROLE = /\b(ux|ui|ux\/ui|ui\/ux|user experience|product design(?:er)?|interaction design(?:er)?|experience design(?:er)?|design system|visual designer|web designer|digital designer)\b/i;
const NOT_ROLE = /\b(graphic|industrial|mechanical|hardware|electrical|electronic|chip|asic|fpga|physical design|layout|pcb|rf |analog|circuit|game designer|level designer|interior|fashion|motion|3d|video|engineer|developer|researcher only|copywriter|content designer)\b/i;

const ISRAEL = /\b(israel|tel[ -]?aviv|tlv|yafo|jaffa|herzliya|herzliyya|ramat[ -]?gan|petah[ -]?tikva|petach[ -]?tikva|haifa|jerusalem|ra'?anana|netanya|yokneam|be'?er[ -]?sheva|beersheba|rehovot|hod[ -]?hasharon|kfar[ -]?saba|bnei[ -]?brak|givatayim|holon|caesarea|modi'?in|or[ -]?yehuda|rosh[ -]?ha'?ayin|airport city)\b|\bIL\b|\bISR\b/i;

export function isDesignRole(title = '') {
  return ROLE.test(title) && !NOT_ROLE.test(title);
}

export function isInIsrael(location = '') {
  return ISRAEL.test(location);
}

// Junior | Mid | Senior+ from the title, refined by "N+ years" in the description.
export function guessLevel(title = '', description = '') {
  const t = title.toLowerCase();
  if (/\b(intern|internship|student|junior|jr\.?|associate|entry|graduate)\b/.test(t)) return 'Junior';
  if (/\b(senior|sr\.?|staff|principal|lead|head|director|manager|vp)\b/.test(t)) return 'Senior+';
  const years = minYears(description);
  if (years != null) {
    if (years <= 2) return 'Junior';
    if (years >= 5) return 'Senior+';
  }
  return 'Mid';
}

export function minYears(text = '') {
  const found = [...String(text).matchAll(/(\d{1,2})\s*(?:\+|-\s*\d{1,2}|–\s*\d{1,2})?\s*(?:\+\s*)?years?/gi)]
    .map((m) => Number(m[1]))
    .filter((n) => n > 0 && n <= 15);
  return found.length ? Math.min(...found) : null;
}
