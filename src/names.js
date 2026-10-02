// Works out who a voice is from the conversation itself, with no model involved.
//   - Somebody says a name and that voice answers next: one point each time.
//   - The voice introduces itself ("I'm Priya", "Dev here"): three points.
//   - The voice calls somebody else by that name: it is not theirs, two points off.
// A name is given only when the evidence is repeated and nearly all of it points one way.

const NAME = "(\\p{Lu}\\p{Ll}{1,14})";
// Capitalised words that start a sentence or follow "I'm" without being anybody's name.
const NOT_NAMES = new Set(('I Im Ok Okay Yes Yeah Yep No Nope Thanks Thank Great Sure Hi Hello Hey So Well And But Right Sorry Good Morning Afternoon Evening '
  + 'Monday Tuesday Wednesday Thursday Friday Saturday Sunday January February March April May June July August September October November December '
  + 'Now Then Also Just Actually Honestly Basically Look Listen Please Alright Fine Cool Nice Perfect Exactly Absolutely Definitely Maybe Still Here There '
  + 'God Team Everyone Everybody Guys Folks All Sir Madam Not Very Really Glad Happy Going Gonna Trying Looking Thinking Wondering Calling Afraid Curious Excited Aware').split(' '));

const SELF = [new RegExp(`\\b(?:I'm|I am|[Mm]y name is|[Mm]y name's)\\s+${NAME}\\b`, 'gu'), new RegExp(`(?:^|[.?!]\\s+)${NAME} here\\b`, 'gu')];
const CALLED = [
  // "Marcus, do you want to...", "Hi Priya, thanks...", "Thanks, Dev."
  new RegExp(`(?:^|[.?!]\\s+)(?:(?:Hi|Hey|Hello|Thanks|Thank you|Okay|OK|So|And|Yes|Yeah|No|Right|Sorry|Well|Great|Sure|Morning|Good morning),?\\s+)?${NAME}[,.!?]`, 'gu'),
  // "What do you think, Dev?"
  new RegExp(`,\\s+${NAME}[.?!]`, 'gu'),
];
const found = (text, patterns) => [...new Set(patterns.flatMap((re) => [...text.matchAll(re)].map((m) => m[1])).filter((n) => !NOT_NAMES.has(n)))];

const LEAST = 0.6; // how sure Muesli has to be before it writes a name

// transcript: [{ speaker: 'Me' | 'Them', voice?, text }]; named: { voice key: name } already known.
// Returns [{ key, name, confidence, why }] for voices on the other side that have no name yet.
function guess(transcript, named = {}) {
  const keyOf = (s) => (s.speaker === 'Me' ? 'me' : String(s.voice || 0));
  const points = {}; // key -> name -> { score, said, answered }
  const at = (key, name) => ((points[key] ||= {})[name] ||= { score: 0, said: 0, answered: 0 });
  transcript.forEach((line, i) => {
    const key = keyOf(line);
    for (const name of found(line.text, SELF)) { at(key, name).score += 3; at(key, name).said++; }
    for (const name of found(line.text, CALLED)) {
      at(key, name).score -= 2;
      // Whoever speaks next, if it is somebody else, is answering to the name.
      const next = transcript[i + 1];
      if (next && keyOf(next) !== key) { at(keyOf(next), name).score++; at(keyOf(next), name).answered++; }
    }
  });
  const taken = new Set(Object.values(named).filter(Boolean));
  const out = [];
  for (const [key, names] of Object.entries(points)) {
    if (key === 'me' || named[key]) continue;
    const [name, best] = Object.entries(names).sort((a, b) => b[1].score - a[1].score)[0];
    if (best.score < 2 || taken.has(name)) continue;
    // Everything that argues against it: the same name on another voice, other names on this voice.
    const sum = (list) => list.reduce((n, p) => n + Math.max(0, p.score), 0);
    const against = sum(Object.entries(points).filter(([k]) => k !== key).map(([, n]) => n[name]).filter(Boolean)) + sum(Object.entries(names).filter(([n]) => n !== name).map(([, p]) => p));
    const confidence = (best.score / (best.score + against)) * (1 - 1 / (best.score + 1));
    if (confidence < LEAST) continue;
    const why = [best.said && `introduced themselves as ${name}`, best.answered && `answered to “${name}” ${best.answered === 1 ? 'once' : `${best.answered} times`}`].filter(Boolean).join(' and ');
    out.push({ key, name, confidence: Math.round(confidence * 100) / 100, why });
  }
  // One name, one voice: the surer guess keeps it.
  out.sort((a, b) => b.confidence - a.confidence);
  return out.filter((g, i) => out.findIndex((o) => o.name === g.name) === i);
}

module.exports = { guess, LEAST };
