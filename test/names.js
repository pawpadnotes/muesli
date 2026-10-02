// Run: node test/names.js
const assert = require('assert');
const { guess } = require('../src/names');
const t = (lines) => lines.map(([who, text]) => (who === 'Me' ? { speaker: 'Me', text } : { speaker: 'Them', voice: who, text }));

// Answers to the name twice: named.
let g = guess(t([['Me', 'Hi Priya, thanks for making time.'], [1, 'No problem.'], ['Me', 'So, Priya, what is the main issue?'], [1, 'Tickets, mostly.'], [2, 'And the contract.']]));
assert.deepStrictEqual(g.map((x) => [x.key, x.name]), [['1', 'Priya']]);

// Once is not routine.
assert.strictEqual(guess(t([['Me', 'Hi Priya, thanks.'], [1, 'No problem.'], ['Me', 'Go on.'], [1, 'Sure.']])).length, 0);

// Introduces themselves and answers once.
g = guess(t([[2, 'Dev here. The other problem is the contract.'], ['Me', 'Understood. What do you think, Dev?'], [2, 'It renews in December.']]));
assert.deepStrictEqual(g.map((x) => [x.key, x.name]), [['2', 'Dev']]);

// Two people on one voice: the evidence disagrees, so no name.
assert.strictEqual(guess(t([['Me', 'Hi Priya, thanks.'], [0, 'No problem.'], ['Me', 'Priya, go on.'], [0, 'Dev here. I have a point.'], ['Me', 'Thanks, Dev.'], [0, 'Sure.']])).length, 0);

// Whoever says the name is not that person.
assert.strictEqual(guess(t([[1, 'Marcus, can you cover that?'], ['Me', 'Sure.'], [1, 'Thanks, Marcus.'], ['Me', 'Welcome.']])).length, 0);

// Ordinary sentence openers are not names, and a voice that already has a name keeps it.
assert.strictEqual(guess(t([['Me', 'Great, thanks.'], [1, "I'm Sorry about that."], ['Me', 'Okay, sure.'], [1, 'Right.']])).length, 0);
assert.strictEqual(guess(t([['Me', 'Hi Priya, thanks.'], [1, 'Hi.'], ['Me', 'Priya, go on.'], [1, 'Sure.']]), { 1: 'Helen' }).length, 0);

console.log('names ok', guess(t([['Me', 'Hi Priya, thanks for making time.'], [1, 'No problem.'], ['Me', 'So, Priya, what is the main issue?'], [1, 'Tickets.'], ['Me', 'Priya, anything else?'], [1, 'No.']])));
