const { app, BrowserWindow, Tray, dialog, Notification, Menu, ipcMain, session, desktopCapturer, nativeImage, systemPreferences, shell, protocol } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, fork, execFile } = require('child_process');
const models = require('./models');
const meetings = require('./meetings');
const notes = require('./notes');
const mcp = require('./mcp');
const calendar = require('./calendar');

const ROOT = path.join(__dirname, '..');
meetings.setRoot(path.join(app.getPath('documents'), 'Muesli'));
const SAMPLE_RATE = 16000;
const isMac = process.platform === 'darwin';
const isWin = process.platform === 'win32';

// macOS only hands system audio to getDisplayMedia behind these Chromium features.
// MUESLI_CATAP=1 switches from ScreenCaptureKit to the Core Audio tap, which some macOS versions need.
if (isMac) {
  const tap = process.env.MUESLI_CATAP ? 'MacCatapSystemAudioLoopbackCapture' : 'MacSckSystemAudioLoopbackOverride';
  app.commandLine.appendSwitch('enable-features', `MacLoopbackAudioForScreenShare,${tap}`);
}

protocol.registerSchemesAsPrivileged([{ scheme: 'muesli-audio', privileges: { standard: true, stream: true, secure: true, supportFetchAPI: true } }]);

let win, tray, quitting, mcpServer;
const live = new Map(); // meetingId -> live transcription state while recording
const tracks = new Map(); // "<meetingId>:<track>" -> { fd, bytes, file }

const overlay = (theme) => ({ color: '#00000000', symbolColor: theme === 'light' ? '#2c352a' : '#e9e8e5', height: 40 });

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 760,
    minHeight: 520,
    title: 'Muesli',
    backgroundColor: '#131211',
    autoHideMenuBar: true,
    // The page draws its own top bar; the system only adds the window buttons.
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    titleBarOverlay: isMac ? false : overlay(settings().theme),
    icon: ICON,
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  // Closing the window keeps Muesli in the tray so a recording is never cut off by accident.
  win.on('close', (e) => {
    if (quitting || !tray) return;
    e.preventDefault();
    win.hide();
  });
}

const ICON = path.join(__dirname, 'icons', 'icon.png');

function wavHeader(dataBytes) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + dataBytes, 4);
  h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(SAMPLE_RATE, 24);
  h.writeUInt32LE(SAMPLE_RATE * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(dataBytes, 40);
  return h;
}

ipcMain.handle('rec:start', async (_e, meetingId) => {
  if (isMac) await systemPreferences.askForMediaAccess('microphone');
  const dir = meetings.dirOf(meetingId);
  fs.mkdirSync(dir, { recursive: true });
  for (const track of ['me', 'them']) {
    const file = path.join(dir, `${track}.wav`);
    const fd = fs.openSync(file, 'w');
    fs.writeSync(fd, wavHeader(0));
    tracks.set(`${meetingId}:${track}`, { fd, bytes: 0, file });
  }
  startLive(meetingId);
  return dir;
});

// Samples are written as they arrive, so a crash loses at most the last chunk.
ipcMain.on('rec:chunk', (_e, meetingId, track, int16) => {
  const t = tracks.get(`${meetingId}:${track}`);
  if (!t) return;
  const buf = Buffer.from(int16.buffer, int16.byteOffset, int16.byteLength);
  fs.writeSync(t.fd, buf);
  t.bytes += buf.length;
});

ipcMain.handle('rec:stop', (_e, meetingId) => {
  clearInterval(live.get(meetingId)?.timer);
  live.delete(meetingId);
  const out = {};
  for (const track of ['me', 'them']) {
    const key = `${meetingId}:${track}`;
    const t = tracks.get(key);
    if (!t) continue;
    fs.writeSync(t.fd, wavHeader(t.bytes), 0, 44, 0);
    fs.closeSync(t.fd);
    tracks.delete(key);
    out[track] = { file: t.file, seconds: t.bytes / 2 / SAMPLE_RATE };
  }
  if (out.me && meetings.get(meetingId)) meetings.update(meetingId, { durationSec: Math.round(Math.max(out.me.seconds, out.them?.seconds || 0)) });
  return out;
});

