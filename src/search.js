// Search by meaning for "Ask your meetings". Each meeting's notes and transcript are cut into short passages and turned
// into vectors by a small embedding model in Ollama; a question then finds the passages closest in meaning, so
// "what did they say about cost" finds a meeting where everyone said "budget". The vectors are a plain file beside
// the meeting (vectors.json), rebuilt when the meeting changes. No database: a few hundred meetings are a few MB.
// Without the embedding model, everything returns null and Ask falls back to matching words.

const crypto = require('crypto');
const { OLLAMA } = require('./models');

// Chosen by test (out/embeval.js, 28 reworded questions over 8 meetings, some in Spanish and German): the most
// accurate of five, with the widest gap between right and wrong meetings, and about 2 s to index a meeting.
const MODEL = 'embeddinggemma';
const PASSAGE = 600; // characters per transcript passage

// Each embedding model was trained with its own wording in front of questions and passages; using it ranks better.
const PREFIX = (model) =>
  /^nomic/.test(model) ? { query: 'search_query: ', doc: 'search_document: ' }
  : /^qwen3-embedding/.test(model) ? { query: 'Instruct: Given a question about past meetings, retrieve passages that answer it\nQuery: ', doc: '' }
  : /^embeddinggemma/.test(model) ? { query: 'task: search result | query: ', doc: 'title: none | text: ' }
  : /^snowflake-arctic-embed/.test(model) ? { query: 'query: ', doc: '' }
  : { query: '', doc: '' };

async function embed(texts, kind) {
  const prefix = PREFIX(MODEL)[kind === 'query' ? 'query' : 'doc'];
  const input = texts.map((t) => prefix + t);
  try {
    const res = await fetch(`${OLLAMA}/api/embed`, { method: 'POST', body: JSON.stringify({ model: MODEL, input, truncate: true }), signal: AbortSignal.timeout(120000) });
    if (res.status === 404) fetchModel();
    if (!res.ok) return null;
    const { embeddings } = await res.json();
    return embeddings?.length === texts.length ? embeddings.map(unit) : null;
  } catch {
    return null;
  }
}

// The model is missing: download it quietly, once. Until it arrives Ask matches words, as before.
let fetching = false;
function fetchModel() {
  if (fetching) return;
  fetching = true;
  fetch(`${OLLAMA}/api/pull`, { method: 'POST', body: JSON.stringify({ model: MODEL, stream: false }) })
    .catch(() => {})
    .finally(() => { fetching = false; });
}

function unit(v) {
  const n = Math.hypot(...v) || 1;
  return v.map((x) => x / n);
}
const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);

// What a meeting says, as passages: each note line on its own, and the transcript in runs of a few lines.
function passagesOf(m) {
  const out = [];
  for (const s of m.result?.notes.sections || []) for (const b of s.bullets) out.push(`${s.heading}: ${b.text}`);
  for (const a of m.result?.actions || []) out.push(`Action item: ${a.task} (${a.owner}${a.due ? `, due ${a.due}` : ''})`);
  if (m.userNotes?.trim()) out.push(m.userNotes.trim().slice(0, PASSAGE * 2));
  let run = '';
  for (const seg of m.transcript || []) {
    const line = `${seg.speaker === 'Me' ? 'Me' : 'Them'}: ${seg.text}`;
    if (run && run.length + line.length > PASSAGE) {
      out.push(run);
      run = '';
    }
    run += (run ? '\n' : '') + line;
  }
  if (run) out.push(run);
  return out;
}

// meetings: the store module. Returns the meeting's passages with vectors, building or rebuilding them when needed.
async function vectorsFor(meetings, m) {
  const texts = passagesOf(m);
  if (!texts.length) return [];
  const hash = crypto.createHash('sha1').update(texts.join('\u0000')).digest('hex');
  const saved = meetings.read(m.id, 'vectors.json');
  if (saved?.model === MODEL && saved.hash === hash) return saved.passages;
  const vectors = [];
  for (let i = 0; i < texts.length; i += 32) {
    const batch = await embed(texts.slice(i, i + 32), 'document');
    if (!batch) return null;
    vectors.push(...batch);
  }
  const list = texts.map((text, i) => ({ text, v: vectors[i].map((x) => Math.round(x * 1e4) / 1e4) }));
  meetings.write(m.id, 'vectors.json', { model: MODEL, hash, passages: list });
  return list;
}

// For each meeting: how close its best passages come to the question, and those passages.
// Returns null when the embedding model is not available.
async function rank(meetings, all, question) {
  const [q] = (await embed([question], 'query')) || [];
  if (!q) return null;
  const out = new Map();
  for (const m of all) {
    const list = await vectorsFor(meetings, m);
    if (list === null) return null;
    const scored = list.map((p) => ({ text: p.text, score: dot(q, p.v) })).sort((a, b) => b.score - a.score);
    // A meeting is as relevant as its best few passages, so one stray match does not outrank a whole discussion.
    const top = scored.slice(0, 3);
    out.set(m.id, { score: top.length ? top.reduce((s, p) => s + p.score, 0) / top.length : 0, passages: top.filter((p) => p.score > 0.35).map((p) => p.text) });
  }
  return out;
}

// Build vectors ahead of time (after a meeting's notes are written), so the first question is fast.
async function index(meetings, m) {
  await vectorsFor(meetings, m);
}

module.exports = { rank, index, MODEL, PREFIX, passagesOf };
