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
const fmtTime = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
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
  folder: '', // sidebar filter
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

async function refreshList() {
  state.list = state.query ? await api.meetings.search(state.query) : await api.meetings.list();
  const rows = [];
  const folders = allFolders();
  if (!folders.includes(state.folder)) state.folder = '';
  if (folders.length && !state.query) {
    const chip = (name, label) => h(`button.fchip${state.folder === name ? '.active' : ''}`, { onclick: () => { state.folder = name; refreshList(); } }, label);
    rows.push(h('div.folders', chip('', 'All'), folders.map((f) => chip(f, f))));
  }
  let group;
  for (const m of state.list) {
    if (state.folder && !state.query && m.folder !== state.folder) continue;
    const g = state.query ? 'Results' : dayGroup(m.createdAt);
    if (g !== group) rows.push(h('div.side-label', (group = g)));
    rows.push(h(`button.row${state.current?.id === m.id ? '.active' : ''}`, { title: m.title, onclick: () => open(m.id) },
      h('span.row-title', m.title || 'Untitled meeting'),
      h('span.row-date',
        h('span', g === 'Today' || g === 'Yesterday' ? fmtTime(m.createdAt) : fmtDate(m.createdAt)),
        state.rec?.meetingId === m.id ? h('span.row-rec', 'Recording') : m.durationSec > 0 && h('span', fmtDuration(m.durationSec)))));
  }
  $('list').replaceChildren(...(rows.length ? rows : [h('div.list-empty', state.query ? 'No meetings match.' : 'No meetings yet.')]));
}

const allFolders = () => [...new Set(state.list.map((m) => m.folder).filter(Boolean))].sort();

const dayGroup = (iso) => {
  const days = Math.floor((new Date().setHours(0, 0, 0, 0) - new Date(iso).setHours(0, 0, 0, 0)) / 864e5);
  return days <= 0 ? 'Today' : days === 1 ? 'Yesterday' : days < 7 ? 'This week' : 'Earlier';
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

async function newMeeting() {
  const m = await api.meetings.create({ template: state.settings.template || 'general' });
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
  const note = quiet('me') && quiet('them') ? 'Can\u2019t hear either side' : quiet('me') ? 'Can\u2019t hear your microphone' : quiet('them') ? 'Can\u2019t hear the other side' : '';
  $('health').textContent = note;
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
    needsSetup ? setupCard() : h('div.actions', button('btn-primary.btn-lg', 'Start a meeting', newMeeting, 'mic'), h('button.link', { title: 'Turn a voice memo or any recording into notes', onclick: guardless(importAudio) }, 'or import a recording')),
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
        h('ol.steps', h('li', 'Install Ollama and open it.'), h('li', 'Come back here and press Check again.')),
        h('div.actions', button('btn-primary', 'Get Ollama', () => api.openExternal('https://ollama.com/download')), h('button.link', { onclick: recheck }, 'Check again')),
      ]
    : [
        h('p', `You can record a meeting right away. To turn it into notes, Muesli needs a one-time ${s.sizeGb} GB download, chosen to fit this computer.`),
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
        h('button.icon-btn', { title: 'Open this meeting’s folder', 'aria-label': 'Open folder', onclick: () => api.meetings.reveal(m.id) }, icon('folder')),
        h('button.icon-btn.danger', { title: 'Move meeting to the bin', 'aria-label': 'Move meeting to the bin', onclick: async () => { await api.meetings.remove(m.id); await open(null); } }, icon('trash')))),
    h('div.sub',
      h('span', fmtDate(m.createdAt)),
      hasAudio && h('span', fmtDuration(m.durationSec)),
      !recordingHere && h('select.meta-select', { 'aria-label': 'Notes template', onchange: (e) => { saveSoon({ template: e.target.value }); api.saveSettings({ template: e.target.value }); } },
        Object.entries(state.templates).map(([key, t]) => h('option', { value: key, selected: key === m.template }, `${t.name} notes`))),
      !recordingHere && h('input.meta-input', { list: 'folder-names', value: m.folder || '', placeholder: 'Add to folder', 'aria-label': 'Folder', size: Math.max(11, (m.folder || '').length + 1), onchange: (e) => saveSoon({ folder: e.target.value.trim() }) }),
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
      h('span.dock-note.warn', { id: 'health', hidden: true }),
      h('button.dock-toggle', { title: view === 'live' ? 'Back to your notes' : 'Watch the transcript as it is written', onclick: () => { state.tab = view === 'live' ? 'mine' : 'transcript'; render(); if (view !== 'live') document.querySelector('.scroll').scrollTop = 1e9; } }, view === 'live' ? 'Notes' : 'Transcript'),
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
  if (!hasTranscript && !m.result) return h('div.dock', next, h('button.dock-toggle', { title: 'Turn a voice memo or any recording into notes', onclick: guardless(importAudio), disabled: !!state.rec }, 'Import audio'));
  return h('div.dock', h('div.dock-tabs', tab('mine', 'My notes'), tab('enhanced', 'Enhanced', !!m.result), tab('transcript', 'Transcript', hasTranscript), tab('ask', 'Ask', hasTranscript)), next);
}