// Packaged builds carry one whisper binary in resources/bin; a dev checkout on Windows has both builds under vendor/.
function whisperPaths() {
  const exe = isWin ? 'whisper-cli.exe' : 'whisper-cli';
  const res = app.isPackaged ? process.resourcesPath : ROOT;
  const candidates = [
    path.join(res, 'bin', exe),
    path.join(ROOT, 'vendor', 'whisper', 'cuda', 'Release', exe),
    path.join(ROOT, 'vendor', 'whisper', 'cpu', 'Release', exe),
  ];
  const modelDir = path.join(res, 'models');
  const big = path.join(modelDir, 'ggml-large-v3-turbo-q5_0.bin');
  const small = path.join(modelDir, 'ggml-base.en.bin');
  return {
    bin: candidates.find((p) => fs.existsSync(p)),
    model: fs.existsSync(big) ? big : small,
    vad: path.join(modelDir, 'ggml-silero-v5.1.2.bin'),
  };
}

function transcribe(wavFile, { fast } = {}) {
  const { bin, model: best, vad } = whisperPaths();
  // The large model runs at about real time without a graphics card, so long recordings fall back to the small one there.
  const gpu = isMac || fs.existsSync(path.join(path.dirname(bin), 'ggml-cuda.dll'));
  const minutes = fs.statSync(wavFile).size / 2 / SAMPLE_RATE / 60;
  const small = path.join(path.dirname(best), 'ggml-base.en.bin');
  // The small model only knows English.
  const lang = settings().language || 'en';
  const model = !gpu && lang === 'en' && (fast || minutes > 10) && fs.existsSync(small) ? small : best;
  const outBase = wavFile.replace(/\.wav$/, '');
  const started = Date.now();
  return new Promise((resolve, reject) => {
    // -mc 0 and -sns cut hallucinated repeats; VAD stops Whisper inventing text on a silent track
    const p = spawn(bin, ['-m', model, '-l', lang, '-f', wavFile, '-oj', '-of', outBase, '-mc', '0', '-sns', '-np', '--vad', '-vm', vad], { cwd: path.dirname(bin) });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => {
      if (code !== 0) return reject(new Error(`whisper exited ${code}: ${err.slice(-500)}`));
      const json = JSON.parse(fs.readFileSync(`${outBase}.json`, 'utf8'));
      resolve({
        ms: Date.now() - started,
        model: path.basename(model),
        segments: json.transcription.map((s) => ({ from: s.offsets.from, to: s.offsets.to, text: s.text.trim() })),
      });
    });
  });
}
ipcMain.handle('whisper:transcribe', (_e, wavFile) => transcribe(wavFile));

// Live preview: every few seconds, transcribe whatever each track has gained since the last pass.
// The full recording is transcribed again after Stop, so a word cut at a slice edge does not matter.
function startLive(meetingId) {
  const st = { running: false, done: { me: 0, them: 0 }, segs: { me: [], them: [] } };
  st.timer = setInterval(() => liveTick(meetingId, st), 10000);
  live.set(meetingId, st);
}
async function liveTick(meetingId, st) {
  if (st.running) return;
  st.running = true;
  try {
    for (const track of ['me', 'them']) {
      const t = tracks.get(`${meetingId}:${track}`);
      if (!t) return;
      const from = st.done[track];
      const len = t.bytes - from;
      if (len < SAMPLE_RATE * 2 * 6) continue;
      const pcm = Buffer.alloc(len);
      const fd = fs.openSync(t.file, 'r');
      fs.readSync(fd, pcm, 0, len, 44 + from);
      fs.closeSync(fd);
      const slice = path.join(app.getPath('temp'), `muesli-live-${track}.wav`);
      fs.writeFileSync(slice, Buffer.concat([wavHeader(len), pcm]));
      const offset = (from / 2 / SAMPLE_RATE) * 1000;
      const { segments } = await transcribe(slice, { fast: true });
      st.done[track] = from + len;
      st.segs[track].push(...segments.map((s) => ({ ...s, from: s.from + offset, to: s.to + offset })));
    }
    if (live.get(meetingId) === st) win?.webContents.send('live', meetingId, meetings.mergeTracks(st.segs.me, st.segs.them));
  } catch {
    // the preview is best-effort; the recording itself is untouched
  } finally {
    st.running = false;
  }
}

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
function settings() {
  try {
    return JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
  } catch {
    return {};
  }
}
// Meetings can live anywhere the user chooses, for example a shared or synced drive.
try {
  if (settings().root) meetings.setRoot(settings().root);
} catch {
  // the chosen folder is not reachable right now; fall back to Documents
}
ipcMain.handle('settings:get', () => settings());
ipcMain.handle('data:chooseRoot', async () => {
  const pick = await dialog.showOpenDialog(win, { title: 'Where Muesli keeps your meetings', properties: ['openDirectory', 'createDirectory'] });
  if (pick.canceled) return null;
  meetings.setRoot(pick.filePaths[0]);
  const next = { ...settings(), root: pick.filePaths[0] };
  fs.writeFileSync(settingsFile(), JSON.stringify(next, null, 2));
  return next;
});
ipcMain.handle('settings:set', (_e, fields) => {
  const next = { ...settings(), ...fields };
  fs.writeFileSync(settingsFile(), JSON.stringify(next, null, 2));
  if (!isMac && 'theme' in fields) win.setTitleBarOverlay(overlay(next.theme));
  syncMcp();
  return next;
});

