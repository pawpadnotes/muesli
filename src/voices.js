// Voice profiles: Muesli remembers what named people sound like, so the next meeting labels them by itself.
// A profile is a handful of numbers per recording (a voiceprint), never audio. It stays in one file on this computer.
//   voices.json  { people: { name: [{ meeting, vec, seconds }] } }
// Your own profile ("You") builds itself from the microphone side of calls. Others are learned when you name a voice.

const fs = require('fs');

const YOU = 'You';
const KEEP = 12; // newest recordings kept per person
const MIN_SECONDS = 8; // shorter than this and a voiceprint is confident and wrong
// Cosine similarity on this embedding model, measured: one speaker across three separate recordings scored 0.85 to 0.87, different people 0.32 and under.
// The bar sits well below the first figure because a laptop microphone on a call is rougher than those recordings were.
const MATCH = 0.58;
const MARGIN = 0.06; // and the best fit must beat the runner-up by this much
const AGREE = 0.45; // a person's recordings must sound like each other, or one of them was mislabelled

let file;
const setFile = (f) => { file = f; };
const load = () => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')).people || {};
  } catch {
    return {};
  }
};
const save = (people) => fs.writeFileSync(file, JSON.stringify({ people }));

const cosine = (a, b) => a.reduce((sum, x, i) => sum + x * b[i], 0);
const unit = (v) => {
  const n = Math.hypot(...v) || 1;
  return v.map((x) => x / n);
};
// Longer recordings count for more.
const centroid = (samples) => unit(samples[0].vec.map((_, i) => samples.reduce((sum, s) => sum + s.vec[i] * Math.min(s.seconds, 120), 0)));

// A profile is used only if its recordings agree with each other. One wrong click drags the agreement down and switches it off.
function usable(samples) {
  if (samples.length < 2) return samples.length === 1;
  let sum = 0, pairs = 0;
  for (let i = 0; i < samples.length; i++) for (let j = i + 1; j < samples.length; j++) { sum += cosine(samples[i].vec, samples[j].vec); pairs++; }
  return sum / pairs >= AGREE;
}

// Who a voiceprint belongs to, or null. Unsure is null: a missing name is better than a wrong one.
function match(vec, seconds = MIN_SECONDS) {
  if (!vec || seconds < MIN_SECONDS) return null;
  const scores = Object.entries(load()).filter(([, samples]) => usable(samples))
    .map(([name, samples]) => ({ name, score: cosine(vec, centroid(samples)) }))
    .sort((a, b) => b.score - a.score);
  const [best, next] = scores;
  return best && best.score >= MATCH && (!next || best.score - next.score >= MARGIN) ? best : null;
}

// Record that this voice in this meeting is this person. Naming the same voice again moves it.
function learn(name, meeting, voice) {
  const people = load();
  for (const [who, samples] of Object.entries(people)) {
    people[who] = samples.filter((s) => s.meeting !== meeting.id || s.key !== meeting.key);
    if (!people[who].length) delete people[who];
  }
  name = /^(me|you|myself)$/i.test(name.trim()) ? YOU : name.trim();
  if (name && voice?.vec && voice.seconds >= MIN_SECONDS) {
    people[name] = [...(people[name] || []), { meeting: meeting.id, key: meeting.key, vec: voice.vec, seconds: Math.round(voice.seconds) }].slice(-KEEP);
  }
  save(people);
}

const forget = (name) => {
  const people = load();
  delete people[name];
  save(people);
};

const list = () => Object.entries(load()).map(([name, samples]) => ({ name, recordings: samples.length, usable: usable(samples) }))
  .sort((a, b) => (b.name === YOU) - (a.name === YOU) || a.name.localeCompare(b.name));

module.exports = { YOU, setFile, match, learn, forget, list };
