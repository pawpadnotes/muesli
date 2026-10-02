// Your words: the names, acronyms and jargon a general speech model gets wrong.
//   words.json  { terms: [term], fixes: [{ heard, meant }], never: [{ from, to }], packs: [name] }
// Three layers, in the order they run:
//   1. Before transcription, a short list of terms is shown to Whisper so it spells them your way.
//   2. After it, "heard => meant" fixes are applied as whole words.
//   3. Then a sound-alike pass: a word that is not ordinary English and sounds like one of your terms becomes that term.
// Every automatic change is recorded on the line it happened in, so it can be shown, undone and banned.

const fs = require('fs');

const PACKS = require('./packs.json');
const PROMPT_BUDGET = 700; // characters; Whisper reads about 224 tokens of prompt and ignores the rest

let file = null;
let cache = null;
let common = null; // ordinary English words, read from the speech model itself

const setFile = (f) => { file = f; cache = null; };

function load() {
  if (!cache) {
    try {
      cache = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      cache = {};
    }
    cache = { terms: cache.terms || [], fixes: cache.fixes || [], never: cache.never || [], packs: cache.packs || [] };
  }
  return cache;
}
const save = () => fs.writeFileSync(file, JSON.stringify(cache, null, 2));
const same = (a, b) => a.toLowerCase() === b.toLowerCase();

// Whisper's own vocabulary holds about 24,000 whole English words: the common ones. Anything else is a name, jargon or a mishearing.
// Reading it from the model file means no word list to ship and nothing to download.
function useModel(modelFile) {
  if (common) return;
  common = new Set();
  try {
    const fd = fs.openSync(modelFile, 'r');
    const b = Buffer.alloc(4 << 20);
    fs.readSync(fd, b, 0, b.length, 0);
    fs.closeSync(fd);
    let o = 4 + 11 * 4;
    o += 8 + b.readInt32LE(o) * b.readInt32LE(o + 4) * 4;
    const count = b.readInt32LE(o);
    o += 4;
    for (let i = 0; i < count && o < b.length - 4; i++) {
      const length = b.readUInt32LE(o);
      const token = b.toString('utf8', o + 4, o + 4 + length);
      o += 4 + length;
      if (/^ [a-z]+$/i.test(token)) common.add(token.slice(1).toLowerCase());
    }
  } catch {
    // without the list the sound-alike pass stays off (see ordinary)
  }
}
// "renews" and "fitting" count as ordinary when their stem is.
function ordinary(word) {
  if (!common?.size) return true;
  const w = word.toLowerCase();
  if (common.has(w)) return true;
  for (const end of ['s', 'es', 'ed', 'd', 'ing', 'ly', 'er', "'s"]) {
    if (!w.endsWith(end)) continue;
    const stem = w.slice(0, -end.length);
    if (stem.length >= 3 && (common.has(stem) || common.has(`${stem}e`) || (stem[stem.length - 1] === stem[stem.length - 2] && common.has(stem.slice(0, -1))))) return true;
  }
  return false;
}

// Every term Muesli knows: yours first, then the packs you switched on.
function allTerms() {
  const w = load();
  const seen = new Set();
  const out = [];
  for (const term of [...w.fixes.map((f) => f.meant), ...w.terms, ...w.packs.flatMap((p) => PACKS[p]?.terms || [])]) {
    if (!seen.has(term.toLowerCase())) out.push(term);
    seen.add(term.toLowerCase());
  }
  return out;
}

// The list shown to Whisper. It is filled in order of how likely each term is to be said, until the budget runs out:
// your own words, then names and terms from this meeting (title, people), then pack terms you have actually said before, then the rest.
// A misheard form is never included; that would teach Whisper the mistake.
function prompt({ context = '', said = '' } = {}) {
  const w = load();
  const mine = [...w.fixes.map((f) => f.meant), ...w.terms].reverse(); // newest first
  const names = context.split(/[,;\n]| and /).map((s) => s.trim()).filter((s) => s && s.length <= 40 && /[A-Z]/.test(s) && s.split(' ').some((part) => !ordinary(part)));
  const packTerms = w.packs.flatMap((p) => PACKS[p]?.terms || []);
  const history = said.toLowerCase();
  const spoken = packTerms.filter((t) => history.includes(t.toLowerCase()));
  // The rest take turns across packs, so one long pack does not use the whole budget.
  const lists = w.packs.map((p) => [...(PACKS[p]?.terms || [])]);
  const rest = [];
  while (lists.some((l) => l.length)) for (const l of lists) if (l.length) rest.push(l.shift());

  const out = [];
  const seen = new Set();
  let size = 0;
  for (const term of [...mine, ...names, ...spoken, ...rest]) {
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    if (size + term.length + 2 > PROMPT_BUDGET) break;
    seen.add(key);
    out.push(term);
    size += term.length + 2;
  }
  return out.join(', ');
}