// The assistant connection runs only while it is switched on in Settings.
function syncMcp() {
  const on = !!settings().mcp;
  if (on && !mcpServer) mcpServer = mcp.start({ meetings, notes });
  if (!on && mcpServer) {
    mcpServer.close();
    mcpServer = null;
  }
}

ipcMain.handle('meetings:list', () => meetings.list());
ipcMain.handle('meetings:search', (_e, q) => meetings.search(q));
ipcMain.handle('meetings:get', (_e, id) => meetings.get(id));
ipcMain.handle('meetings:create', (_e, fields) => meetings.create(fields));
ipcMain.handle('meetings:update', (_e, id, fields) => meetings.update(id, fields));
ipcMain.handle('meetings:delete', (_e, id) => shell.trashItem(meetings.dirOf(id)));
ipcMain.handle('meetings:reveal', (_e, id) => shell.openPath(meetings.dirOf(id)));
ipcMain.handle('meetings:saveResult', (_e, id, result) => {
  meetings.write(id, 'notes.json', result);
  meetings.write(id, 'notes.md', notes.toMarkdown(meetings.get(id), result));
});
ipcMain.handle('open:external', (_e, url) => {
  if (url.startsWith('https://ollama.com/')) shell.openExternal(url);
});
// Built-in templates plus the ones made in Settings.
const allTemplates = () => ({ ...notes.TEMPLATES, ...(settings().templates || {}) });
ipcMain.handle('templates', () => allTemplates());

// The transcript as the model should read it: voices the user has named carry that name.
const named = (meeting) => meeting.transcript.map((s) => {
  const name = s.speaker === 'Them' && meeting.speakers?.[s.voice || 0];
  return name ? { ...s, speaker: name, voice: undefined } : s;
});

// Any recording can become a meeting: a voice memo from a phone, a call recorded elsewhere.
ipcMain.handle('audio:pick', async () => {
  // MUESLI_IMPORT / MUESLI_EXPORT name a file or folder so the self-tests can skip the dialogs.
  if (process.env.MUESLI_IMPORT) return { name: 'Imported', data: fs.readFileSync(process.env.MUESLI_IMPORT) };
  const pick = await dialog.showOpenDialog(win, { title: 'Import a recording', properties: ['openFile'], filters: [{ name: 'Audio', extensions: ['wav', 'mp3', 'm4a', 'aac', 'ogg', 'opus', 'flac', 'webm', 'mp4'] }] });
  if (pick.canceled) return null;
  return { name: path.basename(pick.filePaths[0]).replace(/\.[^.]+$/, ''), data: fs.readFileSync(pick.filePaths[0]) };
});