const mineDoc = (m) => h('div.doc',
  h('textarea.notepad', { placeholder: 'Jot anything worth remembering while you talk: names, numbers, what to follow up on. Muesli fills in the rest from the transcript.', oninput: (e) => saveSoon({ userNotes: e.target.value }) }, m.userNotes));

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
      voices > 0 && stat('Voices', String(voices)),
      stat('Action items', String(r.actions.length), r.actions.length > 0 && h('small', open === r.actions.length ? 'open' : open ? `${open} still open` : 'all done')),
      stat('From your notes', h('span.dot.mine'), `${mine} ${mine === 1 ? 'line' : 'lines'}`)),
    sections.map((s) => h('section',
      h('h3', s.heading),
      h('ul.bullets', s.bullets.map((b) => h('li',
        h(`span.dot${b.from_my_notes ? '.mine' : ''}`, { title: b.from_my_notes ? 'From your notes' : 'Added from the transcript' }),
        h('span', h('span.edit', { contenteditable: 'plaintext-only', spellcheck: 'false', onblur: (e) => { const t = e.target.textContent.trim(); if (t && t !== b.text) { b.text = t; saveResult(); } } }, b.text), /^\d+:\d\d$/.test(b.timestamp) && h('button.ts', { title: 'Show this moment in the transcript', onclick: () => jumpTo(b.timestamp) }, b.timestamp))))))),
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
  // Click a voice to give it a name; every line of that voice follows.
  const rename = (s) => (e) => {
    const input = h('input.who-input', { value: m.speakers?.[s.voice || 0] || '', placeholder: 'Name', 'aria-label': 'Speaker name' });
    const done = () => { saveSoon({ speakers: { ...m.speakers, [s.voice || 0]: input.value.trim() } }); render(); };
    input.onblur = done;
    input.onkeydown = (ev) => ev.key === 'Enter' && input.blur();
    e.currentTarget.replaceWith(input);
    input.focus();
  };
  const text = m.transcript.map((s) => `[${clock(s.from / 1000)}] ${who(s)}: ${s.text}`).join('\n');
  return h('div.doc',
    hasAudio && h('div.player',
      h('button.icon-btn', { id: 'play', 'aria-label': 'Play', onclick: togglePlay }, icon('play')),
      h('input', { type: 'range', id: 'scrub', min: 0, max: m.durationSec, step: 0.1, value: 0, 'aria-label': 'Position', oninput: (e) => seek(+e.target.value, false) }),
      h('span.mono', { id: 'play-time' }, `00:00 / ${clock(m.durationSec)}`)),
    m.transcript.map((s) => h('div.seg', { 'data-from': s.from, 'data-to': s.to ?? s.from + 1 },
      h('button.ts', { disabled: !hasAudio, onclick: () => seek(s.from / 1000) }, clock(s.from / 1000)),
      s.speaker === 'Me' ? h('span.who.me', 'You') : h('button.who', { title: 'Name this speaker', onclick: rename(s) }, who(s)),
      h('span.seg-text', s.text))),
    h('div.doc-foot', h('span', `${m.transcript.length} lines, transcribed on this computer`), h('span.grow'), h('button.link', { onclick: () => copy(text, 'Transcript') }, icon('copy'), 'Copy transcript')));
}

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
const withTimes = (text) => text.replace(/(\[\d{1,3}:\d\d\])\s*[.,;]/g, '$1').split(/(\[\d{1,3}:\d\d\])/).map((part) => {
  const t = /^\[(\d{1,3}:\d\d)\]$/.exec(part);
  return t ? h('button.ts', { title: 'Show this moment in the transcript', onclick: () => jumpTo(t[1]) }, t[1]) : part;
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
  const re = new RegExp(`(${titled.map((m) => m.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`);
  return text.split(re).map((part) => {
    const m = titled.find((x) => x.title === part);
    return m ? h('button.cite', { title: 'Open this meeting', onclick: () => open(m.id) }, part) : part;
  });
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
          h('button.btn.btn-ghost.btn-sm', { type: 'submit', disabled: !!asking }, 'Ask'))
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
$('new').onclick = newMeeting;
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