// ---------- sound-alike matching ----------

// A rough code for how a word sounds: vowels dropped, letters that sound alike merged.
function sound(word) {
  const w = word.toLowerCase().replace(/[^a-z]/g, '')
    .replace(/^kn|^gn|^pn|^wr/, (m) => m[1]).replace(/ph/g, 'f').replace(/ck/g, 'k').replace(/sch/g, 'sk').replace(/[ct]i(?=[ao])/g, 'sh').replace(/gh/g, '').replace(/c(?=[eiy])/g, 's').replace(/qu/g, 'kw');
  let code = w[0] || '';
  const group = { b: 'p', p: 'p', f: 'f', v: 'f', c: 'k', g: 'k', k: 'k', q: 'k', j: 'j', s: 's', z: 's', x: 'ks', d: 't', t: 't', l: 'l', m: 'm', n: 'm', r: 'r' };
  for (const ch of w.slice(1)) {
    const g = group[ch];
    if (g && !code.endsWith(g)) code += g;
  }
  return code;
}
function distance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const keep = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = keep;
    }
  }
  return row[b.length];
}
// How sure we are that `heard` is a mangled `term`, 0 to 1. The spelling must be close and the sound closer.
function confidence(heard, term) {
  const a = heard.toLowerCase().replace(/[^a-z]/g, ''), b = term.toLowerCase().replace(/[^a-z]/g, '');
  const longer = Math.max(a.length, b.length);
  const d = distance(a, b);
  if (d > 6 || d > longer * 0.45) return 0;
  const sa = sound(a), sb = sound(b);
  const soundGap = distance(sa, sb) / Math.max(sa.length, sb.length, 1);
  if (soundGap > 0.34) return 0;
  return 1 - d / longer - soundGap * 0.3 + (a[0] === b[0] ? 0.05 : 0);
}

// Capitals follow what was heard unless the term has its own ("Zendesk", "EBITDA").
const cased = (original, to) => (to === to.toLowerCase() && /^[A-Z]/.test(original) ? to[0].toUpperCase() + to.slice(1) : to);

