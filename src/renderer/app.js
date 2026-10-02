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
  el.append(...kids.flat().filter((k) => k != null && k !== false));
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
const fmtDate = (iso) => new Date(iso).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
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
  tab: 'notes',
  rec: null, // { meetingId, ctx, streams, startedAt, peaks, timer }
  busy: {}, // meetingId -> { lines: [], error }
  inventory: null,
  settings: {},
  templates: {},
  pull: null, // { model, pct, status }
};

// ---------- sidebar ----------

async function refreshList() {
  state.list = state.query ? await api.meetings.search(state.query) : await api.meetings.list();
  $('list').replaceChildren(
    ...(state.list.length
      ? state.list.map((m) =>
          h(`button.row${state.current?.id === m.id ? '.active' : ''}`, { onclick: () => open(m.id) },
            h('span.row-title', m.title || 'Untitled meeting'),
            h('span.row-date', `${fmtDate(m.createdAt)}${state.rec?.meetingId === m.id ? '  recording' : ''}`)))
      : [h('div.list-empty', state.query ? 'No meetings match.' : 'No meetings yet.')]),
  );
}

async function open(id, tab = 'notes') {
  stopPlayback();
  state.current = id ? await api.meetings.get(id) : null;
  state.tab = tab;
  if (state.current) {
    $('audio-me').src = `muesli-audio://${id}/me.wav`;
    $('audio-them').src = `muesli-audio://${id}/them.wav`;
  }
  render();
  refreshList();
}

async function newMeeting() {
  const m = await api.meetings.create({ template: state.settings.template || 'general' });
  await open(m.id);
  document.querySelector('.notepad')?.focus();
}

// ---------- recording ----------

function tap(ctx, stream, meetingId, track) {
  const node = new AudioWorkletNode(ctx, 'pcm-worklet');
  node.port.onmessage = ({ data }) => {
    api.sendChunk(meetingId, track, data.pcm);
    if (!state.rec) return;
    state.rec.peaks[track] = data.peak;
    if (data.peak > 0.01) state.rec.heard[track] = Date.now();
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
  state.rec = { meetingId, ctx, streams: [mic, display], startedAt: Date.now(), peaks: { me: 0, them: 0 }, heard: { me: 0, them: 0 } };
  tap(ctx, mic, meetingId, 'me');
  tap(ctx, system, meetingId, 'them');
  state.rec.timer = setInterval(paintCapture, 500);
  render();
  refreshList();
}

async function stopRecording() {
  const { meetingId, ctx, streams, timer } = state.rec;
  clearInterval(timer);
  state.rec = null;
  streams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
  await ctx.close();
  await api.stopRecording(meetingId);
  await process(meetingId, true);
}

function paintCapture() {
  const rec = state.rec;
  if (!rec || state.current?.id !== rec.meetingId) return;
  const el = $('clock');
  if (!el) return;
  el.textContent = clock((Date.now() - rec.startedAt) / 1000);
  for (const track of ['me', 'them']) {
    $(`fill-${track}`).style.width = `${Math.min(100, Math.sqrt(rec.peaks[track]) * 100)}%`;
    const quiet = Date.now() - Math.max(rec.heard[track], rec.startedAt) > 8000;
    const p = $(`health-${track}`);
    p.className = `pill ${quiet ? 'pill-warn' : rec.heard[track] ? 'pill-accent' : ''}`;
    p.textContent = quiet ? 'Nothing heard yet' : rec.heard[track] ? 'Hearing audio' : 'Listening';
  }
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
    if (modelReady()) await api.meetings.generate(id);
    delete state.busy[id];
  } catch (e) {
    busy.error = e.message;
  }
  if (state.current?.id === id) state.current = await api.meetings.get(id);
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
  const log = $('progress-log');
  if (log) {
    log.textContent = busy.lines.map((l) => `${l.step}${l.chars ? `  ${l.chars} characters` : ''}`).join('\n');
    log.scrollTop = log.scrollHeight;
  }
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
  btn.replaceChildren(icon(a.paused ? 'play' : 'pause'), a.paused ? 'Play' : 'Pause');
  $('scrub').max = a.duration || state.current?.durationSec || 0;
  $('scrub').value = a.currentTime;
  $('play-time').textContent = `${clock(a.currentTime)} / ${clock(a.duration || state.current?.durationSec || 0)}`;
  const ms = a.currentTime * 1000;
  if (!a.paused) document.querySelectorAll('.seg').forEach((el) => el.classList.toggle('hit', ms >= +el.dataset.from && ms < +el.dataset.to));
}
['timeupdate', 'pause', 'play', 'loadedmetadata'].forEach((ev) => $('audio-me').addEventListener(ev, paintPlayer));

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
  const inv = state.inventory;
  return h('div.welcome',
    h('h1', 'Meeting notes that never leave this computer'),
    h('p.lead', 'Muesli records both sides of a call, transcribes it and writes the notes with models running on your own machine. No bot joins the meeting, there is no account, and nothing is uploaded.'),
    h('div.facts',
      h('div.card.fact', h('div.card-body', h('h2', 'Record'), h('p', 'Your microphone and the call audio are captured as two tracks, so Muesli knows who said what.'))),
      h('div.card.fact', h('div.card-body', h('h2', 'Jot'), h('p', 'Type rough notes while you talk. They steer what the finished notes focus on.'))),
      h('div.card.fact', h('div.card-body', h('h2', 'Enhance'), h('p', 'A local model turns your jottings and the transcript into notes, action items and a follow-up email.')))),
    h('div', { style: 'margin-top:18px' }, button('btn-primary', 'New meeting', newMeeting, 'plus')),
    inv && !modelReady() ? h('div', { style: 'margin-top:14px' }, setupCard()) : null);
}

