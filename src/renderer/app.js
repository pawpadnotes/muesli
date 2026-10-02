const api = window.muesli;
const $ = (id) => document.getElementById(id);

// h('div.card', { onclick }, child, ...) -> element. Strings become text nodes.
function h(spec, attrs, ...kids) {
  const [tag, ...classes] = spec.split('.');
  const el = document.createElement(tag || 'div');
  if (classes.length) el.className = classes.join(' ');
  if (attrs && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) {
    kids.unshift(attrs);
    attrs = null;
  }
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k.startsWith('on')) el[k] = v;
    else if (k === 'style') el.style.cssText = v; // the CSP blocks style attributes, not the style API
    else if (v === true) el.setAttribute(k, '');
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  el.append(...kids.flat(Infinity).filter((k) => k != null && k !== false));
  return el;
}
const icon = (name) => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'icon');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
};
const button = (cls, label, onclick, ico, attrs = {}) => h(`button.btn.${cls}`, { onclick, ...attrs }, ico && icon(ico), label);
const pill = (kind, text) => h(`span.pill${kind ? `.pill-${kind}` : ''}`, text);

const clock = (sec) => `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
const fmtDate = (iso) => new Date(iso).toLocaleString([], { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
const fmtTime = (iso) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const fmtDuration = (sec) => (sec >= 60 ? `${Math.round(sec / 60)} min` : `${sec} s`);

let toastTimer;
function toast(text) {
  $('toast').textContent = text;
  $('toast').classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('toast').classList.remove('show'), 2200);
}
const copy = (text, what) => navigator.clipboard.writeText(text).then(() => toast(`${what} copied`));

const state = {
  list: [],
  query: '',
  current: null, // full meeting, or null for the welcome page
  tab: 'mine', // 'mine' | 'enhanced' | 'transcript' | 'ask'
  live: null, // { id, segments } while recording
  upcoming: [], // from the calendar link, if one was added
  voices: [], // people Muesli recognises by voice
  words: { terms: [], fixes: [], maybe: [], packs: [] }, // names and jargon the user taught it
  askAll: false, // the page that questions every meeting at once
  allChat: [], // [{ q, a }], kept until the app closes
  asking: null, // { id, q, text } while an answer streams in
  rec: null, // { meetingId, ctx, streams, startedAt, peaks, timer }
  busy: {}, // meetingId -> { lines: [], error }
  inventory: null,
  settings: {},
  templates: {},
  pull: null, // { model, pct, status }
};

// ---------- sidebar ----------

// What the sidebar remembers between launches: the view and which groups are folded.
const kept = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } };
const keep = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage is off */ } };
const side = { view: kept('muesli.view', 'date'), folded: kept('muesli.folded', {}) };

async function refreshList() {
  state.list = state.query ? await api.meetings.search(state.query) : await api.meetings.list();
  drawList();
}

function drawList() {
  const rows = [];
  const folders = allFolders();
  const byFolder = side.view === 'folder' && folders.length > 0;
  if (folders.length && !state.query) {
    const tab = (view, label) => h(`button${(view === 'folder') === byFolder ? '.active' : ''}`, { 'aria-pressed': String((view === 'folder') === byFolder), onclick: () => { side.view = view; keep('muesli.view', view); drawList(); } }, label);
    rows.push(h('div.side-view', { role: 'group', 'aria-label': 'Arrange meetings' }, tab('date', 'By date'), tab('folder', 'By folder')));
  }
  const soon = state.query ? [] : state.upcoming.filter((e) => new Date(e.end) > Date.now()).slice(0, 3);
  if (soon.length) {
    rows.push(h('div.side-label', 'Coming up'));
    for (const e of soon) {
      const now = new Date(e.start) <= Date.now();
      rows.push(h('button.row.row-event', { title: `Start notes for ${e.title}`, onclick: () => newMeeting(e) },
        h('span.row-title', e.title),
        h('span.row-date', now ? h('span.row-rec', 'Now') : h('span', `${dayGroup(e.start, true)} ${fmtTime(e.start)}`), e.people && h('span', e.people))));
    }
  }
  const row = (m, when, showFolder) => h(`button.row${state.current?.id === m.id ? '.active' : ''}`, { title: m.title, onclick: () => open(m.id) },
    h('span.row-title', m.title || 'Untitled meeting'),
    h('span.row-date',
      h('span', when),
      state.rec?.meetingId === m.id ? h('span.row-rec', 'Recording') : m.durationSec > 0 && h('span', fmtDuration(m.durationSec)),
      showFolder && m.folder && h('span.row-folder', m.folder)),
    m.pinned && h('span.row-pin', { 'aria-label': 'Pinned' }, icon('pin')));
  const when = (m, g) => (g === 'Today' || g === 'Yesterday' ? fmtTime(m.createdAt)
    : g === 'This week' || g === 'Last week' ? `${new Date(m.createdAt).toLocaleDateString([], { weekday: 'short' })} ${fmtTime(m.createdAt)}`
      : new Date(m.createdAt).toLocaleDateString([], { day: 'numeric', month: 'short' }));
  if (state.query) {
    if (state.list.length) rows.push(h('div.side-label', 'Results'));
    for (const m of state.list) rows.push(row(m, fmtDate(m.createdAt), true));
  } else {
    // Groups in order, each a label that folds. Months start folded so a long history stays short.
    const groups = new Map();
    const into = (name, m, open) => (groups.get(name) || groups.set(name, { open, items: [] }).get(name)).items.push(m);
    for (const m of state.list) if (m.pinned) into('Pinned', m, true);
    if (byFolder) {
      for (const f of folders) for (const m of state.list) if (m.folder === f) into(f, m, true);
      for (const m of state.list) if (!m.folder) into('No folder', m, true);
    } else {
      for (const m of state.list) if (!m.pinned) { const g = dayGroup(m.createdAt); into(g, m, RECENT.includes(g)); }
    }
    for (const [name, g] of groups) {
      const open = side.folded[name] === undefined ? g.open || g.items.some((m) => m.id === state.current?.id) : !side.folded[name];
      rows.push(h(`button.side-label.fold${open ? '.open' : ''}`, { 'aria-expanded': String(open), onclick: () => { side.folded[name] = open; keep('muesli.folded', side.folded); drawList(); } },
        h('span.fold-name', name), h('span.fold-count', String(g.items.length))));
      if (open) for (const m of g.items) rows.push(row(m, byFolder || name === 'Pinned' ? when(m, dayGroup(m.createdAt)) : when(m, name), !byFolder));
    }
  }
  $('list').replaceChildren(...(rows.length ? rows : [h('div.list-empty', state.query ? 'No meetings match.' : 'No meetings yet.')]));
}

const allFolders = () => [...new Set(state.list.map((m) => m.folder).filter(Boolean))].sort();

const RECENT = ['Today', 'Yesterday', 'This week', 'Last week'];
const dayGroup = (iso, ahead) => {
  const days = Math.floor((new Date().setHours(0, 0, 0, 0) - new Date(iso).setHours(0, 0, 0, 0)) / 864e5);
  if (ahead) return days === 0 ? 'Today' : days === -1 ? 'Tomorrow' : new Date(iso).toLocaleDateString([], { weekday: 'short' });
  if (days < 14) return days <= 0 ? 'Today' : days === 1 ? 'Yesterday' : days < 7 ? 'This week' : 'Last week';
  const d = new Date(iso);
  return d.toLocaleDateString([], d.getFullYear() === new Date().getFullYear() ? { month: 'long' } : { month: 'long', year: 'numeric' });
};

// Bottom of the sidebar: where the work happens, and whether notes can be written yet.
function paintStatus() {
  const inv = state.inventory;
  if (!inv) return;
  const problem = !inv.ollamaRunning ? 'Ollama is not running' : !modelReady() ? 'Notes model not downloaded' : '';
  $('status').className = `status${problem ? ' warn' : ''}`;
  $('status').title = problem || `Transcription and notes run on this computer. Notes model: ${chosenModel()}`;
  $('status').replaceChildren(h('span.status-dot'), h('span.status-text', problem || `On this computer · ${chosenModel()}`));
}

async function open(id) {
  stopPlayback();
  state.askAll = false;
  state.current = id ? await api.meetings.get(id) : null;
  state.tab = state.current?.result ? 'enhanced' : 'mine';
  if (state.current) {
    $('audio-me').src = `muesli-audio://meeting/${id}/me.wav`;
    $('audio-them').src = `muesli-audio://meeting/${id}/them.wav`;
  }
  render();
  refreshList();
}

async function refreshUpcoming() {
  state.upcoming = await api.upcoming().catch(() => []);
  refreshList();
}

// event: a calendar entry to take the title and people from. Without one, a meeting on the calendar right now is used.
async function newMeeting(event) {
  const e = event?.title ? event : state.upcoming.find((x) => new Date(x.start) - 10 * 60000 <= Date.now() && new Date(x.end) > Date.now());
  const m = await api.meetings.create({ template: state.settings.template || 'general', ...(e && { title: e.title, people: e.people }) });
  await open(m.id);
  document.querySelector('.notepad')?.focus();
}

// ---------- recording ----------

function tap(ctx, stream, meetingId, track) {
  const node = new AudioWorkletNode(ctx, 'pcm-worklet');
  node.port.onmessage = ({ data }) => {
    if (data.pcm) return api.sendChunk(meetingId, track, data.pcm);
    if (!state.rec) return;
    state.rec.levels[track].push(data.level);
    if (data.level > 0.01) state.rec.heard[track] = Date.now();
    paintCapture();
  };
  ctx.createMediaStreamSource(stream).connect(node);
}

async function startRecording() {
  const meetingId = state.current.id;
  await api.startRecording(meetingId);
  const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
  // Video is required to get loopback audio; drop it straight away.
  const display = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
  display.getVideoTracks().forEach((t) => t.stop());
  const system = new MediaStream(display.getAudioTracks());

  const ctx = new AudioContext({ sampleRate: 16000 });
  await ctx.audioWorklet.addModule('pcm-worklet.js');
  state.rec = { meetingId, ctx, streams: [mic, display], startedAt: Date.now(), levels: { me: [], them: [] }, heard: { me: 0, them: 0 } };
  tap(ctx, mic, meetingId, 'me');
  tap(ctx, system, meetingId, 'them');
  state.rec.timer = setInterval(paintCapture, 500);
  render();
  refreshList();
  toast('Recording. Let the others know the call is being recorded.');
}

