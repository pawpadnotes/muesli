// The "interrupted recording" rule: audio with no transcript, until a transcription pass has run.
const assert = require('assert');
const { isUnfinished } = require('../src/meetings.js');
assert.equal(isUnfinished({ audioSec: 11, transcript: [] }), true, 'audio, never transcribed');
assert.equal(isUnfinished({ audioSec: 11, transcript: [], transcribed: true }), false, 'silence that was transcribed');
assert.equal(isUnfinished({ audioSec: 3, transcript: [] }), false, 'too short to count');
assert.equal(isUnfinished({ audioSec: 11, transcript: [{ text: 'hi' }] }), false, 'has a transcript');
console.log('4 meetings checks passed');
