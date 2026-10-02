const { app, BrowserWindow, Tray, Menu, ipcMain, session, desktopCapturer, nativeImage, systemPreferences, shell, protocol } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const models = require('./models');
const meetings = require('./meetings');
const notes = require('./notes');

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

let win, tray, quitting;
const tracks = new Map(); // "<meetingId>:<track>" -> { fd, bytes, file }

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 760,
    minHeight: 520,
    title: 'Muesli',
    backgroundColor: '#131211',
    autoHideMenuBar: true,
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
  if (out.me && meetings.get(meetingId)) meetings.update(meetingId, { durationSec: Math.round(out.me.seconds) });
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

function transcribe(wavFile) {
  const { bin, model: best, vad } = whisperPaths();
  // The large model runs at about real time without a graphics card, so long recordings fall back to the small one there.
  const gpu = isMac || fs.existsSync(path.join(path.dirname(bin), 'ggml-cuda.dll'));
  const minutes = fs.statSync(wavFile).size / 2 / SAMPLE_RATE / 60;
  const small = path.join(path.dirname(best), 'ggml-base.en.bin');
  const model = !gpu && minutes > 10 && fs.existsSync(small) ? small : best;
  const outBase = wavFile.replace(/\.wav$/, '');
  const started = Date.now();
  return new Promise((resolve, reject) => {
    // -mc 0 and -sns cut hallucinated repeats; VAD stops Whisper inventing text on a silent track
    const p = spawn(bin, ['-m', model, '-f', wavFile, '-oj', '-of', outBase, '-mc', '0', '-sns', '-np', '--vad', '-vm', vad], { cwd: path.dirname(bin) });
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

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
function settings() {
  try {
    return JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
  } catch {
    return {};
  }
}
ipcMain.handle('settings:get', () => settings());
ipcMain.handle('settings:set', (_e, fields) => {
  const next = { ...settings(), ...fields };
  fs.writeFileSync(settingsFile(), JSON.stringify(next, null, 2));
  return next;
});

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
ipcMain.handle('templates', () => notes.TEMPLATES);

const progress = (id, p) => win?.webContents.send('progress', id, p);

// Both tracks to text, then one speaker-labelled transcript.
ipcMain.handle('meetings:transcribe', async (_e, id) => {
  const out = {};
  for (const track of ['me', 'them']) {
    const file = path.join(meetings.dirOf(id), `${track}.wav`);
    progress(id, { step: track === 'me' ? 'Transcribing your side' : 'Transcribing the other side' });
    out[track] = fs.existsSync(file) && fs.statSync(file).size > 44 ? (await transcribe(file)).segments : [];
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
  const result = await notes.generate({ ...meeting, segments: meeting.transcript }, await notesTier(), (p) => progress(id, p));
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

  if (!isMac) Menu.setApplicationMenu(null);
  createWindow();

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