async function stopRecording() {
  const { meetingId, ctx, streams, timer } = state.rec;
  clearInterval(timer);
  state.rec = null;
  state.live = null;
  if (state.tab === 'transcript') state.tab = 'mine';
  streams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
  await ctx.close();
  await api.stopRecording(meetingId);
  await process(meetingId, true);
}

const BARS = 14; // the last 1.4 s of each side
function paintCapture() {
  const rec = state.rec;
  if (!rec || state.current?.id !== rec.meetingId) return;
  const el = $('clock');
  if (!el) return;
  el.textContent = clock((Date.now() - rec.startedAt) / 1000);
  for (const track of ['me', 'them']) {
    const recent = (rec.levels[track] = rec.levels[track].slice(-BARS));
    [...$(`wave-${track}`).children].forEach((bar, i) => (bar.style.height = `${Math.min(100, Math.sqrt(recent[i - (BARS - recent.length)] || 0) * 130)}%`));
  }
  const quiet = (track) => Date.now() - Math.max(rec.heard[track], rec.startedAt) > 8000;
  const note = quiet('me') && quiet('them') ? 'No audio from either side' : quiet('me') ? 'No audio from your mic' : quiet('them') ? 'No call audio' : '';
  $('health').textContent = note;
  $('health').title = note === 'No call audio' ? 'Nothing is coming from the call yet. If they are talking, check the call plays through the speakers of this computer or headphones.' : note ? 'Check the microphone is plugged in and not muted.' : '';
  $('health').hidden = !note;
}

// A recording made elsewhere: decoded here, stored as the meeting's audio, then treated like any other.
async function importAudio() {
  const file = await api.pickAudio();
  if (!file) return;
  if (!state.current || state.current.transcript.length || state.current.durationSec) await newMeeting();
  const id = state.current.id;
  state.busy[id] = { lines: [{ step: `Reading ${file.name}` }] };
  render();
  try {
    const bytes = file.data;
    const audio = await new OfflineAudioContext(1, 1, 16000).decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    const pcm = new Int16Array(audio.length);
    for (let c = 0; c < audio.numberOfChannels; c++) {
      const data = audio.getChannelData(c);
      for (let i = 0; i < pcm.length; i++) pcm[i] += Math.max(-1, Math.min(1, data[i])) * (32767 / audio.numberOfChannels);
    }
    await api.startRecording(id);
    for (let i = 0; i < pcm.length; i += 160000) api.sendChunk(id, 'them', pcm.slice(i, i + 160000));
    await api.stopRecording(id);
    if (!state.current.title) await api.meetings.update(id, { title: file.name });
  } catch (e) {
    state.busy[id].error = `Muesli could not read that file: ${e.message}`;
    return render();
  }
  await process(id, true);
}

// ---------- transcribe and write notes ----------

const chosenModel = () => state.settings.model || state.inventory?.suggested.model;
const modelReady = () => !!state.inventory?.installed.some((m) => m.name === chosenModel());

async function process(id, transcribe) {
  const busy = (state.busy[id] = { lines: [] });
  render();
  try {
    if (transcribe) await api.meetings.transcribe(id);
    await refreshInventory();
    if (modelReady()) {
      const done = await api.meetings.generate(id);
      if (done.webhookError) toast(`Notes are ready, but the webhook failed: ${done.webhookError}`);
    }
    delete state.busy[id];
  } catch (e) {
    busy.error = e.message;
  }
  if (state.current?.id === id) {
    state.current = await api.meetings.get(id);
    if (state.current.result && !busy.error) state.tab = 'enhanced';
  }
  render();
  refreshList();
}

api.onProgress((id, p) => {
  const busy = state.busy[id];
  if (!busy) return;
  const last = busy.lines[busy.lines.length - 1];
  if (!last || last.step !== p.step) busy.lines.push({ step: p.step, chars: 0 });
  else if (p.token) last.chars += p.token.length;
  if (state.current?.id !== id) return;
  const el = $('progress-log');
  const line = busy.lines[busy.lines.length - 1];
  if (el) el.textContent = line.step;
});

async function refreshInventory() {
  state.inventory = await api.modelInventory();
}

// ---------- playback ----------

const audios = () => [$('audio-me'), $('audio-them')];
function stopPlayback() {
  audios().forEach((a) => a.pause());
}
function seek(sec, play = true) {
  audios().forEach((a) => {
    a.currentTime = sec;
    if (play) a.play().catch(() => {});
  });
  paintPlayer();
}
function togglePlay() {
  const playing = !$('audio-me').paused;
  if (playing) stopPlayback();
  else {
    $('audio-them').currentTime = $('audio-me').currentTime;
    audios().forEach((a) => a.play().catch(() => {}));
  }
  paintPlayer();
}
function paintPlayer() {
  const a = $('audio-me');
  const btn = $('play');
  if (!btn) return;
  btn.replaceChildren(icon(a.paused ? 'play' : 'pause'));
  btn.setAttribute('aria-label', a.paused ? 'Play' : 'Pause');
  $('scrub').max = a.duration || state.current?.durationSec || 0;
  $('scrub').value = a.currentTime;
  $('play-time').textContent = `${clock(a.currentTime)} / ${clock(a.duration || state.current?.durationSec || 0)}`;
  const ms = a.currentTime * 1000;
  if (!a.paused) document.querySelectorAll('.seg').forEach((el) => el.classList.toggle('hit', ms >= +el.dataset.from && ms < +el.dataset.to));
}
['timeupdate', 'pause', 'play', 'loadedmetadata'].forEach((ev) => $('audio-me').addEventListener(ev, paintPlayer));

// ---------- source card ----------
// Rest the mouse on a time or a notes line and a glass card shows the moment it came from:
// who said it, the words, the line before and after, and where in the meeting it sits.
let sourceUi = null;
let sourceWait = 0;
let sourceClip = 0;
const stopClip = () => { if (sourceClip) { clearInterval(sourceClip); sourceClip = 0; stopPlayback(); } };
const closeSource = () => { clearTimeout(sourceWait); stopClip(); sourceUi?.remove(); sourceUi = null; };
// Plays just the moment the card is about, from the kept recording, and stops when the line ends.
function hearSource(seg, btn, fill) {
  if (sourceClip) { stopClip(); btn.replaceChildren(icon('play'), 'Hear it'); fill.style.transform = 'scaleX(0)'; return; }
  const from = Math.max(0, seg.from / 1000 - 0.3), to = (seg.to ?? seg.from + 6000) / 1000 + 0.3;
  seek(from);
  btn.replaceChildren(icon('pause'), 'Stop');
  sourceClip = setInterval(() => {
    const t = $('audio-me').currentTime;
    fill.style.transform = `scaleX(${Math.min(1, (t - from) / (to - from))})`;
    if (t >= to || !sourceUi) { stopClip(); if (btn.isConnected) { btn.replaceChildren(icon('play'), 'Hear it again'); } }
  }, 60);
}
function showSource(anchor) {
  const m = state.current;
  if (!m?.transcript?.length || state.tab === 'transcript') return;
  const [min, sec] = anchor.dataset.src.split(':').map(Number);
  const ms = (min * 60 + sec) * 1000;
  const i = m.transcript.reduce((best, s, n) => (Math.abs(s.from - ms) < Math.abs(m.transcript[best].from - ms) ? n : best), 0);
  const who = (s) => (s.speaker === 'Me' ? 'You' : m.speakers?.[s.voice || 0] || (s.voice ? `Them ${s.voice}` : 'Them'));
  const near = (s) => s && h('div.src-near', h('span.src-who', who(s)), h('span.src-line', s.text));
  const seg = m.transcript[i];
  const total = Math.max(m.durationSec * 1000 || 0, m.transcript.at(-1).to || 1);
  const origin = anchor.dataset.origin;
  closeSource();
  sourceUi = h('div.src-card', { role: 'tooltip' },
    h('div.src-head', h('span.src-time', clock(seg.from / 1000)), h(`span.src-name${seg.speaker === 'Me' ? '.me' : ''}`, who(seg)), h('span.src-kind', 'Transcript')),
    near(m.transcript[i - 1]),
    h('blockquote.src-quote', seg.text),
    near(m.transcript[i + 1]),
    m.durationSec > 0 && (() => {
      const fill = h('i');
      const btn = h('button.src-play', { type: 'button', onclick: () => hearSource(seg, btn, fill) }, icon('play'), 'Hear it');
      return h('div.src-hear', btn, h('span.src-clip', { 'aria-hidden': 'true' }, fill), h('span.src-len', `${Math.max(1, Math.round(((seg.to ?? seg.from + 6000) - seg.from) / 1000))} sec`));
    })(),
    h('div.src-track', { 'aria-hidden': 'true' }, h('i', { style: `left:${Math.min(100, (seg.from / total) * 100).toFixed(1)}%` })),
    h('div.src-foot',
      origin ? h('span.src-origin', h(`span.dot${origin === 'mine' ? '.mine' : ''}`), origin === 'mine' ? 'From your notes' : 'Added by Muesli') : h('span'),
      h('span', `${Math.round((seg.from / total) * 100)}% into the meeting \u00b7 click the time to open`)));
  sourceUi.addEventListener('mouseleave', closeSource);
  document.body.append(sourceUi);
  const r = (anchor.querySelector('.ts') || anchor).getBoundingClientRect();
  const w = sourceUi.offsetWidth, hgt = sourceUi.offsetHeight;
  const left = Math.max(16, Math.min(window.innerWidth - w - 24, r.left + r.width / 2 - w / 2));
  const below = r.bottom + 10;
  sourceUi.style.left = `${left}px`;
  sourceUi.style.top = `${below + hgt <= window.innerHeight - 86 ? below : Math.max(16, r.top - hgt - 10)}px`;
}
const sourceOf = (e) => (e.target instanceof Element ? e.target.closest('[data-src]') : null);
document.addEventListener('mouseover', (e) => {
  const a = sourceOf(e);
  if (!a || a.contains(e.relatedTarget) || a.contains(document.activeElement) && document.activeElement.isContentEditable) return;
  clearTimeout(sourceWait);
  sourceWait = setTimeout(() => showSource(a), a.matches('.ts') ? 120 : 450);
});
// Leaving the line gives a moment to reach the card; once the mouse is on the card it stays.
document.addEventListener('mouseout', (e) => {
  const a = sourceOf(e);
  if (!a || a.contains(e.relatedTarget) || sourceUi?.contains(e.relatedTarget)) return;
  clearTimeout(sourceWait);
  sourceWait = setTimeout(() => { if (!sourceUi?.matches(':hover')) closeSource(); }, 220);
});
document.addEventListener('focusin', (e) => { if (e.target instanceof Element && e.target.matches('.ts[data-src]')) showSource(e.target); else closeSource(); });
for (const type of ['scroll', 'mousedown', 'keydown']) document.addEventListener(type, (e) => { if (!(e.target instanceof Element && sourceUi?.contains(e.target))) closeSource(); }, true);

