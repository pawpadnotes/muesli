// Runs in its own process (forked by main) so a long recording never freezes the window.
// usage: diarize.js <wav> <model dir>  ->  sends { segments: [{ start, end, speaker }] (seconds), voices: { speaker: { vec, seconds } } } to the parent

const path = require('path');

const cosine = (x, y) => x.reduce((sum, v, i) => sum + v * y[i], 0);
const unit = (v) => {
  const n = Math.hypot(...v) || 1;
  return v.map((x) => x / n);
};

// samples: 16 kHz mono floats. dir: where the two models are. Returns who spoke when, and a voiceprint per speaker.
function diarize(samples, dir, opts = {}) {
  const o = { segmentation: 'segmentation.onnx', embedding: 'nemo_en_titanet_small.onnx', split: 0.6, same: 0.5, most: 6, ...opts };
  const sherpa = require('sherpa-onnx-node');
  const threads = Math.max(1, Math.min(8, require('os').cpus().length - 2));
  const sd = new sherpa.OfflineSpeakerDiarization({
    segmentation: { pyannote: { model: path.join(dir, o.segmentation) }, numThreads: threads },
    embedding: { model: path.join(dir, o.embedding), numThreads: threads },
    // -1 lets it work out how many people spoke. It errs towards too many voices on purpose: pieces of one person are joined below, with more to go on.
    clustering: { numClusters: -1, threshold: o.split },
    minDurationOn: 0.3,
    minDurationOff: 0.5,
  });
  const segments = sd.process(samples);
  // A voiceprint per speaker, from their longest turns (a minute is plenty, and the model refuses much more). Voice profiles compare these across meetings.
  const extractor = new sherpa.SpeakerEmbeddingExtractor({ model: path.join(dir, o.embedding) });
  const voices = {};
  for (const speaker of new Set(segments.map((s) => s.speaker))) {
    const turns = segments.filter((s) => s.speaker === speaker).sort((a, b) => (b.end - b.start) - (a.end - a.start));
    const seconds = turns.reduce((sum, t) => sum + t.end - t.start, 0);
    const stream = extractor.createStream();
    let used = 0;
    for (const t of turns) {
      const take = Math.min(t.end - t.start, 60 - used);
      if (take < 0.5) break;
      stream.acceptWaveform({ sampleRate: 16000, samples: samples.slice(Math.floor(t.start * 16000), Math.floor((t.start + take) * 16000)) });
      used += take;
    }
    stream.inputFinished();
    if (used < 2 || !extractor.isReady(stream)) continue;
    let vec;
    try {
      vec = Array.from(extractor.compute(stream, false));
    } catch {
      continue; // no voiceprint for this speaker; who spoke when still stands
    }
    voices[speaker] = { vec: unit(vec), seconds, heard: used };
  }
  // The clustering above splits one person into several when they laugh, shout or talk over someone.
  // Join the two voices that sound most alike, again and again, until no pair sounds like one person. A joined voice is
  // the average of its pieces weighted by how much of each was heard, so it gets steadier as it grows.
  const into = {};
  const join = (from, to) => {
    const a = voices[from], b = voices[to];
    b.vec = unit(b.vec.map((x, i) => x * b.heard + a.vec[i] * a.heard));
    b.seconds += a.seconds;
    b.heard += a.heard;
    delete voices[from];
    for (const k of Object.keys(into)) if (into[k] === from) into[k] = to;
    into[from] = to;
  };
  const closest = (only) => {
    let best = null;
    const keys = Object.keys(voices);
    for (const a of keys) for (const b of keys) {
      if (a === b || voices[a].seconds > voices[b].seconds || (voices[a].seconds === voices[b].seconds && a > b)) continue;
      if (only && !only(a)) continue;
      const score = cosine(voices[a].vec, voices[b].vec);
      if (!best || score > best.score) best = { from: a, to: b, score };
    }
    return best;
  };
  for (let pair = closest(); pair && pair.score >= o.same; pair = closest()) join(pair.from, pair.to);
  // Scraps too short to be a participant go to whichever voice is nearest. In a short recording ten seconds is a real share of the talking, so there a scrap is under a twentieth of it.
  const spoken = Object.values(voices).reduce((sum, v) => sum + v.seconds, 0);
  const scrap = Math.min(10, spoken / 20);
  for (let pair = closest((a) => voices[a].seconds < scrap); pair; pair = closest((a) => voices[a].seconds < scrap)) join(pair.from, pair.to);
  // More voices than a call plausibly has: the closest pairs are one person.
  while (Object.keys(voices).length > o.most) {
    const pair = closest();
    join(pair.from, pair.to);
  }
  for (const seg of segments) if (seg.speaker in into) seg.speaker = Number(into[seg.speaker]);
  for (const v of Object.values(voices)) {
    v.vec = v.vec.map((x) => +x.toFixed(5));
    delete v.heard;
  }
  // Turns from speakers with no voiceprint at all (under two seconds) are dropped; the lines they covered take the nearest voice in time.
  return { segments: segments.filter((seg) => voices[seg.speaker]), voices };
}

module.exports = { diarize };

if (require.main === module) {
  const [wav, dir] = process.argv.slice(2);
  try {
    // Muesli's own recordings: 16-bit mono after a 44-byte header. Read here because Electron refuses the library's external buffers.
    const pcm = require('fs').readFileSync(wav).subarray(44);
    const samples = new Float32Array(pcm.length >> 1);
    for (let i = 0; i < samples.length; i++) samples[i] = pcm.readInt16LE(i * 2) / 32768;
    process.send(diarize(samples, dir), () => process.exit(0));
  } catch (e) {
    process.send({ error: e.message }, () => process.exit(1));
  }
}