const esc = (t) => String(t).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
function exportHtml(m) {
  const r = m.result;
  const sections = r.notes.sections.filter((s) => s.bullets.length).map((s) => `<h2>${esc(s.heading)}</h2><ul>${s.bullets.map((b) => `<li>${esc(b.text)}</li>`).join('')}</ul>`).join('');
  const actions = r.actions.length ? `<h2>Action items</h2><ul class="todo">${r.actions.map((a) => `<li>${a.done ? '&#9745;' : '&#9744;'} ${esc(a.task)} <i>(${esc(a.owner)}${a.due ? `, due ${esc(a.due)}` : ''})</i></li>`).join('')}</ul>` : '';
  const when = new Date(m.createdAt).toLocaleString([], { dateStyle: 'long', timeStyle: 'short' });
  return `<!doctype html><meta charset="utf-8"><style>body{font:11pt/1.55 Georgia,serif;color:#1c211b;margin:0}h1{font-size:22pt;margin:0 0 4pt}h2{font:600 11pt/1.3 'Segoe UI',Helvetica,sans-serif;margin:18pt 0 6pt;color:#2f6b45}p.meta{font:9pt 'Segoe UI',Helvetica,sans-serif;color:#667}ul{margin:0;padding-left:16pt}li{margin:3pt 0}pre{font:10pt/1.5 Georgia,serif;white-space:pre-wrap}h2{break-after:avoid}.email{break-inside:avoid}ul.todo{list-style:none;padding-left:2pt}</style>
<h1>${esc(m.title || r.notes.title || 'Meeting')}</h1><p class="meta">${esc(when)}${m.people ? ` &middot; ${esc(m.people)}` : ''}</p>${sections}${actions}${r.email ? `<div class="email"><h2>Follow-up email</h2><pre>${esc(r.email)}</pre></div>` : ''}`;
}
ipcMain.handle('meetings:export', async (_e, id, kind) => {
  const m = meetings.get(id);
  const base = (m.title || 'Meeting').replace(/[\\/:*?"<>|]/g, ' ').trim();
  const pick = process.env.MUESLI_EXPORT ? { filePath: path.join(process.env.MUESLI_EXPORT, `export.${kind}`) } : await dialog.showSaveDialog(win, { defaultPath: path.join(app.getPath('documents'), `${base}.${kind}`), filters: [kind === 'pdf' ? { name: 'PDF', extensions: ['pdf'] } : { name: 'Markdown', extensions: ['md'] }] });
  if (pick.canceled) return null;
  if (kind === 'pdf') {
    const page = new BrowserWindow({ show: false, webPreferences: { javascript: false } });
    await page.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(exportHtml(m))}`);
    fs.writeFileSync(pick.filePath, await page.webContents.printToPDF({ pageSize: 'A4', margins: { top: 0.8, bottom: 0.8, left: 0.9, right: 0.9 } }));
    page.destroy();
  } else {
    const transcript = notes.formatTranscript(named(m));
    fs.writeFileSync(pick.filePath, `${notes.toMarkdown(m, m.result)}${m.result.email ? `\n## Follow-up email\n\n${m.result.email}\n` : ''}${transcript ? `\n## Transcript\n\n${transcript}\n` : ''}`);
  }
  return pick.filePath;
});

const progress = (id, p) => win?.webContents.send('progress', id, p);

// Who spoke when on the other side of the call. Best-effort: any failure just leaves everyone as "Them".
function diarize(wavFile) {
  const dir = path.join(path.dirname(whisperPaths().vad), 'diar');
  if (!fs.existsSync(path.join(dir, 'segmentation.onnx'))) return Promise.resolve([]);
  return new Promise((resolve) => {
    // macOS finds the library's own dylibs through this variable; the packaged copy lives outside the archive.
    const env = { ...process.env };
    try {
      if (isMac) env.DYLD_LIBRARY_PATH = path.dirname(require.resolve(`sherpa-onnx-darwin-${process.arch}/package.json`)).replace('app.asar', 'app.asar.unpacked');
    } catch {
      return resolve([]);
    }
    const child = fork(path.join(__dirname, 'diarize.js'), [wavFile, dir], { stdio: 'ignore', env });
    let done = false;
    const finish = (segments) => {
      if (!done) resolve(segments);
      done = true;
    };
    child.on('message', (msg) => finish(msg.segments || []));
    child.on('error', () => finish([]));
    child.on('exit', () => finish([]));
  });
}

// Give each transcript line the voice it overlaps most. Only applied when more than one voice was found.
function labelVoices(segments, turns) {
  if (new Set(turns.map((t) => t.speaker)).size < 2) return;
  const order = []; // voices numbered in the order they first speak
  for (const seg of segments) {
    const overlap = new Map();
    for (const t of turns) {
      const shared = Math.min(seg.to, t.end * 1000) - Math.max(seg.from, t.start * 1000);
      if (shared > 0) overlap.set(t.speaker, (overlap.get(t.speaker) || 0) + shared);
    }
    if (!overlap.size) continue;
    const voice = [...overlap].sort((a, b) => b[1] - a[1])[0][0];
    if (!order.includes(voice)) order.push(voice);
    seg.voice = order.indexOf(voice) + 1;
  }
}

// Both tracks to text, then one speaker-labelled transcript.
ipcMain.handle('meetings:transcribe', async (_e, id) => {
  const out = {};
  for (const track of ['me', 'them']) {
    const file = path.join(meetings.dirOf(id), `${track}.wav`);
    progress(id, { step: track === 'me' ? 'Transcribing your side' : 'Transcribing the other side' });
    out[track] = fs.existsSync(file) && fs.statSync(file).size > 44 ? (await transcribe(file)).segments : [];
  }
  if (out.them.length > 1) {
    progress(id, { step: 'Telling the speakers apart' });
    labelVoices(out.them, await diarize(path.join(meetings.dirOf(id), 'them.wav')));
  }
  const transcript = meetings.mergeTracks(out.me, out.them);
  meetings.write(id, 'transcript.json', transcript);
  return transcript;
});

// The model the user picked, or the suggestion for this machine. Models outside the tier list get settings by size.
async function notesTier() {
  const inv = await models.inventory();
  const name = settings().model || inv.suggested.model;
  const tier = models.TIERS.find((t) => t.model === name);
  if (tier) return tier;
  const m = inv.installed.find((i) => i.name === name);
  const small = m && m.sizeGb < 5;
  return { model: name, numCtx: small ? 8192 : 16384, chunked: small };
}

ipcMain.handle('meetings:generate', async (_e, id) => {
  const meeting = meetings.get(id);
  const result = await notes.generate({ ...meeting, segments: named(meeting), language: settings().language, templateDef: allTemplates()[meeting.template] }, await notesTier(), (p) => progress(id, p));
  meetings.write(id, 'notes.json', result);
  meetings.write(id, 'notes.md', notes.toMarkdown(meeting, result));
  if (!meeting.title && result.notes.title) meetings.update(id, { title: result.notes.title });
  // A failed webhook must not lose the notes: report it and carry on.
  let webhookError = null;
  if (settings().webhookUrl) {
    progress(id, { step: 'Sending to your webhook' });
    webhookError = await sendWebhook(meetings.get(id)).catch((e) => e.message);
  }
  return { ...meetings.get(id), webhookError };
});

// The only thing Muesli ever sends anywhere, and only to the address the user typed into Settings.
async function sendWebhook(meeting) {
  const url = new URL(settings().webhookUrl);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('The webhook address must start with http:// or https://');
  const r = meeting.result;
  const body = {
    event: 'meeting.notes',
    id: meeting.id,
    title: meeting.title,
    createdAt: meeting.createdAt,
    durationSec: meeting.durationSec,
    template: meeting.template,
    notesMarkdown: r ? notes.toMarkdown(meeting, r) : '',
    sections: r?.notes.sections || [],
    actionItems: r?.actions || [],
    email: r?.email || '',
    transcript: meeting.transcript,
  };
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`The webhook answered ${res.status}`);
  return null;
}
ipcMain.handle('meetings:send', (_e, id) => sendWebhook(meetings.get(id)));

// Questions about one meeting, answered by the same local model. The exchange is kept in chat.json.
ipcMain.handle('meetings:ask', async (_e, id, question) => {
  const meeting = meetings.get(id);
  const answer = await notes.ask({ ...meeting, segments: named(meeting) }, await notesTier(), meeting.chat, question, (token) => win?.webContents.send('ask', id, token));
  const chat = [...meeting.chat, { q: question, a: answer }];
  meetings.write(id, 'chat.json', chat);
  return chat;
});

// The same, across every meeting that has notes.
ipcMain.handle('meetings:askAll', async (_e, history, question) => {
  const all = meetings.list().map((m) => meetings.get(m.id)).filter((m) => m.result || m.userNotes);
  return notes.askAll(all, await notesTier(), history, question, (token) => win?.webContents.send('ask', 'all', token));
});

// Windows keeps a record of which apps hold the microphone right now. A new one usually means a call has started.
function micUsers() {
  return new Promise((resolve) => {
    const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone';
    execFile('reg', ['query', key, '/s', '/v', 'LastUsedTimeStop'], { windowsHide: true }, (err, out) => {
      const users = [];
      let app = '';
      for (const line of err ? [] : out.split(/\r?\n/)) {
        if (line.startsWith('HKEY')) app = line.trim().split('\\').pop();
        else if (/LastUsedTimeStop\s+REG_QWORD\s+0x0\s*$/.test(line)) users.push(app);
      }
      resolve(users);
    });
  });
}
const CALL_APPS = { chrome: 'Chrome', msedge: 'Edge', firefox: 'Firefox', 'ms-teams': 'Teams', msteams: 'Teams', teams: 'Teams', cpthost: 'Zoom', zoom: 'Zoom', slack: 'Slack', discord: 'Discord', webex: 'Webex' };
function watchForCalls() {
  if (process.platform !== 'win32') return;
  const own = path.basename(process.execPath).toLowerCase();
  let before = null;
  setInterval(async () => {
    if (settings().detect === false) return (before = null);
    const now = (await micUsers()).filter((u) => !u.toLowerCase().endsWith(own));
    const fresh = before ? now.filter((u) => !before.includes(u)) : [];
    before = now;
    if (!fresh.length || tracks.size) return;
    const raw = fresh[0].split('#').pop().replace(/\.exe$/i, '').split('_')[0];
    const name = CALL_APPS[raw.toLowerCase()] || raw;
    const note = new Notification({ title: `${name} is using your microphone`, body: 'In a call? Click here and Muesli records it. Nothing leaves this computer.' });
    note.on('click', () => {
      win.show();
      win.focus();
      win.webContents.send('tray', 'record');
    });
    note.show();
    win?.webContents.send('tray', `heard:${name}`);
  }, 8000);
}

// What the calendar says is coming up. Reading the link is the only network call, and only if a link was added.
ipcMain.handle('calendar:upcoming', () => calendar.upcoming(settings().calendarUrl));

// When a meeting on the calendar begins, offer to record it. This also covers macOS, where call detection is not available.
function watchCalendar() {
  const told = new Set();
  setInterval(async () => {
    if (!settings().calendarUrl || tracks.size) return;
    const events = await calendar.upcoming(settings().calendarUrl, 1).catch(() => []);
    const due = events.find((e) => Math.abs(new Date(e.start) - Date.now()) < 60000 && !told.has(e.start + e.title));
    if (!due) return;
    told.add(due.start + due.title);
    const note = new Notification({ title: `${due.title} is starting`, body: 'Click here and Muesli records it. Nothing leaves this computer.' });
    note.on('click', () => {
      win.show();
      win.focus();
      win.webContents.send('tray', `event:${JSON.stringify(due)}`);
    });
    note.show();
  }, 30000);
}

ipcMain.handle('models:pull', async (_e, model) => {
  const res = await fetch(`${models.OLLAMA}/api/pull`, { method: 'POST', body: JSON.stringify({ model }) });
  let pending = '';
  const decoder = new TextDecoder();
  for await (const chunk of res.body) {
    pending += decoder.decode(chunk, { stream: true });
    const lines = pending.split('\n');
    pending = lines.pop();
    for (const line of lines.filter((l) => l.trim())) {
      const msg = JSON.parse(line);
      if (msg.error) throw new Error(msg.error);
      win?.webContents.send('pull', model, { status: msg.status, done: msg.completed || 0, total: msg.total || 0 });
    }
  }
  return true;
});

ipcMain.handle('models:inventory', async () => ({ ...(await models.inventory()), tiers: models.TIERS }));

ipcMain.handle('app:info', () => ({
  platform: `${process.platform} ${process.arch} ${process.getSystemVersion()}`,
  electron: process.versions.electron,
  whisper: whisperPaths(),
  screenAccess: isMac ? systemPreferences.getMediaAccessStatus('screen') : 'n/a',
  micAccess: isMac ? systemPreferences.getMediaAccessStatus('microphone') : 'n/a',
  mcpUrl: mcp.url,
}));

app.whenReady().then(() => {
  // Hand getDisplayMedia the whole screen with system-audio loopback, no picker.
  session.defaultSession.setDisplayMediaRequestHandler((_req, cb) => {
    desktopCapturer.getSources({ types: ['screen'] }).then((sources) => cb({ video: sources[0], audio: 'loopback' }));
  });

  // Serves a meeting's audio to the player, with byte ranges so seeking works.
  protocol.handle('muesli-audio', (req) => {
    // muesli-audio://meeting/<id>/<track>.wav
    const [id, name] = decodeURIComponent(new URL(req.url).pathname).split('/').filter(Boolean);
    const file = path.join(meetings.dirOf(path.basename(id || '')), path.basename(name || ''));
    if (!/^(me|them)\.wav$/.test(path.basename(file)) || !fs.existsSync(file)) return new Response(null, { status: 404 });
    const size = fs.statSync(file).size;
    const range = /bytes=(\d+)-(\d*)/.exec(req.headers.get('range') || '');
    // Answer in slices of at most 1 MB; the player asks for the next one as it goes.
    const start = range ? Number(range[1]) : 0;
    const end = Math.min(range && range[2] ? Number(range[2]) : size - 1, start + 1024 * 1024 - 1, size - 1);
    const buf = Buffer.alloc(Math.max(0, end - start + 1));
    const fd = fs.openSync(file, 'r');
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    return new Response(buf, {
      status: 206,
      headers: { 'Content-Type': 'audio/wav', 'Accept-Ranges': 'bytes', 'Content-Length': String(buf.length), 'Content-Range': `bytes ${start}-${end}/${size}` },
    });
  });


  // First run: one sample meeting with a transcript, so Enhance can be tried before recording anything.
  if (!settings().seeded) {
    if (!meetings.list().length) {
      const { segments, ...fields } = require('./sample');
      meetings.write(meetings.create(fields).id, 'transcript.json', segments);
    }
    fs.writeFileSync(settingsFile(), JSON.stringify({ ...settings(), seeded: true }, null, 2));
  }

  syncMcp();
  if (!isMac) Menu.setApplicationMenu(null);
  createWindow();
  if (process.platform === 'win32') app.setAppUserModelId(app.isPackaged ? 'com.muesli.app' : process.execPath);
  watchForCalls();
  watchCalendar();

  const show = () => {
    win.show();
    win.focus();
  };
  const trayIcon = nativeImage.createFromPath(path.join(__dirname, 'icons', isMac ? 'trayTemplate.png' : 'tray.png'));
  if (!trayIcon.isEmpty()) {
    tray = new Tray(trayIcon);
    tray.setToolTip('Muesli');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Open Muesli', click: show },
      { label: 'New meeting', click: () => { show(); win.webContents.send('tray', 'new'); } },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() },
    ]));
    tray.on('click', show);
  }
});

app.on('before-quit', () => (quitting = true));
app.on('activate', () => win?.show());
app.on('window-all-closed', () => app.quit());

// Self-test: `MUESLI_AUTOTEST=<wav> electron .` records while playing the wav through the speakers.
ipcMain.handle('autotest:play', () => new Promise((resolve) => {
  const wav = process.env.MUESLI_AUTOTEST;
  if (!wav) return resolve(false);
  // A number instead of a file: just record for that many seconds, for audio played by something else.
  if (/^\d+$/.test(wav)) return setTimeout(() => resolve(true), Number(wav) * 1000);
  const player = isMac ? spawn('afplay', [wav]) : spawn('powershell', ['-NoProfile', '-Command', `(New-Object Media.SoundPlayer '${wav}').PlaySync()`]);
  player.on('close', () => resolve(true));
}));
ipcMain.on('autotest:done', (_e, text) => {
  fs.writeFileSync(path.join(app.isPackaged ? app.getPath('temp') : path.join(ROOT, 'out'), 'autotest.log'), text);
  app.quit();
});

// Design review: `MUESLI_SHOT=<png> [MUESLI_SHOT_JS=<script>] electron .` saves a screenshot of the window and quits.
if (process.env.MUESLI_SHOT) {
  app.whenReady().then(() => {
    win.webContents.once('did-finish-load', async () => {
      await new Promise((r) => setTimeout(r, 1500));
      if (process.env.MUESLI_SHOT_JS) console.log('SHOT_JS', JSON.stringify(await win.webContents.executeJavaScript(process.env.MUESLI_SHOT_JS)));
      await new Promise((r) => setTimeout(r, 800));
      fs.writeFileSync(process.env.MUESLI_SHOT, (await win.webContents.capturePage()).toPNG());
      quitting = true;
      app.quit();
    });
  });
}