function jumpTo(mmss) {
  const [m, s] = mmss.split(':').map(Number);
  const ms = (m * 60 + s) * 1000;
  state.tab = 'transcript';
  render();
  const segs = [...document.querySelectorAll('.seg')];
  const target = segs.reduce((best, el) => (Math.abs(+el.dataset.from - ms) < Math.abs(+best.dataset.from - ms) ? el : best), segs[0]);
  if (!target) return;
  target.classList.add('hit');
  target.scrollIntoView({ block: 'center' });
  if (state.current.durationSec) seek(+target.dataset.from / 1000);
}

// ---------- pages ----------

function welcomePage() {
  const needsSetup = state.inventory && !modelReady();
  const how = (ico, name, text) => h('div.tile', h('div.tile-icon', icon(ico)), h('h2', name), h('p', text));
  return h('div.welcome',
    h('div.eyebrow', h('span.status-dot'), 'Private by design. Works offline.'),
    h('h1', 'Meeting notes that ', h('em', 'never leave'), ' this computer'),
    h('p.lead', 'Muesli records both sides of a call, transcribes it and writes the notes on your own machine. No bot joins the meeting, there is no account, and nothing is uploaded.'),
    // Recording needs nothing but the app, so the way in is there from the first second.
    h('div.actions', button(`${needsSetup ? 'btn-ghost' : 'btn-primary'}.btn-lg`, 'Start a meeting', () => newMeeting(), 'mic'), h('button.link', { title: 'Turn a voice memo or any recording into notes', onclick: guardless(importAudio) }, 'or import a recording')),
    needsSetup && setupCard(),
    h('div.tiles',
      how('mic', 'Record', 'Your microphone and the call audio are captured separately, so Muesli knows who said what.'),
      how('pen', 'Jot', 'Type rough notes while you talk. They steer what the finished notes focus on.'),
      how('spark', 'Enhance', 'Your jottings and the transcript become notes, action items and a follow-up email.')));
}

// Shown wherever notes can't be written yet: Ollama missing, or no model downloaded.
function setupCard() {
  const inv = state.inventory;
  const s = inv.suggested;
  const body = !inv.ollamaRunning
    ? [
        h('p', 'You can record a meeting right away. To turn it into notes, Muesli uses Ollama, a free app that runs on your own computer.'),
        h('ol.steps', h('li', 'Install Ollama and open it.'), h('li', 'Muesli notices it by itself and moves on to the download.')),
        h('div.actions', button('btn-primary', 'Get Ollama', () => api.openExternal('https://ollama.com/download')), h('button.link', { onclick: recheck }, 'Check again')),
      ]
    : [
        h('p', `You can record a meeting right away. To turn it into notes, Muesli needs a one-time ${s.sizeGb}\u00a0GB download, chosen to fit this computer.`),
        state.pull
          ? h('div', h('div.small.muted', { id: 'pull-status' }, state.pull.status), h('div.bar', h('div.bar-fill', { id: 'pull-fill', style: `width:${state.pull.pct}%` })))
          : h('div.actions', button('btn-primary', 'Download the notes model', () => pull(s.model)), h('button.link', { title: `Muesli picked ${s.model} for this machine (${memoryLine()})`, onclick: openSettings }, 'Choose another model')),
      ];
  return h('section.setup', h('h2', 'One step before your first notes'), body);
}

const memoryLine = () => {
  const m = state.inventory.memory;
  const gb = `${Math.round(m.totalGb)} GB`;
  return m.kind === 'vram' ? `${m.gpu.replace(/^NVIDIA GeForce |^AMD Radeon /, '')} graphics card, ${gb}` : m.kind === 'unified' ? `${gb} of memory` : `${gb} of memory, no graphics card`;
};

async function recheck() {
  await refreshInventory();
  render();
  if (!state.inventory.ollamaRunning) toast('Ollama is not running yet');
}

async function pull(model) {
  state.pull = { model, pct: 0, status: 'Starting download' };
  render();
  try {
    await api.pullModel(model);
    toast(`${model} is ready`);
  } catch (e) {
    toast(`Download failed: ${e.message}`);
  }
  state.pull = null;
  await refreshInventory();
  render();
  if ($('modal-root').firstChild) openSettings();
}
api.onPull((model, p) => {
  if (!state.pull) return;
  state.pull.pct = p.total ? (p.done / p.total) * 100 : state.pull.pct;
  state.pull.status = p.total ? `${p.status.replace(/ sha256.*/, '')}: ${(p.done / 1e9).toFixed(1)} of ${(p.total / 1e9).toFixed(1)} GB` : p.status;
  document.querySelectorAll('#pull-fill').forEach((el) => (el.style.width = `${state.pull.pct}%`));
  document.querySelectorAll('#pull-status').forEach((el) => (el.textContent = state.pull.status));
});

let saveTimer;
const saveSoon = (fields) => {
  Object.assign(state.current, fields);
  clearTimeout(saveTimer);
  const id = state.current.id;
  saveTimer = setTimeout(() => api.meetings.update(id, fields).then(refreshList), 400);
};

// Which view of the meeting is showing: 'mine' (your notes), 'enhanced' or 'transcript'.
const viewOf = (m) => {
  if (state.rec?.meetingId === m.id) return state.tab === 'transcript' ? 'live' : 'mine';
  if (state.busy[m.id] && !state.busy[m.id].error) return 'mine';
  if (state.tab === 'ask' && m.transcript.length) return 'ask';
  if (state.tab === 'transcript' && m.transcript.length) return 'transcript';
  if (state.tab === 'enhanced' && m.result && state.rec?.meetingId !== m.id) return 'enhanced';
  return 'mine';
};

function meetingPage() {
  const m = state.current;
  const recordingHere = state.rec?.meetingId === m.id;
  const busy = state.busy[m.id];
  const hasAudio = m.durationSec > 0;
  const view = viewOf(m);

  const head = h('div.page-head',
    h('div.title-row',
      h('input.title-input', { value: m.title, placeholder: 'Untitled meeting', 'aria-label': 'Meeting title', oninput: (e) => saveSoon({ title: e.target.value }) }),
      !recordingHere && !busy && h('div.actions',
        m.result && modelReady() && h('button.icon-btn', { title: 'Write the notes again from the transcript', 'aria-label': 'Rewrite notes', onclick: () => process(m.id, false) }, icon('spark')),
        m.transcript.length > 0 && h('button.icon-btn', { title: 'Record this meeting again', 'aria-label': 'Record again', onclick: guard(startRecording), disabled: !!state.rec }, icon('mic')),
        h(`button.icon-btn${m.pinned ? '.on' : ''}`, { title: m.pinned ? 'Unpin from the top of the list' : 'Pin to the top of the list', 'aria-label': m.pinned ? 'Unpin meeting' : 'Pin meeting', 'aria-pressed': String(!!m.pinned), onclick: async () => { m.pinned = !m.pinned; render(); await api.meetings.update(m.id, { pinned: m.pinned }); await refreshList(); } }, icon('pin')),
        h('button.icon-btn', { title: 'Open this meeting’s folder', 'aria-label': 'Open folder', onclick: () => api.meetings.reveal(m.id) }, icon('folder')),
        h('button.icon-btn.danger', { title: 'Move meeting to the bin', 'aria-label': 'Move meeting to the bin', onclick: async () => { await api.meetings.remove(m.id); await open(null); } }, icon('trash')))),
    h('div.sub',
      h('span', fmtDate(m.createdAt)),
      hasAudio && h('span', fmtDuration(m.durationSec)),
      !recordingHere && h('select.meta-select', { 'aria-label': 'Notes template', onchange: (e) => { saveSoon({ template: e.target.value }); api.saveSettings({ template: e.target.value }); } },
        Object.entries(state.templates).map(([key, t]) => h('option', { value: key, selected: key === m.template }, `${t.name} notes`))),
      !recordingHere && h('input.meta-input', { list: 'folder-names', value: m.folder || '', placeholder: 'Add to folder', 'aria-label': 'Folder', size: m.folder ? m.folder.length : 11, onchange: (e) => saveSoon({ folder: e.target.value.trim() }) }),
      h('datalist', { id: 'folder-names' }, allFolders().map((f) => h('option', { value: f }))),
      h('input.meta-input', { value: m.people || '', placeholder: 'Who was there', 'aria-label': 'People in the meeting', size: Math.max(13, (m.people || '').length + 1), onchange: (e) => saveSoon({ people: e.target.value.trim() }) }),
      view === 'enhanced' && h('span.legend', h('span.dot.mine'), 'From your notes')));

  const body = view === 'live' ? liveDoc(m) : view === 'ask' ? askDoc(m) : view === 'transcript' ? transcriptDoc(m, hasAudio) : view === 'enhanced' ? enhancedDoc(m) : mineDoc(m);
  const setup = !m.result && !busy && !recordingHere && m.transcript.length && state.inventory && !modelReady() ? setupCard() : null;
  return h('div.meeting', head, busy?.error && errorCard(m, busy), body, setup, h('div.dock-fade'), dock(m, recordingHere, busy, view));
}

// A failed start or stop must never leave the buttons dead.
const guardless = (fn) => () => fn().catch((err) => { toast(err.message); render(); });
const guard = (fn) => async (e) => {
  e.currentTarget.disabled = true;
  try {
    await fn();
  } catch (err) {
    toast(err.message);
    render();
  }
};

