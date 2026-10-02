// A scripted sales call used to compare notes models. Run: node test/sample-meeting.js [model] [numCtx] [chunked]
const { generate, toMarkdown } = require('../src/notes');

const meeting = require('../src/sample');

const [model = 'qwen3.5:9b', numCtx = '16384', chunked] = process.argv.slice(2);

generate(meeting, { model, numCtx: Number(numCtx), chunked: chunked === 'chunked' }, (p) => p.token || console.error(`... ${p.step}`)).then((r) => {
  console.log(toMarkdown(meeting, r));
  console.log('--- bullets from my notes:', r.notes.sections.flatMap((s) => s.bullets).filter((b) => b.from_my_notes).length, 'of', r.notes.sections.flatMap((s) => s.bullets).length);
  console.log('--- email ---\n' + r.email);
  console.log('--- stats ---');
  console.table(r.stats);
});
