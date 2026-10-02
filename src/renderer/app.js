const toggle = document.getElementById('toggle');
const logEl = document.getElementById('log');
const log = (s) => (logEl.textContent += s + '\n');

let rec = null;

async function tap(ctx, stream, meetingId, track) {
  const node = new AudioWorkletNode(ctx, 'pcm-worklet');
  const meter = document.getElementById(`lvl-${track}`);
  node.port.onmessage = ({ data }) => {
    meter.value = data.peak;
    window.muesli.sendChunk(meetingId, track, data.pcm);
  };
  ctx.createMediaStreamSource(stream).connect(node);
}

async function start() {
  const meetingId = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = await window.muesli.startRecording(meetingId);

  const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
  // Video is required to get loopback audio; drop it straight away.
  const display = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
  display.getVideoTracks().forEach((t) => t.stop());
  const system = new MediaStream(display.getAudioTracks());

  const ctx = new AudioContext({ sampleRate: 16000 });
  await ctx.audioWorklet.addModule('pcm-worklet.js');
  await tap(ctx, mic, meetingId, 'me');
  await tap(ctx, system, meetingId, 'them');

  rec = { meetingId, ctx, streams: [mic, display] };
  log(`Recording to ${dir}`);
}

async function stop() {
  const { meetingId, ctx, streams } = rec;
  rec = null;
  streams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
  await ctx.close();
  const files = await window.muesli.stopRecording(meetingId);

  for (const [track, { file, seconds }] of Object.entries(files)) {
    log(`\n${track}: ${seconds.toFixed(1)} s of audio, transcribing...`);
    try {
      const r = await window.muesli.transcribe(file);
      log(`${track}: ${r.ms} ms with ${r.model}`);
      r.segments.forEach((s) => log(`  [${(s.from / 1000).toFixed(1)}] ${s.text}`));
    } catch (e) {
      log(`${track}: FAILED ${e.message}`);
    }
  }
}

toggle.onclick = async () => {
  toggle.disabled = true;
  try {
    if (rec) {
      await stop();
      toggle.textContent = 'Start recording';
    } else {
      await start();
      toggle.textContent = 'Stop and transcribe';
    }
  } catch (e) {
    log(`ERROR ${e.message}`);
  }
  toggle.disabled = false;
};

if (window.muesli.autotest) {
  (async () => {
    try {
      await start();
      await window.muesli.autotestPlay();
      await new Promise((r) => setTimeout(r, 1000));
      await stop();
    } catch (e) {
      log(`ERROR ${e.message}`);
    }
    window.muesli.autotestDone(logEl.textContent);
  })();
}

(async () => {
  const info = await window.muesli.info();
  log(`${info.platform}, Electron ${info.electron}`);
  log(`Whisper: ${info.whisper.bin ? 'found' : 'MISSING'}, model ${info.whisper.model.split(/[\/]/).pop()}`);
  log(`Access: screen ${info.screenAccess}, mic ${info.micAccess}`);
  const inv = await window.muesli.modelInventory();
  log(`Memory: ${inv.memory.totalGb.toFixed(0)} GB ${inv.memory.kind}, budget ${inv.memory.budgetGb.toFixed(1)} GB`);
  log(`Suggested model: ${inv.suggested.model}${inv.suggested.installed ? ' (installed)' : ' (not installed)'}`);
  log(inv.ollamaRunning ? `Ollama models: ${inv.installed.map((m) => m.name).join(', ') || 'none'}` : 'Ollama: not running');
  log('');
})();