// Shown wherever notes can't be written yet: Ollama missing, or no model downloaded.
function setupCard() {
  const inv = state.inventory;
  const s = inv.suggested;
  const body = !inv.ollamaRunning
    ? [
        h('p', 'Muesli writes notes with a model that runs on this computer through Ollama, a free model runner. Recording and transcription already work without it.'),
        h('ol.steps', h('li', 'Install Ollama and start it.'), h('li', 'Come back here and press Check again.')),
        h('div.actions', button('btn-primary', 'Get Ollama', () => api.openExternal('https://ollama.com/download')), button('btn-ghost', 'Check again', recheck)),
      ]
    : [
        h('p', `Ollama is running. The best fit for this machine (${memoryLine()}) is `, h('code', s.model), `, a ${s.sizeGb} GB download. You can also pick a model you already have in Settings.`),
        state.pull
          ? h('div', h('div.small.muted', { id: 'pull-status' }, state.pull.status), h('div.bar', h('div.bar-fill', { id: 'pull-fill', style: `width:${state.pull.pct}%` })))
          : h('div.actions', button('btn-primary', `Download ${s.model}`, () => pull(s.model)), button('btn-ghost', 'Choose another model', openSettings)),
      ];
  return h('div.card', h('div.card-head', h('h2', 'Set up the notes model'), pill('warn', 'One-time setup')), h('div.card-body.empty', body));
}

