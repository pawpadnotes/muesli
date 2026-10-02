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
  tab: 'mine', // 'mine' | 'enhanced' | 'transcript'
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
            h('span.row-date', fmtDate(m.createdAt), state.rec?.meetingId === m.id && h('span.row-rec', 'Recording'))))
      : [h('div.list-empty', state.query ? 'No meetings match.' : 'No meetings yet.')]),
  );
}

async function open(id) {
  stopPlayback();
  state.current = id ? await api.meetings.get(id) : null;
  state.tab = state.current?.result ? 'enhanced' : 'mine';
  if (state.current) {
    $('audio-me').src = `muesli-audio://meeting/${id}/me.wav`;
    $('audio-them').src = `muesli-audio://meeting/${id}/them.wav`;
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
  for (const track of ['me', 'them']) $(`fill-${track}`).style.width = `${Math.min(100, Math.sqrt(rec.peaks[track]) * 100)}%`;
  const quiet = (track) => Date.now() - Math.max(rec.heard[track], rec.startedAt) > 8000;
  const note = quiet('me') && quiet('them') ? 'Can\u2019t hear either side' : quiet('me') ? 'Can\u2019t hear your microphone' : quiet('them') ? 'Can\u2019t hear the other side' : '';
  $('health').textContent = note;
  $('health').hidden = !note;
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
  const how = (name, text) => h('div.how', h('h2', name), h('p', text));
  return h('div.welcome',
    h('h1', 'Meeting notes that never leave this computer'),
    h('p.lead', 'Muesli records both sides of a call, transcribes it and writes the notes on your own machine. No bot joins the meeting, there is no account, and nothing is uploaded.'),
    how('Record', 'Your microphone and the call audio are captured separately, so Muesli knows who said what.'),
    how('Jot', 'Type rough notes while you talk. They steer what the finished notes focus on.'),
    how('Enhance', 'Your jottings and the transcript become notes, action items and a follow-up email.'),
    needsSetup ? setupCard() : h('div.mt', button('btn-primary', 'New meeting', newMeeting, 'plus')));
}

// Shown wherever notes can't be written yet: Ollama missing, or no model downloaded.
function setupCard() {
  const inv = state.inventory;
  const s = inv.suggested;
  const body = !inv.ollamaRunning
    ? [
        h('p', 'Recording and transcription already work, so you can start a meeting now. To write the notes, Muesli uses Ollama, a free app that runs AI models on your own computer.'),
        h('ol.steps', h('li', 'Install Ollama and open it.'), h('li', 'Come back here and press Check again.')),
        h('div.actions', button('btn-primary', 'Get Ollama', () => api.openExternal('https://ollama.com/download')), h('button.link', { onclick: recheck }, 'Check again')),
      ]
    : [
        h('p', 'Recording and transcription already work, so you can start a meeting now. To write the notes, Muesli needs an AI model on this computer. It picked ', h('code', s.model), `, the best one that fits this machine (${memoryLine()}). It is a ${s.sizeGb} GB download and only happens once.`),
        state.pull
          ? h('div', h('div.small.muted', { id: 'pull-status' }, state.pull.status), h('div.bar', h('div.bar-fill', { id: 'pull-fill', style: `width:${state.pull.pct}%` })))
          : h('div.actions', button('btn-primary', 'Download the notes model', () => pull(s.model)), h('button.link', { onclick: newMeeting }, 'Start a meeting first'), h('button.link', { onclick: openSettings }, 'Choose another model')),
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
        h('button.icon-btn', { title: 'Open this meeting’s folder', 'aria-label': 'Open folder', onclick: () => api.meetings.reveal(m.id) }, icon('folder')),
        h('button.icon-btn.danger', { title: 'Move meeting to the bin', 'aria-label': 'Move meeting to the bin', onclick: async () => { await api.meetings.remove(m.id); await open(null); } }, icon('trash')))),
    h('div.sub',
      h('span', fmtDate(m.createdAt)),
      hasAudio && h('span', fmtDuration(m.durationSec)),
      !recordingHere && h('select.meta-select', { 'aria-label': 'Notes template', onchange: (e) => { saveSoon({ template: e.target.value }); api.saveSettings({ template: e.target.value }); } },
        Object.entries(state.templates).map(([key, t]) => h('option', { value: key, selected: key === m.template }, `${t.name} notes`))),
      h('span', 'Stored on this computer'),
      view === 'enhanced' && h('span.legend', h('span.dot.mine'), 'From your notes')));

  const body = view === 'transcript' ? transcriptDoc(m, hasAudio) : view === 'enhanced' ? enhancedDoc(m) : mineDoc(m);
  const setup = !m.result && !busy && !recordingHere && m.transcript.length && state.inventory && !modelReady() ? setupCard() : null;
  return h('div.meeting', head, busy?.error && errorCard(m, busy), body, setup, h('div.dock-fade'), dock(m, recordingHere, busy, view));
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

