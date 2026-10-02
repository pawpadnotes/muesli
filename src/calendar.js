// Reads a calendar's private ICS link (Google, Outlook and iCloud all offer one) and lists what is coming up.
// Nothing is sent: the calendar is only downloaded.

const unescape = (t) => t.replace(/\\n/gi, ' ').replace(/\\([,;\\])/g, '$1').trim();

// Wall-clock time in a named zone -> Date. Zones the runtime does not know (Outlook's own names) are read as local time.
function zoned(y, mo, d, h, mi, tz) {
  if (!tz) return new Date(y, mo - 1, d, h, mi);
  try {
    const utc = Date.UTC(y, mo - 1, d, h, mi);
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' })
      .formatToParts(new Date(utc)).map((p) => [p.type, Number(p.value)]));
    return new Date(utc - (Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute) - utc));
  } catch {
    return new Date(y, mo - 1, d, h, mi);
  }
}

// "20261002T140000Z" or "20261002T100000" (+ zone) -> { wall-clock fields, at(y, mo, d) }
function stamp(value, tz) {
  const m = /^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)/.exec(value);
  if (!m) return null; // all-day entries are not meetings
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  const utc = value.endsWith('Z');
  const at = (yy, mm, dd) => (utc ? new Date(Date.UTC(yy, mm - 1, dd, h, mi)) : zoned(yy, mm, dd, h, mi, tz));
  return { y, mo, d, at, date: at(y, mo, d) };
}

const DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const DAY = 864e5;

// Every start of one event between from and to. Daily, weekly, monthly-by-date and yearly repeats are followed.
function starts(ev, from, to) {
  if (!ev.rule) return ev.start.date >= from && ev.start.date <= to ? [ev.start.date] : [];
  const rule = Object.fromEntries(ev.rule.split(';').map((p) => p.split('=')));
  const every = Number(rule.INTERVAL || 1);
  const until = rule.UNTIL ? (stamp(rule.UNTIL, ev.tz)?.date || new Date(`${rule.UNTIL.slice(0, 4)}-${rule.UNTIL.slice(4, 6)}-${rule.UNTIL.slice(6, 8)}T23:59:59`)) : null;
  const first = Date.UTC(ev.start.y, ev.start.mo - 1, ev.start.d);
  const byDay = rule.BYDAY ? rule.BYDAY.split(',') : null;
  if (byDay?.some((d) => /\d/.test(d))) return []; // "second Tuesday" style rules are not followed
  const out = [];
  for (let day = Math.max(first, Date.UTC(from.getFullYear(), from.getMonth(), from.getDate()) - DAY); day <= to.getTime() + DAY; day += DAY) {
    const d = new Date(day);
    const n = Math.round((day - first) / DAY);
    let hit = false;
    if (rule.FREQ === 'DAILY') hit = n % every === 0 && (!byDay || byDay.includes(DAYS[d.getUTCDay()]));
    else if (rule.FREQ === 'WEEKLY') {
      const week = Math.floor((n + new Date(first).getUTCDay()) / 7);
      hit = week % every === 0 && (byDay ? byDay.includes(DAYS[d.getUTCDay()]) : n % 7 === 0);
    } else if (rule.FREQ === 'MONTHLY') hit = d.getUTCDate() === ev.start.d && !byDay;
    else if (rule.FREQ === 'YEARLY') hit = d.getUTCDate() === ev.start.d && d.getUTCMonth() === ev.start.mo - 1;
    if (!hit) continue;
    const at = ev.start.at(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
    if (at < from || at > to || (until && at > until) || ev.skip.includes(at.getTime())) continue;
    // COUNT is only enforced for the simple daily and weekly-on-one-day cases.
    if (rule.COUNT && !byDay && Math.floor(n / (rule.FREQ === 'WEEKLY' ? 7 * every : every)) >= Number(rule.COUNT)) continue;
    out.push(at);
  }
  return out;
}

function parse(text, from, to) {
  const lines = text.replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
  const events = [];
  const moved = new Set(); // single occurrences of a repeat that were rescheduled or cancelled
  let ev = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') ev = { people: [], skip: [], title: '' };
    else if (line === 'END:VEVENT') {
      if (ev?.start && !ev.cancelled) events.push(ev);
      if (ev?.recurrenceId) moved.add(`${ev.uid} ${ev.recurrenceId}`);
      ev = null;
    } else if (ev) {
      const colon = line.indexOf(':');
      const [name, ...params] = line.slice(0, colon).split(';');
      const value = line.slice(colon + 1);
      const tz = params.find((p) => p.startsWith('TZID='))?.slice(5).replace(/"/g, '');
      if (name === 'DTSTART') { ev.start = stamp(value, tz); ev.tz = tz; }
      else if (name === 'DTEND') ev.end = stamp(value, tz)?.date;
      else if (name === 'SUMMARY') ev.title = unescape(value);
      else if (name === 'UID') ev.uid = value;
      else if (name === 'RRULE') ev.rule = value;
      else if (name === 'STATUS' && value === 'CANCELLED') ev.cancelled = true;
      else if (name === 'EXDATE') ev.skip.push(...value.split(',').map((v) => stamp(v, tz)?.date.getTime()).filter(Boolean));
      else if (name === 'RECURRENCE-ID') ev.recurrenceId = stamp(value, tz)?.date.getTime();
      else if (name === 'ATTENDEE') {
        const cn = params.find((p) => p.startsWith('CN='))?.slice(3).replace(/"/g, '');
        if (cn && !cn.includes('@')) ev.people.push(cn);
      }
    }
  }
  const out = [];
  for (const e of events) {
    const length = e.end ? e.end - e.start.date : 30 * 60000;
    for (const at of starts(e, new Date(from.getTime() - length), to)) {
      if (e.rule && moved.has(`${e.uid} ${at.getTime()}`)) continue;
      out.push({ title: e.title || 'Meeting', start: at.toISOString(), end: new Date(at.getTime() + length).toISOString(), people: e.people.slice(0, 12).join(', ') });
    }
  }
  return out.filter((e) => new Date(e.end) >= from).sort((a, b) => a.start.localeCompare(b.start));
}

let cache = { url: '', at: 0, text: '' };
async function upcoming(url, days = 7) {
  if (!url) return [];
  url = url.trim().replace(/^webcal:/i, 'https:');
  if (cache.url !== url || Date.now() - cache.at > 5 * 60000) {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`The calendar answered ${res.status}`);
    const text = await res.text();
    if (!text.includes('BEGIN:VCALENDAR')) throw new Error('That link is not a calendar (ICS) link');
    cache = { url, at: Date.now(), text };
  }
  const now = new Date();
  return parse(cache.text, now, new Date(now.getTime() + days * DAY));
}

module.exports = { parse, upcoming };
