const os = require('os');
const { execFile } = require('child_process');

const providers = require('./providers');
// Where Ollama is: this computer unless Settings point at another machine.
let OLLAMA = providers.DEFAULT_OLLAMA;
const setOllama = (url) => { OLLAMA = url || providers.DEFAULT_OLLAMA; };
const GB = 1024 ** 3;
// A loaded model needs its file size plus room for context.
const HEADROOM = 1.2;

// Largest first; the first tier that fits the memory budget is suggested.
const TIERS = [
  { model: 'qwen3.8:27b', sizeGb: 17.7, numCtx: 16384, label: 'Best notes' },
  { model: 'qwen3.5:9b-q8_0', sizeGb: 10.7, numCtx: 16384, label: 'High quality' },
  { model: 'qwen3.5:9b', sizeGb: 6.6, numCtx: 16384, label: 'Balanced' },
  // Too small to hold a long transcript in one call; notes are built chunk by chunk.
  { model: 'qwen3.5:4b', sizeGb: 3.4, numCtx: 8192, chunked: true, label: 'Light' },
];

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 5000, windowsHide: true }, (err, stdout) => resolve(err ? '' : stdout));
  });
}

// How much memory a model can use: dedicated VRAM on a PC with a discrete GPU,
// a share of unified memory on Apple Silicon, otherwise a share of system RAM (CPU inference).
async function memoryBudget() {
  const ramGb = os.totalmem() / GB;
  if (process.platform === 'darwin' && process.arch === 'arm64') {
    return { kind: 'unified', totalGb: ramGb, budgetGb: ramGb * 0.7 };
  }
  const smi = await run('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits']);
  const gpus = smi.split('\n').map((l) => l.split(',').map((s) => s.trim())).filter((p) => p.length === 2 && Number(p[1]) > 0);
  if (gpus.length) {
    const best = gpus.reduce((a, b) => (Number(b[1]) > Number(a[1]) ? b : a));
    const vramGb = Number(best[1]) / 1024;
    return { kind: 'vram', gpu: best[0], totalGb: vramGb, budgetGb: vramGb };
  }
  return { kind: 'ram', totalGb: ramGb, budgetGb: ramGb * 0.5 };
}

function suggest(budgetGb) {
  return TIERS.find((t) => t.sizeGb * HEADROOM <= budgetGb) || TIERS[TIERS.length - 1];
}

// Chat models already pulled in Ollama. Returns null when Ollama isn't running.
async function installedModels(budgetGb) {
  let tags;
  try {
    const res = await fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(3000) });
    tags = await res.json();
  } catch {
    return null;
  }
  return tags.models
    .filter((m) => !/whisper|embed/i.test(m.name))
    .map((m) => {
      const sizeGb = m.size / GB;
      return {
        name: m.name,
        sizeGb,
        params: m.details?.parameter_size || '',
        quant: m.details?.quantization_level || '',
        fits: sizeGb * HEADROOM <= budgetGb,
      };
    })
    .sort((a, b) => b.fits - a.fits || b.sizeGb - a.sizeGb);
}

async function inventory() {
  const memory = await memoryBudget();
  const suggested = suggest(memory.budgetGb);
  const installed = await installedModels(memory.budgetGb);
  return {
    memory,
    suggested: { ...suggested, installed: !!installed?.some((m) => m.name === suggested.model) },
    ollamaRunning: installed !== null,
    installed: installed || [],
  };
}

module.exports = { inventory, suggest, TIERS, setOllama, ollama: () => OLLAMA };

if (require.main === module) inventory().then((r) => console.log(JSON.stringify(r, null, 2)));