const errorCard = (m, busy) => h('div.card.mt',
  h('div.card-head', h('h2', 'Something went wrong'), pill('danger', 'Error')),
  h('div.card-body', h('pre.log', busy.error), h('div.actions.mt', button('btn-ghost', 'Dismiss', () => { delete state.busy[m.id]; render(); }))));

// The one floating control: what is happening now, and the switch between the views of a meeting.
function dock(m, recordingHere, busy, view) {
  if (recordingHere) {
    const level = (track, label) => h('span.dock-level', { title: track === 'me' ? 'Your microphone' : 'Computer audio' }, h('span.dock-label', label), h('span.dock-meter', h('span.meter-fill', { id: `fill-${track}` })));
    return h('div.dock',
      h('span.rec-dot'),
      h('span.dock-clock', { id: 'clock' }, '00:00'),
      level('me', 'You'), level('them', 'Them'),
      h('span.dock-note.warn', { id: 'health', hidden: true }),
      button('btn-recording.btn-sm', 'Stop', guard(stopRecording), 'stop'));
  }
  if (busy && !busy.error) {
    return h('div.dock', h('span.dock-busy'), h('span.dock-note', { id: 'progress-log' }, busy.lines[busy.lines.length - 1]?.step || 'Starting'));
  }
  const tab = (key, label, enabled = true) => h(`button${view === key ? '.active' : ''}`, { disabled: !enabled, onclick: () => { state.tab = key; render(); } }, label);
  const hasTranscript = m.transcript.length > 0;
  // One solid button at most: Record until there is a transcript, then Enhance until there are notes.
  const next = !hasTranscript
    ? h('button.btn.btn-primary.btn-sm', { onclick: guard(startRecording), disabled: !!state.rec }, icon('mic'), 'Record')
    : !m.result && modelReady() && h('button.btn.btn-primary.btn-sm', { onclick: () => process(m.id, false) }, icon('spark'), 'Enhance');
  if (!hasTranscript && !m.result) return h('div.dock', next);
  return h('div.dock', h('div.dock-tabs', tab('mine', 'My notes'), tab('enhanced', 'Enhanced', !!m.result), tab('transcript', 'Transcript', hasTranscript)), next);
}

const mineDoc = (m) => h('div.doc',
  h('textarea.notepad', { placeholder: 'Jot anything worth remembering while you talk: names, numbers, what to follow up on. Muesli fills in the rest from the transcript.', oninput: (e) => saveSoon({ userNotes: e.target.value }) }, m.userNotes));