// text -> { text, changes: [{ from, to, why: 'fix' | 'sound' }] }
// Changes are found against the original text and applied in one go, so one layer never shifts another's positions.
function correct(text) {
  const w = load();
  const banned = (from, to) => w.never.some((n) => same(n.from, from) && same(n.to, to));
  const edits = []; // { at, length, from, to, why }
  const free = (at, length) => !edits.some((e) => at < e.at + e.length && e.at < at + length);

  // Your fixes: whole words, any case, longest phrase first so "zen desk" wins over "zen".
  for (const fix of [...w.fixes].sort((a, b) => b.heard.length - a.heard.length)) {
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${fix.heard.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '[\\s-]+')}(?![\\p{L}\\p{N}])`, 'giu');
    for (const m of text.matchAll(re)) {
      const to = cased(m[0], fix.meant);
      if (m[0] !== to && free(m.index, m[0].length) && !banned(m[0], fix.meant)) edits.push({ at: m.index, length: m[0].length, from: m[0], to, why: 'fix' });
    }
  }

  // Capitals: "ebitda" becomes "EBITDA". Skipped when the small-letter form is an everyday word ("safe" is not always a SAFE).
  for (const term of allTerms().filter((t) => t !== t.toLowerCase() && !/\s/.test(t) && !ordinary(t))) {
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'giu');
    for (const m of text.matchAll(re)) if (m[0] !== term && free(m.index, m[0].length) && !banned(m[0], term)) edits.push({ at: m.index, length: m[0].length, from: m[0], to: term, why: 'case' });
  }

  // Sound-alikes: only words of four letters or more, with no digits, that are not ordinary English and not already a term.
  const terms = allTerms();
  const single = terms.filter((t) => !/\s/.test(t) && t.length >= 4);
  if (single.length) {
    const known = new Set(terms.flatMap((t) => t.toLowerCase().split(/\s+/)));
    for (const m of text.matchAll(/[\p{L}][\p{L}'’-]{3,}/gu)) {
      const word = m[0];
      if (known.has(word.toLowerCase()) || ordinary(word) || !free(m.index, word.length)) continue;
      const ranked = single.map((term) => ({ term, score: confidence(word, term) })).filter((c) => c.score > 0).sort((a, b) => b.score - a.score);
      const [best, next] = ranked;
      // It must be a confident match and clearly better than the runner-up.
      if (!best || best.score < 0.75 || (next && best.score - next.score < 0.1) || banned(word, best.term)) continue;
      edits.push({ at: m.index, length: word.length, from: word, to: best.term, why: 'sound' });
    }
  }

  let out = text;
  for (const e of edits.sort((a, b) => b.at - a.at)) out = out.slice(0, e.at) + e.to + out.slice(e.at + e.length);
  return { text: out, changes: edits.reverse().map(({ from, to, why }) => ({ from, to, why })) };
}

// ---------- what the user teaches ----------

function addTerm(term) {
  const w = load();
  term = term.trim().replace(/\s+/g, ' ');
  if (!term || term.length > 80) return { error: 'Type a word or short phrase.' };
  if (!w.terms.some((t) => same(t, term))) w.terms.push(term);
  save();
  return { ok: true };
}
function addFix(heard, meant) {
  const w = load();
  heard = heard.trim().replace(/\s+/g, ' ');
  meant = meant.trim().replace(/\s+/g, ' ');
  if (!heard || !meant || heard.length > 80 || meant.length > 80) return { error: 'Type a word or short phrase.' };
  if (heard === meant) return { error: 'That is what Muesli heard.' };
  // An everyday word cannot be rewritten every time: "fitting" to "feeding" would change every honest "fitting" from then on.
  // The correct word is still remembered, so Whisper leans towards it.
  // (Several words together, like "zen desk", are specific enough to be safe.)
  if (same(heard, meant) || (!heard.includes(' ') && ordinary(heard))) {
    const everyday = !same(heard, meant);
    if (!w.terms.some((t) => same(t, meant))) w.terms.push(meant);
    save();
    return { ok: true, termOnly: everyday };
  }
  w.fixes = w.fixes.filter((f) => !same(f.heard, heard));
  w.fixes.push({ heard, meant });
  w.never = w.never.filter((n) => !(same(n.from, heard) && same(n.to, meant)));
  save();
  return { ok: true };
}
function remove({ term, heard }) {
  const w = load();
  if (term) w.terms = w.terms.filter((t) => !same(t, term));
  if (heard) w.fixes = w.fixes.filter((f) => !same(f.heard, heard));
  save();
}
// "Never change this again": the pair is banned, and a fix that produced it is dropped.
function never(from, to) {
  const w = load();
  if (!w.never.some((n) => same(n.from, from) && same(n.to, to))) w.never.push({ from, to });
  w.fixes = w.fixes.filter((f) => !(same(f.heard, from) && same(f.meant, to)));
  save();
}
function setPack(name, on) {
  const w = load();
  w.packs = w.packs.filter((p) => p !== name);
  if (on && PACKS[name]) w.packs.push(name);
  save();
}

const list = () => {
  const w = load();
  return { terms: w.terms, fixes: w.fixes, never: w.never, packs: Object.entries(PACKS).map(([name, p]) => ({ name, about: p.about, count: p.terms.length, on: w.packs.includes(name) })) };
};

// Replace in a line of transcript, whole words only, capitals following the original.
function replaceAll(text, heard, meant) {
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${heard.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')}(?![\\p{L}\\p{N}])`, 'giu');
  return text.replace(re, (m) => cased(m, meant));
}

module.exports = { setFile, useModel, prompt, correct, addTerm, addFix, remove, never, setPack, list, replaceAll, ordinary, confidence };
