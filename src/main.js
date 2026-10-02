const { app, BrowserWindow, Tray, Menu, ipcMain, session, desktopCapturer, nativeImage, systemPreferences, shell } = require('electron');
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

let win, tray;
const tracks = new Map(); // "<meetingId>:<track>" -> { fd, bytes, file }

function createWindow() {
  win = new BrowserWindow({
    width: 900,
    height: 700,
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

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
  const { bin, model, vad } = whisperPaths();
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
  return meetings.get(id);
});

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

ipcMain.handle('models:inventory', () => models.inventory());

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

  createWindow();

  // An empty image throws on macOS, so the tray waits for the real icon there.
  if (!isMac) {
    tray = new Tray(nativeImage.createEmpty());
    tray.setToolTip('Muesli');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Open Muesli', click: () => win.show() },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() },
    ]));
  }
});

app.on('window-all-closed', () => app.quit());

// Self-test: `MUESLI_AUTOTEST=<wav> electron .` records while playing the wav through the speakers.
ipcMain.handle('autotest:play', () => new Promise((resolve) => {
  const wav = process.env.MUESLI_AUTOTEST;
  if (!wav) return resolve(false);
  const player = isMac ? spawn('afplay', [wav]) : spawn('powershell', ['-NoProfile', '-Command', `(New-Object Media.SoundPlayer '${wav}').PlaySync()`]);
  player.on('close', () => resolve(true));
}));
ipcMain.on('autotest:done', (_e, text) => {
  fs.writeFileSync(path.join(ROOT, 'out', 'autotest.log'), text);
  app.quit();
});
