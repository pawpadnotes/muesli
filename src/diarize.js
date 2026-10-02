// Runs in its own process (forked by main) so a long recording never freezes the window.
// usage: diarize.js <wav> <model dir>  ->  sends [{ start, end, speaker }] (seconds) to the parent

const path = require('path');

const [wav, dir] = process.argv.slice(2);
try {
  const sherpa = require('sherpa-onnx-node');
  const sd = new sherpa.OfflineSpeakerDiarization({
    segmentation: { pyannote: { model: path.join(dir, 'segmentation.onnx') } },
    embedding: { model: path.join(dir, 'nemo_en_titanet_small.onnx') },
    // -1 lets it work out how many people spoke; 0.6 kept two test voices apart without splitting either
    clustering: { numClusters: -1, threshold: 0.6 },
    minDurationOn: 0.3,
    minDurationOff: 0.5,
  });
  // Muesli's own recordings: 16-bit mono after a 44-byte header. Read here because Electron refuses the library's external buffers.
  const pcm = require('fs').readFileSync(wav).subarray(44);
  const samples = new Float32Array(pcm.length >> 1);
  for (let i = 0; i < samples.length; i++) samples[i] = pcm.readInt16LE(i * 2) / 32768;
  process.send({ segments: sd.process(samples) }, () => process.exit(0));
} catch (e) {
  process.send({ error: e.message }, () => process.exit(1));
}