const errorCard = (m, busy) => h('div.card.mt',
  h('div.card-head', h('h2', 'Something went wrong'), pill('danger', 'Error')),
  h('div.card-body', h('pre.log', busy.error), h('div.actions.mt', button('btn-ghost', 'Dismiss', () => { delete state.busy[m.id]; render(); }))));

// The one floating control: what is happening now, and the switch between the views of a meeting.
function dock(m, recordingHere, busy, view) {
  if (recordingHere) {
    const level = (track, label) => h(`span.dock-level.${track}`, { title: track === 'me' ? 'Your microphone' : 'Computer audio' }, h('span.dock-label', label), h('span.wave', { id: `wave-${track}` }, Array.from({ length: BARS }, () => h('i'))));
    return h('div.dock',
      h('span.rec-dot'),
      h('span.dock-clock', { id: 'clock' }, '00:00'),
      level('me', 'You'), level('them', 'Them'),
      h('span.pill.pill-warn', { id: 'health', hidden: true }),
      h('button.dock-toggle', { title: view === 'live' ? 'Back to your notes' : 'Watch the transcript as it is written', onclick: () => { state.tab = view === 'live' ? 'mine' : 'transcript'; render(); if (view !== 'live') document.querySelector('.scroll').scrollTop = 1e9; } }, view === 'live' ? 'Notes' : 'Transcript'),
      button('btn-recording.btn-sm', 'Stop', guard(stopRecording), 'stop'));
  }
  if (busy && !busy.error) {
    return h('div.dock', h('span.dock-busy'), h('span.dock-note', { id: 'progress-log' }, busy.lines[busy.lines.length - 1]?.step || 'Starting'));
  }
  const tab = (key, label, enabled = true) => h(`button${view === key ? '.active' : ''}`, { disabled: !enabled, 'aria-pressed': String(view === key), onclick: () => { state.tab = key; render(); } }, label);
  const hasTranscript = m.transcript.length > 0;
  // One solid button at most: Record until there is a transcript, then Enhance until there are notes.
  const next = m.unfinished
    ? h('button.btn.btn-primary.btn-sm', { title: 'This recording was interrupted. The audio is safe; this turns it into a transcript and notes.', onclick: () => process(m.id, true) }, icon('spark'), 'Make notes from it')
    : !hasTranscript
    ? h('button.btn.btn-primary.btn-sm', { onclick: guard(startRecording), disabled: !!state.rec }, icon('mic'), 'Record')
    : !m.result && modelReady() && h('button.btn.btn-primary.btn-sm', { onclick: () => process(m.id, false) }, icon('spark'), 'Enhance');
  if (m.unfinished) return h('div.dock', h('span.dock-note', 'This recording was interrupted. The audio is safe.'), next);
  if (!hasTranscript && !m.result) return h('div.dock', next, h('button.dock-toggle', { title: 'Turn a voice memo or any recording into notes', onclick: guardless(importAudio), disabled: !!state.rec }, 'Import audio'));
  return h('div.dock', h('div.dock-tabs', tab('mine', 'My notes'), tab('enhanced', 'Enhanced', !!m.result), tab('transcript', 'Transcript', hasTranscript), tab('ask', 'Ask', hasTranscript)), next);
}

const mineDoc = (m) => h('div.doc',
  h('textarea.notepad', { placeholder: m.unfinished ? 'Your notes for this meeting.' : 'Jot anything worth remembering while you talk: names, numbers, what to follow up on. Muesli fills in the rest from the transcript.', oninput: (e) => saveSoon({ userNotes: e.target.value }) }, m.userNotes));

const isTime = (t) => /^\d+:\d\d$/.test(t || '');
// Who was talking at a time in the meeting, by the transcript line nearest to it.
function saidBy(m, mmss) {
  if (!m.transcript?.length) return '';
  const [min, sec] = mmss.split(':').map(Number);
  const ms = (min * 60 + sec) * 1000;
  const s = m.transcript.reduce((best, x) => (Math.abs(x.from - ms) < Math.abs(best.from - ms) ? x : best));
  return s.speaker === 'Me' ? 'You' : m.speakers?.[s.voice || 0] || (s.voice ? `Them ${s.voice}` : 'Them');
}
// Amounts, counts and dates set a little heavier, so the facts in a line are what the eye lands on.
const FIGURE = /(?:[$€£]\s?)?\d[\d,.]*\d?\s?(?:k|m|bn|%|x|h|hrs?|hours?|mins?|minutes?|days?|weeks?|months?|years?|agents|people|seats|tickets)?(?:\/(?:mo|month|yr|year|week|day|seat|user))?(?![\w:])|\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.? \d{1,2}(?:st|nd|rd|th)?\b|\b(?:Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day\b|\bQ[1-4]\b/g;
function figures(text) {
  const out = [];
  let at = 0;
  for (const hit of text.matchAll(FIGURE)) {
    const word = hit[0].trimEnd();
    if (hit.index > at) out.push(text.slice(at, hit.index));
    out.push(h('b.fig', word));
    at = hit.index + word.length;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}

function enhancedDoc(m) {
  const r = m.result;
  const saveResult = () => api.meetings.saveResult(m.id, r);
  const sections = r.notes.sections.filter((s) => s.bullets.length);
  const mine = sections.flatMap((s) => s.bullets).filter((b) => b.from_my_notes).length;
  const voices = new Set(m.transcript.map((s) => s.speaker + (s.voice || ''))).size;
  const lengthSec = m.durationSec || (m.transcript.at(-1)?.to || 0) / 1000;
  const open = r.actions.filter((a) => !a.done).length;
  const stat = (label, ...value) => h('div.stat', h('div.stat-label', label), h('div.stat-value', value));
  return h('div.doc',
    h('div.stats',
      lengthSec > 0 && stat('Length', fmtDuration(Math.round(lengthSec))),
      voices > 0 && stat('Speakers', String(voices)),
      stat('Action items', String(r.actions.length), r.actions.length > 0 && h('small', open === r.actions.length ? 'open' : open ? `${open} still open` : 'all done')),
      ),
    sections.map((s) => {
      const secs = (t) => t.split(':').reduce((n, x) => n * 60 + Number(x), 0);
      const times = s.bullets.map((b) => b.timestamp).filter(isTime).sort((x, y) => secs(x) - secs(y));
      return h('section',
        h('div.section-head', h('h3', s.heading),
          h('span.section-meta', `${s.bullets.length} ${s.bullets.length === 1 ? 'point' : 'points'}${times.length ? ` · ${times[0]}${times.at(-1) !== times[0] ? `–${times.at(-1)}` : ''}` : ''}`)),
        h('ul.bullets', s.bullets.map((b) => {
          const edit = h('span.edit', { contenteditable: 'plaintext-only', spellcheck: 'false', onblur: (e) => { const t = e.target.textContent.trim(); if (t && t !== b.text) { b.text = t; saveResult(); } e.target.replaceChildren(...figures(e.target.textContent)); } }, figures(b.text));
          const said = isTime(b.timestamp) && saidBy(m, b.timestamp);
          return h('li', isTime(b.timestamp) ? { 'data-src': b.timestamp, 'data-origin': b.from_my_notes ? 'mine' : 'ai' } : {},
            h(`span.dot${b.from_my_notes ? '.mine' : ''}`, { title: b.from_my_notes ? 'From your notes' : 'Added from the transcript' }),
            edit,
            isTime(b.timestamp) && h('span.said', said && h(`span.said-who${said === 'You' ? '.me' : ''}`, said),
              h('button.ts', { 'aria-label': `Show ${b.timestamp} in the transcript`, onclick: () => jumpTo(b.timestamp) }, b.timestamp)));
        })));
    }),
    r.actions.length > 0 && h('section.panel',
      h('div.panel-head', h('h3', 'Action items'), h('span.panel-meta', open ? `${open} of ${r.actions.length} open` : 'All done')),
      h('div.panel-body', r.actions.map((a) => h(`label.todo${a.done ? '.done' : ''}`,
        h('input', { type: 'checkbox', checked: !!a.done, onchange: (e) => { a.done = e.target.checked; saveResult(); render(); } }),
        h('span.todo-task', a.task),
        h('span.todo-meta', a.owner && pill(a.owner === 'Me' ? 'accent' : '', a.owner === 'Me' ? 'You' : a.owner), a.due && pill('', a.due)))))),
    r.email && h('section.panel',
      h('div.panel-head', h('h3', 'Follow-up email'), h('button.link', { onclick: () => copy(r.email, 'Email') }, icon('copy'), 'Copy email')),
      h('pre.email.edit', { contenteditable: 'plaintext-only', spellcheck: 'false', onblur: (e) => { if (e.target.textContent !== r.email) { r.email = e.target.textContent; saveResult(); } } }, r.email)),
    h('div.doc-foot',
      h('span', `Written on this computer by ${r.model}`),
      h('span.grow'),
      h('button.link', { title: 'One file with the notes and transcript that opens in any browser. Email it or drop it in a shared folder.', onclick: () => exportAs(m, 'html') }, 'Share as web page'),
      h('button.link', { onclick: () => exportAs(m, 'pdf') }, 'Export PDF'),
      h('button.link', { onclick: () => exportAs(m, 'md') }, 'Export Markdown'),
      h('button.link', { onclick: () => copy(markdown(m), 'Notes') }, icon('copy'), 'Copy notes')));
}

async function exportAs(m, kind) {
  const file = await api.meetings.export(m.id, kind);
  if (file) toast(`Saved to ${file}`);
}

function markdown(m) {
  const r = m.result;
  const out = [`# ${m.title || r.notes.title || 'Meeting'}`, ''];
  for (const s of r.notes.sections) if (s.bullets.length) out.push(`## ${s.heading}`, ...s.bullets.map((b) => `- ${b.text}`), '');
  if (r.actions.length) out.push('## Action items', ...r.actions.map((a) => `- [${a.done ? 'x' : ' '}] ${a.task} (${a.owner}${a.due ? `, due ${a.due}` : ''})`), '');
  return out.join('\n');
}

function transcriptDoc(m, hasAudio) {
  const who = (s) => (s.speaker === 'Me' ? 'You' : m.speakers?.[s.voice || 0] || (s.voice ? `Them ${s.voice}` : 'Them'));
  // A name Muesli worked out from the conversation, not yet confirmed by the user.
  const guessOf = (s) => s.speaker !== 'Me' && m.speakers?.[s.voice || 0] && m.guessed?.[s.voice || 0];
  // Click a voice to give it a name; every line of that voice follows.
  const rename = (s) => (e) => {
    const input = h('input.who-input', { value: m.speakers?.[s.voice || 0] || '', placeholder: 'Name', 'aria-label': 'Speaker name' });
    let left = false;
    const done = async () => {
      if (left) return render();
      const name = input.value.trim();
      const known = name && (name !== (m.speakers?.[s.voice || 0] || '') || guessOf(s));
      m.speakers = { ...m.speakers, [s.voice || 0]: name };
      // Leaving the name as it is confirms a guess; either way it is the user's name now.
      const { [String(s.voice || 0)]: _mine, ...guessed } = m.guessed || {};
      m.guessed = guessed;
      render();
      await api.meetings.update(m.id, { speakers: m.speakers, guessed });
      state.voices = await api.voices.list();
      if (known && state.voices.some((v) => v.name === name)) toast(`Muesli will recognise ${name} next time`);
    };
    input.onblur = done;
    input.onkeydown = (ev) => { if (ev.key === 'Escape') left = true; if (ev.key === 'Enter' || ev.key === 'Escape') input.blur(); };
    e.currentTarget.replaceWith(input);
    input.focus();
  };
  // A guessed name opens a small card: yes, no, or somebody else.
  const settle = (s) => (e) => {
    closeFix();
    const key = s.voice || 0;
    const g = guessOf(s);
    const guess = m.speakers[key];
    const save = async (name) => {
      closeFix();
      const { [String(key)]: _mine, ...guessed } = m.guessed || {};
      m.speakers = { ...m.speakers, [key]: name };
      m.guessed = guessed;
      render();
      await api.meetings.update(m.id, { speakers: m.speakers, guessed });
      state.voices = await api.voices.list();
      if (name && state.voices.some((v) => v.name === name)) toast(`Muesli will recognise ${name} next time`);
    };
    const input = h('input.input', { placeholder: 'Somebody else? Type their name', 'aria-label': 'Another name', spellcheck: 'false' });
    placeFix(h('form.fix-pop', { role: 'dialog', 'aria-label': 'Guessed name', onsubmit: (ev) => { ev.preventDefault(); if (input.value.trim()) save(input.value.trim()); }, onkeydown: (ev) => ev.key === 'Escape' && closeFix() },
      h('div', 'Muesli thinks this is ', h('strong', guess), '.'),
      h('div.small.muted', `They ${g.why}. ${Math.round(g.confidence * 100)}% sure.`),
      h('div.fix-actions.fix-start',
        h('button.btn.btn-primary.btn-sm', { type: 'button', onclick: () => save(guess) }, `Yes, it\u2019s ${guess}`),
        h('button.btn.btn-ghost.btn-sm', { type: 'button', onclick: () => save('') }, `Not ${guess}`)),
      input), e.currentTarget.getBoundingClientRect());
    fixUi.querySelector('button').focus();
  };
  const text = m.transcript.map((s) => `[${clock(s.from / 1000)}] ${who(s)}: ${s.text}`).join('\n');
  return h('div.doc',
    hasAudio && h('div.player',
      h('button.icon-btn', { id: 'play', 'aria-label': 'Play', onclick: togglePlay }, icon('play')),
      h('input', { type: 'range', id: 'scrub', min: 0, max: m.durationSec, step: 0.1, value: 0, 'aria-label': 'Position', oninput: (e) => seek(+e.target.value, false) }),
      h('span.mono', { id: 'play-time' }, `00:00 / ${clock(m.durationSec)}`)),
    m.transcript.map((s, i) => h('div.seg', { 'data-i': i, 'data-from': s.from, 'data-to': s.to ?? s.from + 1 },
      h('button.ts', { disabled: !hasAudio, onclick: () => seek(s.from / 1000) }, clock(s.from / 1000)),
      s.speaker === 'Me' ? h('span.who.me', 'You') : guessOf(s)
        ? h('button.who.guess', { title: `Muesli guessed this name (${Math.round(guessOf(s).confidence * 100)}% sure): they ${guessOf(s).why}. Click to confirm or change it.`, onclick: settle(s) }, icon('spark'), who(s))
        : h('button.who', { title: 'Name this speaker', onclick: rename(s) }, who(s)),
      segText(m, s, i))),
    h('div.doc-foot', h('span', `${m.transcript.length} ${m.transcript.length === 1 ? 'line' : 'lines'}, transcribed on this computer. Click or select words to fix them.`), Object.keys(m.guessed || {}).length > 0 && h('span.guess-key', icon('spark'), 'A name with this mark is Muesli\u2019s guess. Click it to confirm or change it.'), h('span.grow'), h('button.link', { onclick: () => copy(text, 'Transcript') }, icon('copy'), 'Copy transcript')));
}

// ---------- fix a word ----------
// Click or select words in a transcript and a small bar appears above them: fix a mishearing, or have Muesli remember a word.
// Words Muesli changed by itself are underlined; clicking one shows what was heard and offers to put it back.

let fixUi = null; // the bar or popover on screen
let fixBack = null; // what had the keyboard before a popover opened
function closeFix() {
  if (!fixUi) return;
  const back = fixUi.contains(document.activeElement) && fixBack;
  fixUi.remove();
  fixUi = null;
  if (back?.isConnected) back.focus();
  fixBack = null;
}
// The bar sits above the words. A popover opens under them, so the line being fixed stays readable,
// and goes above only when there is no room below. Never off the window.
function placeFix(el, rect) {
  document.body.append(el);
  const pop = el.classList.contains('fix-pop');
  const height = el.offsetHeight;
  const above = rect.top - height - 8;
  const below = rect.bottom + 8;
  const left = Math.max(8, Math.min(window.innerWidth - el.offsetWidth - 24, pop ? rect.left - 16 : rect.left + rect.width / 2 - el.offsetWidth / 2));
  const top = pop
    ? below + height <= window.innerHeight - 86 ? below : above >= 8 ? above : Math.max(8, window.innerHeight - height - 8)
    : above < 48 ? Math.min(window.innerHeight - height - 8, below) : above;
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
  fixUi = el;
  // Tab stays inside a popover while it is open.
  if (pop) el.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    const stops = [...el.querySelectorAll('input, button')];
    const edge = e.shiftKey ? stops[0] : stops[stops.length - 1];
    if (document.activeElement === edge) {
      e.preventDefault();
      (e.shiftKey ? stops[stops.length - 1] : stops[0]).focus();
    }
  });
}
const wholeWord = (text) => new RegExp(`(?<![\\p{L}\\p{N}])${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')}(?![\\p{L}\\p{N}])`, 'giu');