const memoryLine = () => {
  const m = state.inventory.memory;
  const gb = `${Math.round(m.totalGb)} GB`;
  return m.kind === 'vram' ? `${m.gpu}, ${gb} VRAM` : m.kind === 'unified' ? `${gb} unified memory` : `${gb} RAM, no dedicated GPU`;
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

function meetingPage() {
  const m = state.current;
  const recordingHere = state.rec?.meetingId === m.id;
  const busy = state.busy[m.id];
  const hasAudio = m.durationSec > 0;
  const hasTranscript = m.transcript.length > 0;

  const recordBtn = recordingHere
    ? button('btn-recording', 'Stop recording', guard(stopRecording), 'stop')
    : button('btn-primary', hasAudio ? 'Record again' : 'Record', guard(startRecording), 'mic', { disabled: !!state.rec || !!busy });
  const enhanceBtn = button('btn-ai', m.result ? 'Rewrite notes' : 'Enhance notes', () => process(m.id, false), 'spark',
    { disabled: !hasTranscript || !!busy || recordingHere || !modelReady(), title: hasTranscript ? '' : 'Record a meeting first' });

  const head = h('div.page-head',
    h('div.page-head-text',
      h('input.title-input', { value: m.title, placeholder: 'Untitled meeting', 'aria-label': 'Meeting title', oninput: (e) => saveSoon({ title: e.target.value }) }),
      h('div.sub',
        h('span.mono', fmtDate(m.createdAt)),
        hasAudio && h('span.mono', fmtDuration(m.durationSec)),
        h('select.input', { 'aria-label': 'Notes template', style: 'padding-top:.2rem;padding-bottom:.2rem;font-size:13px', onchange: (e) => { saveSoon({ template: e.target.value }); api.saveSettings({ template: e.target.value }); } },
          Object.entries(state.templates).map(([key, t]) => h('option', { value: key, selected: key === m.template }, `${t.name} notes`))),
        pill('accent', 'Stored on this computer'))),
    h('div.actions', enhanceBtn, recordBtn));

  const tabs = h('div.tabs',
    h(`button.tab${state.tab === 'notes' ? '.active' : ''}`, { onclick: () => { state.tab = 'notes'; render(); } }, 'Notes'),
    h(`button.tab${state.tab === 'transcript' ? '.active' : ''}`, { onclick: () => { state.tab = 'transcript'; render(); } }, 'Transcript', hasTranscript && h('span.count', String(m.transcript.length))));

  return h('div', head, tabs, state.tab === 'notes' ? notesTab(m, recordingHere, busy, hasTranscript) : transcriptTab(m, hasAudio));
}

// A failed start or stop must never leave the buttons dead.
const guard = (fn) => async (e) => {
  e.currentTarget.disabled = true;
  try {
    await fn();
  } catch (err) {
    toast(err.message);
    render();
  }
};

function notesTab(m, recordingHere, busy, hasTranscript) {
  const cards = [];

  if (recordingHere) {
    const level = (track, label) => h('div',
      h('div.level-top', h('span', label), h('span.pill', { id: `health-${track}` }, 'Listening')),
      h('div.meter', h(`div.meter-fill${track === 'them' ? '.them' : ''}`, { id: `fill-${track}` })));
    cards.push(h('div.card', h('div.card-body', h('div.capture', h('div.clock', { id: 'clock' }, '00:00'), level('me', 'You (microphone)'), level('them', 'Them (computer audio)')))));
  }

  if (busy) {
    cards.push(h('div.card',
      h('div.card-head', h('h2', busy.error ? 'Something went wrong' : 'Working on your notes'), busy.error ? pill('danger', 'Error') : pill('warn', 'Working')),
      h('div.card-body',
        h('pre.log', { id: 'progress-log' }, busy.error ? busy.error : busy.lines.map((l) => l.step).join('\n') || 'Starting'),
        busy.error && h('div.actions', { style: 'margin-top:12px' }, button('btn-ghost', 'Dismiss', () => { delete state.busy[m.id]; render(); })))));
  }

  cards.push(h('div.card',
    h('div.card-head', h('h2', 'Your notes'), h('span.small.muted', m.result ? 'Kept as you wrote them' : 'Jot while you talk. Muesli fills in the rest.')),
    h('div.card-body', h('textarea.notepad', { placeholder: 'Type anything worth remembering: names, numbers, what to follow up on.', oninput: (e) => saveSoon({ userNotes: e.target.value }) }, m.userNotes))));

  if (m.result) cards.push(...resultCards(m));
  else if (hasTranscript && !busy && !modelReady() && state.inventory) cards.push(setupCard());

  return h('div.stack', cards);
}

function resultCards(m) {
  const r = m.result;
  const sections = r.notes.sections.filter((s) => s.bullets.length);
  const notes = h('div.card',
    h('div.card-head',
      h('h2', 'Enhanced notes'),
      h('div.card-head-side',
        h('span.legend', h('span.dot.mine'), 'From your notes'),
        h('span.legend', h('span.dot'), 'Added from the transcript'),
        button('btn-ghost.btn-sm', 'Copy', () => copy(markdown(m), 'Notes'), 'copy'))),
    h('div.card-body.notes', sections.map((s) => [
      h('h3', s.heading),
      h('ul.bullets', s.bullets.map((b) => h('li',
        h(`span.dot${b.from_my_notes ? '.mine' : ''}`, { title: b.from_my_notes ? 'From your notes' : 'Added from the transcript' }),
        h('span', b.text),
        /^\d+:\d\d$/.test(b.timestamp) ? h('button.ts', { title: 'Show this moment in the transcript', onclick: () => jumpTo(b.timestamp) }, b.timestamp) : h('span')))),
    ]),
    h('div.small.muted', { style: 'margin-top:14px' }, `Written on this computer by ${r.model}`)));

  const saveResult = () => api.meetings.saveResult(m.id, r);
  const actions = r.actions.length && h('div.card',
    h('div.card-head', h('h2', 'Action items'), pill('ai', `${r.actions.filter((a) => !a.done).length} open`)),
    h('div.card-body', r.actions.map((a) => h(`label.todo${a.done ? '.done' : ''}`,
      h('input', { type: 'checkbox', checked: !!a.done, onchange: (e) => { a.done = e.target.checked; saveResult(); render(); } }),
      h('span.todo-task', a.task),
      h('span.todo-meta', pill(a.owner === 'Me' ? 'accent' : 'teal', a.owner === 'Me' ? 'You' : a.owner), a.due && pill('warn', a.due))))));

  const email = r.email && h('div.card',
    h('div.card-head', h('h2', 'Follow-up email'), h('div.card-head-side', pill('ai', 'Draft'), button('btn-ghost.btn-sm', 'Copy', () => copy(r.email, 'Email'), 'copy'))),
    h('div.card-body', h('pre.email', r.email)));

  return [notes, actions, email].filter(Boolean);
}

function markdown(m) {
  const r = m.result;
  const out = [`# ${m.title || r.notes.title || 'Meeting'}`, ''];
  for (const s of r.notes.sections) if (s.bullets.length) out.push(`## ${s.heading}`, ...s.bullets.map((b) => `- ${b.text}`), '');
  if (r.actions.length) out.push('## Action items', ...r.actions.map((a) => `- [${a.done ? 'x' : ' '}] ${a.task} (${a.owner}${a.due ? `, due ${a.due}` : ''})`), '');
  return out.join('\n');
}

function transcriptTab(m, hasAudio) {
  if (!m.transcript.length) {
    return h('div.card', h('div.card-body.empty', h('p', { style: 'margin:0' }, 'The transcript appears here after you record. Each line is labelled You or Them and links back to the audio.')));
  }
  const text = m.transcript.map((s) => `[${clock(s.from / 1000)}] ${s.speaker === 'Me' ? 'You' : 'Them'}: ${s.text}`).join('\n');
  return h('div.stack',
    hasAudio && h('div.card', h('div.card-body.player',
      button('btn-ghost.btn-sm', 'Play', togglePlay, 'play', { id: 'play' }),
      h('input', { type: 'range', id: 'scrub', min: 0, max: m.durationSec, step: 0.1, value: 0, 'aria-label': 'Position', oninput: (e) => seek(+e.target.value, false) }),
      h('span.mono', { id: 'play-time' }, `00:00 / ${clock(m.durationSec)}`))),
    h('div.card',
      h('div.card-head', h('h2', 'Transcript'),
        h('div.card-head-side', button('btn-ghost.btn-sm', 'Copy', () => copy(text, 'Transcript'), 'copy'), button('btn-ghost.btn-sm', 'Open folder', () => api.meetings.reveal(m.id), 'folder'))),
      h('div.card-body', m.transcript.map((s) => h('div.seg', { 'data-from': s.from, 'data-to': s.to ?? s.from + 1 },
        h('button.ts', { disabled: !hasAudio, onclick: () => seek(s.from / 1000) }, clock(s.from / 1000)),
        h('span', pill(s.speaker === 'Me' ? 'accent' : 'teal', s.speaker === 'Me' ? 'You' : 'Them')),
        h('span.seg-text', s.text))))),
    h('div', button('btn-danger.btn-sm', 'Move meeting to the bin', async () => { await api.meetings.remove(m.id); await open(null); }, 'trash')));
}

function render() {
  // Typing must survive a re-render triggered by a background event.
  const active = document.activeElement;
  const keep = active?.matches?.('.notepad, .title-input') ? { cls: active.className, start: active.selectionStart, end: active.selectionEnd } : null;
  $('page').replaceChildren(state.current ? meetingPage() : welcomePage());
  if (keep) {
    const el = document.querySelector(`.${keep.cls.split(' ')[0]}`);
    el?.focus();
    el?.setSelectionRange(keep.start, keep.end);
  }
  paintCapture();
  paintPlayer();
  const log = $('progress-log');
  if (log) log.scrollTop = log.scrollHeight;
}

// ---------- settings ----------

function applyTheme() {
  document.documentElement.dataset.theme = state.settings.theme === 'light' ? 'light' : 'dark';
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
  const others = inv.installed.filter((m) => !inv.tiers.some((t) => t.model === m.name));

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
      !fits && pill('warn', 'Needs more memory'),
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
        others.length ? h('div.section-label.mt', 'Other models in your Ollama') : null,
        others.map((m) => row(m.name, `${m.sizeGb.toFixed(1)} GB  ${m.params}  ${m.quant}`, [!m.fits && pill('warn', 'Larger than your memory')], true)));

  const theme = state.settings.theme === 'light' ? 'light' : 'dark';
  const modal = h('div.scrim', { onclick: (e) => e.target === e.currentTarget && closeSettings() },
    h('div.modal', { role: 'dialog', 'aria-label': 'Settings' },
      h('div.modal-head', h('h2', 'Settings'), h('button.btn.btn-ghost.btn-sm', { onclick: closeSettings, 'aria-label': 'Close' }, icon('close'))),
      h('div.modal-body',
        h('div',
          h('div.section-label', 'Notes model'),
          h('p.small.muted', { style: 'margin:0 0 8px' }, `This machine: ${memoryLine()}. Muesli suggests the largest model that fits and can use any model already in Ollama.`),
          models),
        h('div',
          h('div.section-label', 'Appearance'),
          h('div.seg-toggle',
            h(`button${theme === 'dark' ? '.active' : ''}`, { onclick: () => setSetting({ theme: 'dark' }) }, 'Dark'),
            h(`button${theme === 'light' ? '.active' : ''}`, { onclick: () => setSetting({ theme: 'light' }) }, 'Light'))),
        h('div',
          h('div.section-label', 'Your data'),
          h('p.small.muted', { style: 'margin:0 0 8px' }, 'Every meeting is a folder of plain files: audio, transcript and notes in Markdown. Nothing is sent anywhere.'),
          button('btn-ghost.btn-sm', 'Open the Muesli folder', () => api.meetings.reveal(''), 'folder')))));
  $('modal-root').replaceChildren(modal);
}
const closeSettings = () => $('modal-root').replaceChildren();

// ---------- start ----------

$('new').onclick = newMeeting;
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
});
api.onTray?.((action) => {
  if (action === 'new') newMeeting();
});

(async () => {
  [state.settings, state.templates] = await Promise.all([api.settings(), api.templates()]);
  applyTheme();
  await refreshList();
  render();
  await refreshInventory();
  render();
  if (state.list.length) open(state.list[0].id);

  // Self-test: record while main plays a clip through the speakers, then report what was heard.
  if (api.autotest) {
    try {
      await newMeeting();
      await startRecording();
      await api.autotestPlay();
      await new Promise((r) => setTimeout(r, 1000));
      const id = state.rec.meetingId;
      await stopRecording();
      const m = await api.meetings.get(id);
      api.autotestDone(JSON.stringify({ durationSec: m.durationSec, transcript: m.transcript, notes: m.result?.notes, error: state.busy[id]?.error }, null, 2));
    } catch (e) {
      api.autotestDone(`ERROR ${e.stack}`);
    }
  }
})();
