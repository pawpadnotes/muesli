const fs = require('fs');
const path = require('path');

// One folder per meeting, all plain files:
//   meeting.json  title, template, rough notes, timestamps
//   me.wav / them.wav
//   transcript.json  merged, speaker-labelled segments
//   notes.json / notes.md  generated notes, action items, email

let root;
const setRoot = (dir) => {
  root = dir;
  fs.mkdirSync(root, { recursive: true });
};
const dirOf = (id) => path.join(root, id);
const read = (id, file) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(dirOf(id), file), 'utf8'));
  } catch {
    return null;
  }
};
const write = (id, file, data) => fs.writeFileSync(path.join(dirOf(id), file), typeof data === 'string' ? data : JSON.stringify(data, null, 2));

function create(fields = {}) {
  const id = new Date().toISOString().replace(/[:.]/g, '-');
  fs.mkdirSync(dirOf(id), { recursive: true });
  const meeting = { id, title: '', template: 'general', userNotes: '', createdAt: new Date().toISOString(), durationSec: 0, ...fields };
  write(id, 'meeting.json', meeting);
  return meeting;
}

function update(id, fields) {
  const meeting = { ...read(id, 'meeting.json'), ...fields };
  write(id, 'meeting.json', meeting);
  return meeting;
}

function get(id) {
  const meeting = read(id, 'meeting.json');
  if (!meeting) return null;
  return { ...meeting, transcript: read(id, 'transcript.json') || [], result: read(id, 'notes.json') };
}

function list() {
  return fs.readdirSync(root)
    .map((id) => read(id, 'meeting.json'))
    .filter(Boolean)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function search(query) {
  const q = query.toLowerCase();
  return list().filter((m) => {
    const hay = [m.title, m.userNotes, fs.existsSync(path.join(dirOf(m.id), 'notes.md')) ? fs.readFileSync(path.join(dirOf(m.id), 'notes.md'), 'utf8') : '',
      (read(m.id, 'transcript.json') || []).map((s) => s.text).join(' ')].join(' ').toLowerCase();
    return hay.includes(q);
  });
}

const words = (t) => new Set(t.toLowerCase().replace(/[^a-z0-9 ]/g, '').split(/\s+/).filter(Boolean));

// Without headphones the mic hears the speakers, so "Me" repeats what "Them" said.
// Drop a mic segment when it overlaps a system segment in time and mostly shares its words.
function isEcho(me, them) {
  const mine = words(me.text);
  if (!mine.size) return true;
  return them.some((t) => {
    if (t.to < me.from - 2000 || t.from > me.to + 2000) return false;
    const theirs = words(t.text);
    let shared = 0;
    for (const w of mine) if (theirs.has(w)) shared++;
    return shared / mine.size >= 0.6;
  });
}

function mergeTracks(me, them) {
  const mine = me.filter((s) => !isEcho(s, them)).map((s) => ({ ...s, speaker: 'Me' }));
  const theirs = them.map((s) => ({ ...s, speaker: 'Them' }));
  return [...mine, ...theirs].sort((a, b) => a.from - b.from);
}

module.exports = { setRoot, dirOf, create, update, get, list, search, write, mergeTracks };
