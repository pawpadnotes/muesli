// Runs in its own process (forked by main) so a long recording never freezes the window.
// usage: diarize.js <wav> <model dir>  ->  sends { segments: [{ start, end, speaker }] (seconds), voices: { speaker: { vec, seconds } } } to the parent

const path = require('path');

const [wav, dir] = process.argv.slice(2);
try {
  const sherpa = require('sherpa-onnx-node');
  const threads = Math.max(1, Math.min(8, require('os').cpus().length - 2));
  const sd = new sherpa.OfflineSpeakerDiarization({
    segmentation: { pyannote: { model: path.join(dir, 'segmentation.onnx') }, numThreads: threads },
    embedding: { model: path.join(dir, 'nemo_en_titanet_small.onnx'), numThreads: threads },
    // -1 lets it work out how many people spoke; 0.6 kept two test voices apart without splitting either
    clustering: { numClusters: -1, threshold: 0.6 },
    minDurationOn: 0.3,
    minDurationOff: 0.5,
  });
  // Muesli's own recordings: 16-bit mono after a 44-byte header. Read here because Electron refuses the library's external buffers.
  const pcm = require('fs').readFileSync(wav).subarray(44);
  const samples = new Float32Array(pcm.length >> 1);
  for (let i = 0; i < samples.length; i++) samples[i] = pcm.readInt16LE(i * 2) / 32768;
  const segments = sd.process(samples);
  // A voiceprint per speaker, from their longest turns (a minute is plenty, and the model refuses much more). Voice profiles compare these across meetings.
  const extractor = new sherpa.SpeakerEmbeddingExtractor({ model: path.join(dir, 'nemo_en_titanet_small.onnx') });
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
    const norm = Math.hypot(...vec) || 1;
    voices[speaker] = { vec: vec.map((x) => +(x / norm).toFixed(5)), seconds };
  }
  // The clustering above splits one person into several when they laugh, shout or talk over someone.
  // Fold a voice into a bigger one it sounds like (0.7 and up was always the same person in tests, different people stayed under 0.4),
  // and fold scraps too short to be a participant into whichever voice is nearest. In a short recording ten seconds is a real share of the talking, so there a scrap is under a twentieth of it.
  const spoken = Object.values(voices).reduce((sum, v) => sum + v.seconds, 0);
  const scrap = Math.min(10, spoken / 20);
  const cosine = (x, y) => x.reduce((sum, v, i) => sum + v * y[i], 0);
  const kept = [];
  const into = {};
  for (const [speaker, voice] of Object.entries(voices).sort((x, y) => y[1].seconds - x[1].seconds)) {
    const near = kept.map((k) => ({ k, score: cosine(voice.vec, voices[k].vec) })).sort((x, y) => y.score - x.score)[0];
    if (near && (near.score >= 0.7 || voice.seconds < scrap)) into[speaker] = near.k;
    else kept.push(speaker);
  }
  for (const [speaker, target] of Object.entries(into)) {
    voices[target].seconds += voices[speaker].seconds;
    delete voices[speaker];
  }
  for (const seg of segments) if (seg.speaker in into) seg.speaker = Number(into[seg.speaker]);
  // Turns from speakers with no voiceprint at all (under two seconds) are dropped; the lines they covered take the nearest voice in time.
  process.send({ segments: segments.filter((seg) => voices[seg.speaker]), voices }, () => process.exit(0));
} catch (e) {
  process.send({ error: e.message }, () => process.exit(1));
}
