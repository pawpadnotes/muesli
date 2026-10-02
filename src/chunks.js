// A recording is transcribed in pieces of two to five minutes, cut where nobody is speaking.
// Each piece goes through the large model once, while the meeting is still running, so pressing Stop
// only has the last piece left to do. Pieces are independent: a failure, or Whisper getting stuck
// repeating itself, stays inside one piece and that piece alone is retried.
//   chunks.json  [{ from, to (samples), status: 'pending' | 'complete' | 'error', me: [], them: [] }]

const fs = require('fs');

const RATE = 16000;
const FRAME = RATE / 10; // loudness is measured every 100 ms
const MIN = 120 * RATE; // no cut before two minutes
const MAX = 300 * RATE; // and one at five minutes whatever happens
const PAUSE = 4; // frames of quiet that count as a pause (400 ms)

// Samples start..start+count of a recording that may still be growing. Audio not written yet reads as silence.
function readSamples(file, start, count) {
  const pcm = Buffer.alloc(count * 2);
  try {
    const fd = fs.openSync(file, 'r');
    fs.readSync(fd, pcm, 0, pcm.length, 44 + start * 2);
    fs.closeSync(fd);
  } catch {
    // a missing track is a silent one
  }
  return new Int16Array(pcm.buffer, pcm.byteOffset, count);
}

// How loud each 100 ms is, 0 to 1, taking the louder of the tracks.
function levels(tracks) {
  const frames = Math.floor(Math.max(...tracks.map((t) => t.length)) / FRAME);
  const out = new Float32Array(frames);
  for (const pcm of tracks) {
    for (let f = 0; f < frames; f++) {
      let sum = 0;
      for (let i = f * FRAME; i < (f + 1) * FRAME; i++) sum += (pcm[i] || 0) ** 2;
      out[f] = Math.max(out[f], Math.sqrt(sum / FRAME) / 32768);
    }
  }
  return out;
}

// Where to end the piece that starts at the beginning of these tracks, in samples. 0 means "not yet, keep recording".
// After two minutes the first pause wins. The noise floor follows the room, so a hissy microphone still has pauses.
// With no pause by five minutes, the quietest moment since the two-minute mark is used instead of cutting a word blindly.
function findCut(tracks, final) {
  const length = Math.max(...tracks.map((t) => t.length));
  if (final) return length;
  const level = levels(tracks);
  let floor = 0.01, quiet = 0;
  for (let f = 0; f < level.length; f++) {
    if (level[f] < floor * 1.5) floor = floor * 0.95 + level[f] * 0.05;
    quiet = level[f] < floor + 0.012 ? quiet + 1 : 0;
    const at = (f + 1) * FRAME;
    if (at >= MIN && quiet >= PAUSE) return at - (PAUSE / 2) * FRAME;
    if (at >= MAX) {
      let best = f, lowest = Infinity;
      for (let g = MIN / FRAME; g + PAUSE <= f + 1; g++) {
        const sum = level[g] + level[g + 1] + level[g + 2] + level[g + 3];
        if (sum < lowest) { lowest = sum; best = g; }
      }
      return (best + PAUSE / 2) * FRAME;
    }
  }
  return 0;
}

// Every piece's lines on the meeting's clock, in order.
const stitch = (chunks, track) => chunks.flatMap((c) => (c[track] || []).map((s) => ({ ...s, from: s.from + c.from / 16, to: s.to + c.from / 16 })));

module.exports = { RATE, MIN, MAX, readSamples, findCut, stitch };