function enhancedDoc(m) {
  const r = m.result;
  const saveResult = () => api.meetings.saveResult(m.id, r);
  const sections = r.notes.sections.filter((s) => s.bullets.length);
  return h('div.doc',
    sections.map((s) => h('section',
      h('h3', s.heading),
      h('ul.bullets', s.bullets.map((b) => h('li',
        h(`span.dot${b.from_my_notes ? '.mine' : ''}`, { title: b.from_my_notes ? 'From your notes' : 'Added from the transcript' }),
        h('span', b.text, /^\d+:\d\d$/.test(b.timestamp) && h('button.ts', { title: 'Show this moment in the transcript', onclick: () => jumpTo(b.timestamp) }, b.timestamp))))))),
    r.actions.length && h('section',
      h('h3', 'Action items'),
      r.actions.map((a) => h(`label.todo${a.done ? '.done' : ''}`,
        h('input', { type: 'checkbox', checked: !!a.done, onchange: (e) => { a.done = e.target.checked; saveResult(); render(); } }),
        h('span.todo-task', a.task),
        h('span.todo-meta', [a.owner === 'Me' ? 'You' : a.owner, a.due].filter(Boolean).join(' · '))))),
    r.email && h('section',
      h('div.section-head', h('h3', 'Follow-up email'), h('button.link', { onclick: () => copy(r.email, 'Email') }, icon('copy'), 'Copy email')),
      h('pre.email', r.email)),
    h('div.doc-foot',
      h('span', `Written on this computer by ${r.model}`),
      h('span.grow'),
      h('button.link', { onclick: () => copy(markdown(m), 'Notes') }, icon('copy'), 'Copy notes')));
}

function markdown(m) {
  const r = m.result;
  const out = [`# ${m.title || r.notes.title || 'Meeting'}`, ''];
  for (const s of r.notes.sections) if (s.bullets.length) out.push(`## ${s.heading}`, ...s.bullets.map((b) => `- ${b.text}`), '');
  if (r.actions.length) out.push('## Action items', ...r.actions.map((a) => `- [${a.done ? 'x' : ' '}] ${a.task} (${a.owner}${a.due ? `, due ${a.due}` : ''})`), '');
  return out.join('\n');
}

function transcriptDoc(m, hasAudio) {
  const text = m.transcript.map((s) => `[${clock(s.from / 1000)}] ${s.speaker === 'Me' ? 'You' : 'Them'}: ${s.text}`).join('\n');
  return h('div.doc',
    hasAudio && h('div.player',
      h('button.icon-btn', { id: 'play', 'aria-label': 'Play', onclick: togglePlay }, icon('play')),
      h('input', { type: 'range', id: 'scrub', min: 0, max: m.durationSec, step: 0.1, value: 0, 'aria-label': 'Position', oninput: (e) => seek(+e.target.value, false) }),
      h('span.mono', { id: 'play-time' }, `00:00 / ${clock(m.durationSec)}`)),
    m.transcript.map((s) => h('div.seg', { 'data-from': s.from, 'data-to': s.to ?? s.from + 1 },
      h('button.ts', { disabled: !hasAudio, onclick: () => seek(s.from / 1000) }, clock(s.from / 1000)),
      h(`span.who${s.speaker === 'Me' ? '.me' : ''}`, s.speaker === 'Me' ? 'You' : 'Them'),
      h('span.seg-text', s.text))),
    h('div.doc-foot', h('span', `${m.transcript.length} lines, transcribed on this computer`), h('span.grow'), h('button.link', { onclick: () => copy(text, 'Transcript') }, icon('copy'), 'Copy transcript')));
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
          h('div.section-label', 'Automation'),
          h('p.small.muted', { style: 'margin:0 0 8px' }, 'Optional. When notes are finished, Muesli posts them as JSON to this address, so n8n, Make, Zapier or your own script can take it from there. Leave it empty and nothing ever leaves this computer.'),
          h('div.actions',
            h('input.input', { type: 'url', placeholder: 'https://your-webhook-address', 'aria-label': 'Webhook address', value: state.settings.webhookUrl || '', onchange: (e) => setSetting({ webhookUrl: e.target.value.trim() }) }),
            button('btn-ghost.btn-sm', 'Send a test', testWebhook, null, { disabled: !state.settings.webhookUrl, title: 'Posts the sample meeting to the address' }))),
        h('div',
          h('div.section-label', 'Your data'),
          h('p.small.muted', { style: 'margin:0 0 8px' }, 'Every meeting is a folder of plain files: audio, transcript and notes in Markdown. Nothing is sent anywhere.'),
          button('btn-ghost.btn-sm', 'Open the Muesli folder', () => api.meetings.reveal(''), 'folder')))));
  $('modal-root').replaceChildren(modal);
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