// After a change to the transcript on disk: reload it and keep the reader where they were.
async function reloadTranscript(id) {
  const scrollers = [$('page'), $('page').parentElement].map((el) => [el, el.scrollTop]);
  state.current = await api.meetings.get(id);
  render();
  for (const [el, top] of scrollers) el.scrollTop = top;
}

function offerFix(e) {
  if (fixUi?.contains(e.target)) return;
  if (fixUi?.classList.contains('fix-pop')) return e.type === 'mouseup' && closeFix();
  closeFix();
  const sel = getSelection();
  const inText = (node) => (node?.nodeType === 1 ? node : node?.parentElement)?.closest('.doc .seg-text');
  // A plain click picks the word under it.
  if (sel.isCollapsed && e.type === 'mouseup' && inText(e.target) && !e.target.closest('.fixed')) {
    sel.modify('move', 'backward', 'word');
    sel.modify('extend', 'forward', 'word');
  }
  if (!sel.rangeCount || sel.isCollapsed) return;
  const range = sel.getRangeAt(0);
  const box = inText(range.startContainer);
  const raw = sel.toString();
  const heard = raw.trim().replace(/^[.,;:!?"'()]+|[.,;:!?"'()]+$/g, '');
  if (!box || box !== inText(range.endContainer) || !/[\p{L}\p{N}]/u.test(heard) || heard.length > 80 || heard.includes('\n')) return;
  const before = document.createRange();
  before.setStart(box, 0);
  before.setEnd(range.startContainer, range.startOffset);
  const at = { id: state.current.id, index: +box.parentElement.dataset.i, offset: before.toString().length + raw.indexOf(heard), heard, rect: range.getBoundingClientRect() };
  placeFix(h('div.fix-bar', { role: 'toolbar', 'aria-label': 'Selected words', onmousedown: (ev) => ev.preventDefault() },
    h('button', { onclick: () => openFix(at) }, /\s/.test(heard) ? 'Fix these words' : 'Fix this word'),
    h('button', { title: 'It is right here. Keep spelling it this way in later meetings.', onclick: async () => {
      closeFix();
      getSelection().removeAllRanges();
      await api.words.add({ term: heard });
      toast(`Muesli will spell \u201c${heard}\u201d this way from now on`);
    } }, 'Spelled right, remember it')), at.rect);
}

function openFix({ id, index, offset, heard, rect }) {
  closeFix();
  const count = state.current.transcript.reduce((n, s) => n + (s.text.match(wholeWord(heard)) || []).length, 0);
  const input = h('input.input', { value: heard, placeholder: 'What was said', 'aria-label': 'What was said', spellcheck: 'false' });
  const everywhere = h('input', { type: 'checkbox', checked: count > 1 });
  const error = h('p.small.fix-error', { role: 'alert' });
  const always = h('span', 'Always change it');
  input.oninput = () => {
    error.textContent = '';
    const meant = input.value.trim();
    always.textContent = meant && meant !== heard ? `Always write \u201c${meant}\u201d` : 'Always change it';
  };
  // One click on a choice fixes the word and says how to treat it next time. Enter takes the careful one.
  const option = (value, label) => h('button.fix-opt', { type: 'button', onclick: () => apply(value) }, label);
  const submit = (e) => { e.preventDefault(); apply('context'); };
  const apply = async (remember) => {
    const meant = input.value.trim();
    if (!meant) return (error.textContent = 'Type what was said.');
    if (meant === heard) return (error.textContent = 'That is what Muesli heard. Type what was really said.');
    const res = await api.meetings.fix(id, { index, offset, heard, meant, everywhere: everywhere.checked, remember });
    closeFix();
    await reloadTranscript(id);
    const where = res.count > 1 ? `Fixed in ${res.count} lines` : 'Fixed';
    toast(res.saved.error ? `${where} here. Not remembered: ${res.saved.error}`
      : res.saved.everyday ? `${where}. \u201c${heard}\u201d is an everyday word, so Muesli will change it only when it fits`
      : res.saved.maybe ? `${where}. Next time Muesli hears \u201c${heard}\u201d it will change it only when it fits`
      : res.saved.standing ? where
      : `${where}. Muesli will write \u201c${meant}\u201d from now on`);
    state.words = await api.words.list();
  };
  placeFix(h('form.fix-pop', { role: 'dialog', 'aria-label': 'Fix this word', onsubmit: submit, onkeydown: (e) => e.key === 'Escape' && closeFix() },
    h('div.small.muted', 'Muesli heard ', h('span.fix-heard', heard)),
    input,
    error,
    h('fieldset.fix-opts',
      h('legend.small.muted', `Pick one to fix it. Next time Muesli hears \u201c${heard}\u201d:`),
      option('context', h('span', 'Change it only when it fits', h('span.small.muted.fix-note', 'Muesli reads the sentence first. Best for ordinary words.'))),
      option('always', h('span', always, h('span.small.muted.fix-note', 'Best for names and terms.')))),
    count > 1 && h('label.fix-all', everywhere, h('span', `Fix all ${count} in this transcript`))), rect);
  input.select();
}

// A line of transcript, with the words Muesli corrected by itself marked.
function segText(m, s, i) {
  const fixed = (s.fixed || []).filter((f) => s.text.includes(f.to));
  if (!fixed.length) return h('span.seg-text', { tabindex: 0 }, s.text);
  const parts = [];
  let rest = s.text;
  for (const f of fixed.sort((a, b) => s.text.indexOf(a.to) - s.text.indexOf(b.to))) {
    const at = rest.indexOf(f.to);
    if (at < 0) continue;
    parts.push(rest.slice(0, at), h('button.fixed', { title: `Muesli heard \u201c${f.from}\u201d`, 'aria-label': `${f.to}, corrected from ${f.from}`, onclick: (e) => {
      e.stopPropagation();
      closeFix();
      fixBack = e.currentTarget;
      const undo = (never) => async () => {
        closeFix();
        await api.meetings.unfix(m.id, i, f, never);
        await reloadTranscript(m.id);
        toast(never ? `Muesli will leave \u201c${f.from}\u201d alone from now on` : 'Changed back');
      };
      placeFix(h('div.fix-pop.fix-wide', { role: 'dialog', 'aria-label': 'Automatic correction', onkeydown: (ev) => ev.key === 'Escape' && closeFix() },
        h('div', 'Muesli heard ', h('span.fix-heard', f.from), ' and wrote ', h('strong', f.to), '.'),
        h('div.small.muted', f.why === 'judge' ? 'You fixed this before, and it fits this sentence too.' : f.why === 'fix' ? 'One of your saved fixes.' : f.why === 'case' ? 'It is one of your words.' : `It sounds like \u201c${f.to}\u201d, one of your words.`),
        h('div.fix-actions',
          h('button.btn.btn-ghost.btn-sm', { onclick: undo(false) }, 'Change back'),
          h('button.btn.btn-ghost.btn-sm', { title: `Change it back, and never change \u201c${f.from}\u201d to \u201c${f.to}\u201d again`, onclick: undo(true) }, 'Stop correcting this'),
          h('button.btn.btn-primary.btn-sm', { onclick: closeFix }, 'Keep'))), e.currentTarget.getBoundingClientRect());
      fixUi.tabIndex = -1;
      fixUi.focus();
    } }, f.to));
    rest = rest.slice(at + f.to.length);
  }
  return h('span.seg-text', { tabindex: 0 }, ...parts, rest);
}
document.addEventListener('mouseup', (e) => setTimeout(() => offerFix(e)));
document.addEventListener('keyup', (e) => e.shiftKey && offerFix(e));
document.addEventListener('keydown', (e) => e.key === 'Escape' && closeFix());
// Without a mouse: Tab to a line, Enter picks its first word, the arrow keys move word by word, Enter again opens the bar.
document.addEventListener('keydown', (e) => {
  const box = e.target.closest?.('.doc .seg-text');
  if (!box || e.target !== box || !['Enter', 'ArrowLeft', 'ArrowRight'].includes(e.key)) return;
  const sel = getSelection();
  const picked = !sel.isCollapsed && box.contains(sel.anchorNode);
  if (!picked && e.key !== 'Enter') return;
  e.preventDefault();
  if (!picked) {
    sel.collapse(box, 0);
    sel.modify('extend', 'forward', 'word');
  } else if (e.key === 'Enter') {
    offerFix({ type: 'keyup', target: box });
    if (fixUi) {
      fixBack = box;
      fixUi.querySelector('button').focus();
    }
  } else {
    const forward = e.key === 'ArrowRight';
    sel[forward ? 'collapseToEnd' : 'collapseToStart']();
    if (!forward) sel.modify('move', 'backward', 'word');
    sel.modify('extend', 'forward', 'word');
    if (!box.contains(sel.focusNode)) sel.removeAllRanges();
  }
});
document.addEventListener('scroll', () => fixUi && !fixUi.classList.contains('fix-pop') && closeFix(), true);

// ---------- live transcript and questions ----------

api.onLive((id, segments) => {
  if (state.rec?.meetingId !== id) return;
  state.live = { id, segments };
  if (state.current?.id === id && state.tab === 'transcript') {
    render();
    document.querySelector('.scroll').scrollTop = 1e9;
  }
});

const liveDoc = (m) => {
  const segs = state.live?.id === m.id ? state.live.segments : [];
  return h('div.doc',
    segs.length
      ? segs.map((s) => h('div.seg', h('span.ts', clock(s.from / 1000)), h(`span.who${s.speaker === 'Me' ? '.me' : ''}`, s.speaker === 'Me' ? 'You' : 'Them'), h('span.seg-text', s.text)))
      : h('p.muted', 'The transcript appears here a few seconds behind the call.'),
    h('div.doc-foot', h('span', 'Live preview. Muesli transcribes the whole recording again when you stop.')));
};

// Answers cite moments as [mm:ss]; each becomes a button that jumps to the transcript.
// The model answers in plain text with "- " lists. Each list line is its own block with a hanging bullet.
const asLines = (text, inline) => text.split('\n').map((line) => {
  const item = /^\s*[-*\u2022]\s+(.*)$/.exec(line);
  return item ? h('span.a-li', ...inline(item[1])) : h('span.a-p', ...inline(line));
});
const withTimes = (text) => asLines(text, timeParts);
const timeParts = (text) => text.replace(/(\[\d{1,3}:\d\d\])\s*[.,;]/g, '$1').split(/(\[\d{1,3}:\d\d\])/).map((part) => {
  const t = /^\[(\d{1,3}:\d\d)\]$/.exec(part);
  return t ? h('button.ts', { 'data-src': t[1], 'aria-label': `Show ${t[1]} in the transcript`, onclick: () => jumpTo(t[1]) }, t[1]) : part;
});

async function ask(question) {
  const m = state.current;
  question = question.trim();
  if (!question || state.asking) return;
  state.asking = { id: m.id, q: question, text: '' };
  render();
  try {
    const chat = await api.meetings.ask(m.id, question);
    if (state.current?.id === m.id) state.current.chat = chat;
  } catch (e) {
    toast(`Could not answer: ${e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}`);
  }
  state.asking = null;
  render();
  document.querySelector('.ask-input')?.focus();
}
api.onAsk((id, token) => {
  if (state.asking?.id !== id) return;
  state.asking.text += token;
  const el = $('ask-stream');
  if (el) el.replaceChildren(...(id === 'all' ? withMeetings : withTimes)(state.asking.text));
  document.querySelector('.scroll').scrollTop = 1e9;
});

// Answers across meetings name their source; each title becomes a button that opens that meeting.
const withMeetings = (text) => {
  const titled = state.list.filter((m) => m.title.length > 3);
  if (!titled.length) return [text];
  const names = titled.map((m) => m.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  // "[Title]" or "(Title)" around a source loses its brackets: the button shows it is a source.
  // Small models shorten a title or add its date, so anything in brackets that is part of exactly one title counts too.
  const re = new RegExp(`[\\[(]?\\s*(${names})\\s*[\\])]?|([\\[(][^\\[\\]()]{5,90}(?:\\(\\d{4}-\\d\\d-\\d\\d\\))?[\\])])`);
  const loose = (part) => {
    const said = part.slice(1, -1).replace(/\s*\(?\d{4}-\d\d-\d\d\)?\s*$/, '').trim().toLowerCase();
    const hits = said.length > 4 ? titled.filter((x) => x.title.toLowerCase().includes(said)) : [];
    return hits.length === 1 ? hits[0] : null;
  };
  const cite = (m) => h('button.cite', { title: 'Open this meeting', onclick: () => open(m.id) }, m.title);
  return asLines(text, (line) => line.split(re).map((part, i) => {
    if (part === undefined) return '';
    // split() hands back: text, exact title, bracketed guess, text, ...
    if (i % 3 === 1) return cite(titled.find((x) => x.title === part));
    if (i % 3 === 2) return loose(part) ? cite(loose(part)) : part;
    return part;
  }));
};

async function askEverything(question) {
  question = question.trim();
  if (!question || state.asking) return;
  state.asking = { id: 'all', q: question, text: '' };
  render();
  try {
    state.allChat.push({ q: question, a: await api.meetings.askAll(state.allChat, question) });
  } catch (e) {
    toast(`Could not answer: ${e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}`);
  }
  state.asking = null;
  render();
  document.querySelector('.ask-input')?.focus();
}

// Recipes: questions worth asking again, kept as one-click chips.
const recipes = () => state.settings.recipes || [];
async function keepRecipe(q) {
  state.settings = await api.saveSettings({ recipes: [...recipes(), q] });
  toast('Saved as a recipe');
  render();
}
const qa = (q, a) => h('div.qa',
  h('p.q', q, !recipes().includes(q) && h('button.keep', { title: 'Keep this question as a one-click recipe', 'aria-label': 'Save as recipe', onclick: () => keepRecipe(q) }, icon('plus'))),
  h('p.a', a));

function askAllPage() {
  const asking = state.asking?.id === 'all' ? state.asking : null;
  const turn = qa;
  const ideas = ['What did I promise, and to whom?', 'What is still open?', 'What should I prepare for next?'];
  return h('div.doc.ask-all',
    h('h1', 'Ask your meetings'),
    h('p.lead', 'One question, every meeting. The answer is written on this computer and names the meeting each point came from.'),
    !asking && h('div.chips', [...(state.allChat.length ? [] : ideas), ...recipes()].map((q) => h('button.chip', { onclick: () => askEverything(q) }, q))),
    state.allChat.map((t) => turn(t.q, withMeetings(t.a))),
    asking && turn(asking.q, h('span', { id: 'ask-stream' }, 'Reading your meetings')),
    modelReady()
      ? h('form.ask-form', { onsubmit: (e) => { e.preventDefault(); askEverything(e.target.elements.q.value); } },
          h('input.input.ask-input', { name: 'q', placeholder: 'Ask across all your meetings', 'aria-label': 'Question', autocomplete: 'off', disabled: !!asking }),
          h('button.btn.btn-primary.btn-sm', { type: 'submit', disabled: !!asking }, 'Ask'))
      : h('p.muted', 'Download the notes model first; it also answers questions.'));
}

function askDoc(m) {
  const asking = state.asking?.id === m.id ? state.asking : null;
  const turn = qa;
  const ideas = ['What did I commit to?', 'What are they worried about?', 'Sum this up in three sentences'];
  return h('div.doc',
    !m.chat.length && !asking && h('div.ask-empty',
      h('p.muted', 'Ask anything about this meeting. The answer comes from the transcript, on this computer.'),
      h('div.chips', ideas.map((q) => h('button.chip', { onclick: () => ask(q) }, q)))),
    !asking && recipes().length > 0 && h('div.chips', recipes().map((q) => h('button.chip', { onclick: () => ask(q) }, q))),
    m.chat.map((t) => turn(t.q, withTimes(t.a))),
    asking && turn(asking.q, h('span', { id: 'ask-stream' }, 'Reading the transcript')),
    modelReady()
      ? h('form.ask-form', { onsubmit: (e) => { e.preventDefault(); ask(e.target.elements.q.value); } },
          h('input.input.ask-input', { name: 'q', placeholder: 'Ask about this meeting', 'aria-label': 'Question', autocomplete: 'off', disabled: !!asking }),
          h('button.btn.btn-primary.btn-sm', { type: 'submit', disabled: !!asking }, 'Ask'))
      : h('p.muted', 'Download the notes model first; it also answers questions.'));
}

let shown; // the view on screen, so only a change of view animates in
function render() {
  // Typing must survive a re-render triggered by a background event.
  const active = document.activeElement;
  const keep = active?.matches?.('.notepad, .title-input') ? { cls: active.className, start: active.selectionStart, end: active.selectionEnd } : null;
  $('page').replaceChildren(state.current ? meetingPage() : state.askAll ? askAllPage() : welcomePage());
  $('ask-all').classList.toggle('active', state.askAll);
  const key = state.current ? `${state.current.id} ${viewOf(state.current)}` : state.askAll ? 'ask' : 'welcome';
  $('page').classList.toggle('enter', key !== shown);
  shown = key;
  paintStatus();
  if (keep) {
    const el = document.querySelector(`.${keep.cls.split(' ')[0]}`);
    el?.focus();
    el?.setSelectionRange(keep.start, keep.end);
  }
  paintCapture();
  paintPlayer();
}

// ---------- settings ----------

function applyTheme() {
  document.documentElement.dataset.theme = state.settings.theme === 'light' ? 'light' : 'dark';
}

async function refreshWords() {
  const top = document.querySelector('.modal-body')?.scrollTop;
  state.words = await api.words.list();
  openSettings();
  if (top != null) document.querySelector('.modal-body').scrollTop = top;
}

async function setSetting(fields) {
  state.settings = await api.saveSettings(fields);
  applyTheme();
  render();
  openSettings();
}

function openSettings() {
  const inv = state.inventory;
  const chosen = chosenModel();
  const installedNames = new Set(inv.installed.map((m) => m.name));
  const others = inv.installed.filter((m) => !inv.tiers.some((t) => t.model === m.name) && !/embed/.test(m.name));

  const row = (name, meta, pills, installed) => h(`label.model${name === chosen ? '.active' : ''}`,
    h('input', { type: 'radio', name: 'model', checked: name === chosen, disabled: !installed, onchange: () => setSetting({ model: name }) }),
    h('div', h('div.model-name', name), h('div.model-meta', meta)),
    h('div.model-side', pills));

  // Muesli's own picks, largest first: the ones that fit this machine can be downloaded from here.
  const recommended = inv.tiers.map((t) => {
    const installed = installedNames.has(t.model);
    const fits = t.sizeGb * 1.2 <= inv.memory.budgetGb;
    return row(t.model, `${t.sizeGb} GB  ${t.label}`, [
      t.model === inv.suggested.model && pill('accent', 'Best fit'),
      installed && pill('', 'Installed'),
      !fits && pill('warn', 'Too big for this computer'),
      !installed && fits && (state.pull?.model === t.model
        ? h('span.small.muted', { id: 'pull-status' }, state.pull.status)
        : button('btn-ghost.btn-sm', 'Download', (e) => { e.preventDefault(); pull(t.model); openSettings(); }, null, { disabled: !!state.pull })),
    ], installed);
  });

  const models = !inv.ollamaRunning
    ? h('p.muted.m0', 'Ollama is not running. Start it, then reopen Settings.')
    : h('div',
        recommended,
        state.pull && h('div.bar', h('div.bar-fill', { id: 'pull-fill', style: `width:${state.pull.pct}%` })),
        others.length ? h('details.more-models',
          h('summary.section-label.mt', `Other models in your Ollama (${others.length})`),
          others.map((m) => row(m.name, `${m.sizeGb.toFixed(1)} GB`, [!m.fits && pill('warn', 'Too big for this computer')], true))) : null);

  const theme = state.settings.theme === 'light' ? 'light' : 'dark';
  const scrolled = document.querySelector('.modal-body')?.scrollTop || 0;
  const custom = Object.entries(state.settings.templates || {});
  const item = (title, meta, remove) => h('div.setting', h('div', title, meta && h('span.small.muted', meta)), h('button.link', { onclick: remove }, 'Remove'));
  const addTemplate = async (e) => {
    e.preventDefault();
    const name = e.target.elements.name.value.trim();
    const sections = e.target.elements.sections.value.split(',').map((x) => x.trim()).filter(Boolean);
    if (!name || !sections.length) return toast('Give the template a name and at least one heading');
    state.templates = { ...state.templates, [`custom_${Date.now()}`]: { name, sections } };
    await setSetting({ templates: { ...state.settings.templates, [`custom_${Date.now()}`]: { name, sections } } });
    state.templates = await api.templates();
    render();
  };
  const modal = h('div.scrim', { onclick: (e) => e.target === e.currentTarget && closeSettings() },
    h('div.modal', { role: 'dialog', 'aria-label': 'Settings' },
      h('div.modal-head', h('h2', 'Settings'), h('button.btn.btn-ghost.btn-sm', { onclick: closeSettings, 'aria-label': 'Close' }, icon('close'))),
      h('div.modal-body',
        h('div',
          h('div.section-label', 'Notes model'),
          h('p.small.muted', { style: 'margin:0 0 8px' }, `This machine: ${memoryLine()}. Muesli suggests the largest model that fits and can use any model already in Ollama.`),
          models),
        h('div',
          h('div.section-label', 'Recording'),
          h('div.setting',
            h('label', { for: 'language' }, 'Spoken language', h('span.small.muted', 'The language your meetings are held in')),
            h('select.input', { id: 'language', onchange: (e) => setSetting({ language: e.target.value }) },
              Object.entries(LANGUAGES).map(([code, name]) => h('option', { value: code, selected: code === (state.settings.language || 'en') }, name)))),
          api.platform === 'win32' && h('div.setting',
            h('div', 'Offer to record when a call starts', h('span.small.muted', 'A notification when Zoom, Teams or a browser opens your microphone')),
            h('div.seg-toggle',
              h(`button${state.settings.detect === false ? '.active' : ''}`, { onclick: () => setSetting({ detect: false }) }, 'Off'),
              h(`button${state.settings.detect !== false ? '.active' : ''}`, { onclick: () => setSetting({ detect: true }) }, 'On')))),
        h('div',
          h('div.section-label', 'Your words'),
          h('p.small.muted', { style: 'margin:0 0 8px' }, 'Names and terms Muesli should spell right. Add them here, or click any word in a transcript.'),
          h('form.word-add', { onsubmit: async (e) => {
            e.preventDefault();
            const value = e.target.elements.word.value;
            if (!value.trim()) return;
            await api.words.add({ term: value });
            await refreshWords();
          } },
            h('input.input', { name: 'word', placeholder: 'Add a name or term', 'aria-label': 'Add a name or term', spellcheck: 'false' }),
            h('button.btn.btn-ghost.btn-sm', { type: 'submit' }, 'Add')),
          state.words.terms.length > 0 && h('div.word-list', state.words.terms.map((term) => h('span.word', term,
            h('button', { 'aria-label': `Forget ${term}`, title: 'Forget', onclick: async () => { await api.words.remove({ term }); await refreshWords(); } }, '\u00d7')))),
          state.words.fixes.length + state.words.maybe.length > 0 && h('div.small.word-head', 'Saved fixes'),
          state.words.fixes.map((f) => h('div.setting',
            h('div.word-fix', { role: 'group', 'aria-label': `Heard ${f.heard}, writes ${f.meant}` }, h('s.muted', f.heard), h('span.muted', '\u2192'), h('span', f.meant)),
            button('btn-ghost.btn-sm', 'Forget', async () => { await api.words.remove({ heard: f.heard }); await refreshWords(); }))),
          state.words.maybe.map((f) => h('div.setting',
            h('div', h('div.word-fix', h('s.muted', f.heard), h('span.muted', '\u2192'), h('span', f.meant)), h('span.small.muted', `Only when it fits the sentence${f.yes ? ` \u00b7 used ${f.yes} ${f.yes === 1 ? 'time' : 'times'}` : ''}`)),
            button('btn-ghost.btn-sm', 'Forget', async () => { await api.words.remove({ heard: f.heard }); await refreshWords(); }))),
          h('div.small.word-head', 'Your field'),
          h('p.small.muted', { style: 'margin:0 0 4px' }, 'Switch on the vocabulary of the work you do.'),
          state.words.packs.map((p) => {
            const set = (on) => async () => { await api.words.pack(p.name, on); await refreshWords(); };
            return h('div.setting',
              h('div', p.name, h('span.small.muted', `${p.about} \u00b7 ${p.count} terms`)),
              h('div.seg-toggle', { role: 'group', 'aria-label': p.name },
                h(`button${p.on ? '' : '.active'}`, { 'aria-pressed': String(!p.on), onclick: set(false) }, 'Off'),
                h(`button${p.on ? '.active' : ''}`, { 'aria-pressed': String(!!p.on), onclick: set(true) }, 'On')));
          })),
        h('div',
          h('div.section-label', 'Voices'),
          h('p.small.muted', { style: 'margin:0 0 8px' }, 'Muesli learns voices so it can put names in the transcript by itself. Yours is learned from your microphone during calls. Anyone else is learned when you click their label in a transcript and type a name. A voice profile is a short list of numbers, not audio, and it never leaves this computer.'),
          state.voices.length
            ? state.voices.map((v) => h('div.setting',
              h('div', v.name, h('span.small.muted', v.usable ? `Learned from ${v.recordings} ${v.recordings === 1 ? 'recording' : 'recordings'}` : 'Not used: these recordings do not sound like one person. Forget and name them again.')),
              button('btn-ghost.btn-sm', 'Forget', async () => {
                await api.voices.forget(v.name);
                state.voices = await api.voices.list();
                render();
              })))
            : h('p.small.muted', { style: 'margin:0' }, 'No voices learned yet.')),
        h('div',
          h('div.section-label', 'Calendar'),
          h('p.small.muted', { style: 'margin:0 0 8px' }, 'Optional. Paste your calendar\u2019s private ICS link and Muesli shows what is coming up, names each meeting, fills in who is there and offers to record when one starts. Google Calendar: Settings, your calendar, \u201cSecret address in iCal format\u201d. Outlook: Settings, Shared calendars, Publish. Muesli only downloads the calendar; nothing is sent.'),
          h('div.actions',
            h('input.input', { type: 'url', placeholder: 'https://calendar.google.com/calendar/ical/\u2026/basic.ics', 'aria-label': 'Calendar link', value: state.settings.calendarUrl || '', onchange: async (e) => {
              await setSetting({ calendarUrl: e.target.value.trim() });
              try {
                state.upcoming = await api.upcoming();
                if (state.settings.calendarUrl) toast(state.upcoming.length ? `Calendar connected: ${state.upcoming.length} meetings this week` : 'Calendar connected. Nothing in the next 7 days.');
              } catch (err) {
                state.upcoming = [];
                toast(err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
              }
              refreshList();
            } }))),
        h('div',
          h('div.section-label', 'Templates'),
          h('p.small.muted', { style: 'margin:0 0 8px' }, 'General, 1:1, Sales call and Standup are built in. Add your own: a name and the headings the notes should use.'),
          custom.map(([key, t]) => item(t.name, t.sections.join(', '), async () => { const { [key]: _gone, ...rest } = state.settings.templates; await setSetting({ templates: rest }); state.templates = await api.templates(); render(); })),
          h('form.actions', { onsubmit: addTemplate },
            h('input.input', { name: 'name', placeholder: 'Name, e.g. Interview', 'aria-label': 'Template name', style: 'flex:1' }),
            h('input.input', { name: 'sections', placeholder: 'Headings, separated by commas', 'aria-label': 'Headings', style: 'flex:2' }),
            h('button.btn.btn-ghost.btn-sm', { type: 'submit' }, 'Add'))),
        recipes().length > 0 && h('div',
          h('div.section-label', 'Recipes'),
          recipes().map((q) => item(q, '', () => setSetting({ recipes: recipes().filter((x) => x !== q) })))),
        h('div',
          h('div.section-label', 'Appearance'),
          h('div.seg-toggle',
            h(`button${theme === 'dark' ? '.active' : ''}`, { onclick: () => setSetting({ theme: 'dark' }) }, 'Dark'),
            h(`button${theme === 'light' ? '.active' : ''}`, { onclick: () => setSetting({ theme: 'light' }) }, 'Light'))),
        h('div',
          h('div.section-label', 'Automation'),
          h('p.small.muted', { style: 'margin:0 0 8px' }, 'Optional. When notes are finished, Muesli posts them as JSON to this address, so n8n, Make, Zapier or your own script can take it from there. Leave it empty and nothing ever leaves this computer.'),
          h('div.actions',
            h('input.input', { type: 'url', placeholder: 'https://your-webhook-address', 'aria-label': 'Webhook address', value: state.settings.webhookUrl || '', onchange: (e) => setSetting({ webhookUrl: e.target.value.trim() }) }),
            button('btn-ghost.btn-sm', 'Send a test', testWebhook, null, { disabled: !state.settings.webhookUrl, title: 'Posts the sample meeting to the address' }))),
        h('div',
          h('div.section-label', 'Assistants'),
          h('p.small.muted', { style: 'margin:0 0 8px' }, 'Optional. Lets Claude and other assistants on this computer read your meetings through MCP, so you can ask across all of them. Read-only, and never reachable from outside this computer.'),
          h('div.actions',
            h('div.seg-toggle',
              h(`button${!state.settings.mcp ? '.active' : ''}`, { onclick: () => setSetting({ mcp: false }) }, 'Off'),
              h(`button${state.settings.mcp ? '.active' : ''}`, { onclick: () => setSetting({ mcp: true }) }, 'On')),
            state.settings.mcp && h('code', MCP_URL),
            state.settings.mcp && h('button.link', { title: 'Copies the command that adds Muesli to Claude Code', onclick: () => copy(`claude mcp add --transport http muesli ${MCP_URL}`, 'Command') }, icon('copy'), 'Copy setup command'))),
        h('div',
          h('div.section-label', 'Your data'),
          h('p.small.muted', { style: 'margin:0 0 8px' }, 'Every meeting is a folder of plain files: audio, transcript and notes in Markdown. Nothing is sent anywhere unless you add a webhook above. Keep the folder on a shared drive and a team can use the same meetings.'),
          h('div.actions',
            button('btn-ghost.btn-sm', 'Open the Muesli folder', () => api.meetings.reveal(''), 'folder'),
            button('btn-ghost.btn-sm', 'Keep meetings somewhere else', async () => {
              const next = await api.chooseRoot();
              if (!next) return;
              state.settings = next;
              await open(null);
              toast(`Meetings now live in ${next.root}`);
            }))))));
  $('modal-root').replaceChildren(modal);
  document.querySelector('.modal-body').scrollTop = scrolled;
}
async function testWebhook() {
  const m = state.current?.result ? state.current : state.list.find((x) => x.title.startsWith('Sample')) || state.list[0];
  if (!m) return toast('Record a meeting first');
  try {
    await api.meetings.send(m.id);
    toast(`Sent "${m.title}" to your webhook`);
  } catch (e) {
    toast(`Webhook failed: ${e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}`);
  }
}
const LANGUAGES = { en: 'English', auto: 'Detect automatically', es: 'Spanish', fr: 'French', de: 'German', pt: 'Portuguese', it: 'Italian', nl: 'Dutch', pl: 'Polish', tr: 'Turkish', ar: 'Arabic', hi: 'Hindi', zh: 'Chinese', ja: 'Japanese', ko: 'Korean' };
const MCP_URL = 'http://127.0.0.1:3939/mcp';
const closeSettings = () => $('modal-root').replaceChildren();

// ---------- start ----------

const mac = api.platform === 'darwin';
document.documentElement.classList.toggle('mac', mac);
document.querySelectorAll('[data-keys]').forEach((el) => (el.textContent = mac ? `\u2318${el.dataset.keys}` : `Ctrl ${el.dataset.keys}`));
$('new').onclick = () => newMeeting();
$('ask-all').onclick = async () => {
  await open(null);
  state.askAll = true;
  render();
  document.querySelector('.ask-input')?.focus();
};
$('open-settings').onclick = async () => {
  await refreshInventory();
  openSettings();
};
let searchTimer;
$('search').oninput = (e) => {
  state.query = e.target.value.trim();
  clearTimeout(searchTimer);
  searchTimer = setTimeout(refreshList, 150);
};
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeSettings();
  if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
  if (e.key === 'n') newMeeting();
  if (e.key === 'k') $('search').focus();
});
api.onTray?.((action) => {
  if (action === 'new') newMeeting();
  if (action === 'record' && !state.rec) newMeeting().then(guardless(startRecording));
  if (action.startsWith('event:') && !state.rec) newMeeting(JSON.parse(action.slice(6))).then(guardless(startRecording));
  if (action.startsWith('heard:') && !state.rec) toast(`${action.slice(6)} is using your microphone. Press Record to capture the call.`);
});

(async () => {
  [state.settings, state.templates] = await Promise.all([api.settings(), api.templates()]);
  applyTheme();
  await refreshList();
  render();
  await refreshInventory();
  render();
  if (state.list.length) open(state.list[0].id);
  refreshUpcoming();
  setInterval(refreshUpcoming, 5 * 60000);
  // While Ollama is missing, look for it every few seconds, so installing it is the only step.
  setInterval(async () => {
    if (state.inventory?.ollamaRunning || document.hidden) return;
    await refreshInventory();
    if (state.inventory.ollamaRunning) {
      render();
      toast('Ollama found');
    }
  }, 4000);
  state.words = await api.words.list();
  state.voices = await api.voices.list();

  // Self-test: record while main plays a clip through the speakers, then report what was heard.
  if (api.autotest) {
    try {
      await newMeeting();
      await startRecording();
      await api.autotestPlay();
      await new Promise((r) => setTimeout(r, 1000));
      const id = state.rec.meetingId;
      const livePreview = state.live?.segments;
      await stopRecording();
      const m = await api.meetings.get(id);
      api.autotestDone(JSON.stringify({ livePreview, durationSec: m.durationSec, transcript: m.transcript, notes: m.result?.notes, error: state.busy[id]?.error }, null, 2));
    } catch (e) {
      api.autotestDone(`ERROR ${e.stack}`);
    }
  }
})();
