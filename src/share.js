// A meeting as one web page: notes, action items and the full transcript. The draft follow-up email stays
// in the app: the people reading this page are the people it is written to.
// The file needs nothing else (no scripts, no fonts, no network), so it can be emailed, dropped in a shared
// folder or opened on a phone. It is the local answer to a hosted share link.

const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// Whoever opens this page is not "Me": the person who took the notes is named by what they did.
const AUTHOR = 'Note-taker';
const mmss = (ms) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;

const STYLE = `
:root{--bg:#f1efe6;--card:#faf9f3;--line:#ddddd0;--text:#2c3a2e;--strong:#182019;--muted:#5d6a5e;--accent:#1e4d2b;--weak:#e4eee5}
@media (prefers-color-scheme:dark){:root{--bg:#141412;--card:#1c1c19;--line:#32322d;--text:#e6e5df;--strong:#f7f6f1;--muted:#a9a89f;--accent:#8fd6a1;--weak:#22302a}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.6 system-ui,'Segoe UI',Helvetica,Arial,sans-serif;-webkit-text-size-adjust:100%}
main{max-width:720px;margin:0 auto;padding:clamp(24px,6vw,64px) 16px 48px}
h1{font:500 clamp(28px,5vw,40px)/1.15 Georgia,'Times New Roman',serif;color:var(--strong);margin:0 0 8px;text-wrap:balance}
.meta{color:var(--muted);font-size:14px;margin:0 0 32px}
section{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:24px;margin:0 0 16px}
h2{font-size:13px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--accent);margin:0 0 12px}
h2:not(:first-child){margin-top:24px}
ul{margin:0;padding-left:20px}li{margin:8px 0}
ul.todo{list-style:none;padding:0}ul.todo li{display:flex;gap:8px;align-items:baseline}
.who{font-size:13px;color:var(--muted);white-space:nowrap}
.box{flex:none;width:14px;height:14px;border:1.5px solid var(--muted);border-radius:4px;transform:translateY(2px)}
.box.done{background:var(--accent);border-color:var(--accent)}
pre{font:inherit;white-space:pre-wrap;margin:0}
details summary{cursor:pointer;color:var(--accent);min-height:24px}
summary h2{display:inline;margin:0}
details[open] summary{margin-bottom:16px}
summary:focus-visible{outline:2px solid var(--accent);outline-offset:4px;border-radius:4px}
.line{display:grid;grid-template-columns:48px 1fr;gap:8px;margin:0 0 12px}
.time{color:var(--muted);font:13px/1.9 ui-monospace,Consolas,monospace}
.name{font-weight:600;color:var(--strong)}.name.me{color:var(--accent)}
footer{color:var(--muted);font-size:13px;text-align:center;margin-top:32px}
@media print{body{background:#fff}section{border:0;padding:0;margin-bottom:24px}details summary{list-style:none}}
`;

// meeting: what meetings.get returns; segments: the transcript with named voices already applied
function page(meeting, segments, lang = 'en') {
  const r = meeting.result;
  const title = meeting.title || r?.notes.title || 'Meeting';
  const when = new Date(meeting.createdAt).toLocaleString([], { dateStyle: 'long', timeStyle: 'short' });
  const length = meeting.durationSec ? `${Math.max(1, Math.round(meeting.durationSec / 60))} min` : '';
  const meta = [when, length, meeting.people].filter(Boolean).map(esc).join(' &middot; ');

  const notes = r ? r.notes.sections.filter((s) => s.bullets.length).map((s) => `<h2>${esc(s.heading)}</h2><ul>${s.bullets.map((b) => `<li>${esc(b.text)}</li>`).join('')}</ul>`).join('') : '';
  const actions = r?.actions.length
    ? `<section><h2>Action items</h2><ul class="todo">${r.actions.map((a) => `<li><span class="box${a.done ? ' done' : ''}" role="img" aria-label="${a.done ? 'Done' : 'To do'}"></span><span>${esc(a.task)}${a.owner || a.due ? ` <span class="who">${esc([a.owner === 'Me' ? AUTHOR : a.owner, a.due && `due ${a.due}`].filter(Boolean).join(', '))}</span>` : ''}</span></li>`).join('')}</ul></section>`
    : '';

  // Consecutive lines from the same voice read as one turn.
  const turns = [];
  for (const s of segments) {
    const name = s.speaker === 'Me' ? AUTHOR : `${s.speaker}${s.voice ? ` ${s.voice}` : ''}`;
    const last = turns[turns.length - 1];
    if (last && last.name === name) last.text += ` ${s.text}`;
    else turns.push({ name, from: s.from, text: s.text });
  }
  const transcript = turns.length
    ? `<section><details><summary><h2>Transcript</h2></summary>${turns.map((t) => `<div class="line"><span class="time">${mmss(t.from)}</span><div><span class="name${t.name === AUTHOR ? ' me' : ''}">${esc(t.name)}</span> ${esc(t.text)}</div></div>`).join('')}</details></section>`
    : '';

  return `<!doctype html>
<html lang="${esc(lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${esc(title)}</title>
<meta name="description" content="Meeting notes, action items and transcript.">
<style>${STYLE}</style>
</head>
<body>
<main>
<h1>${esc(title)}</h1>
<p class="meta">${meta}</p>
${notes ? `<section>${notes}</section>` : ''}
${actions}
${transcript}
<footer>Notes written by Muesli on the author's own computer.</footer>
</main>
</body>
</html>
`;
}

module.exports = { page };
