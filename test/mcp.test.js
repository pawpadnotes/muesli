// MCP server and stdio bridge self-test against three fake meetings: no Electron, no files.
// node test/mcp.test.js  — exits non-zero on the first failure.
const assert = require('assert');
const path = require('path');
const { spawn } = require('child_process');
const mcp = require('../src/mcp');
const notes = require('../src/notes');

const TOKEN = 'a'.repeat(32);
const day = (d) => new Date(Date.now() - d * 864e5).toISOString();
const result = (title, actions) => ({
  notes: { title, sections: [
    { heading: 'Summary', bullets: [{ text: `${title} went well.`, timestamp: '00:05' }] },
    { heading: 'Decisions', bullets: [{ text: 'Ship the pilot in May.', timestamp: '01:10' }] },
    { heading: 'Open questions', bullets: [{ text: 'Who signs the DPA?', timestamp: '' }] },
  ] },
  actions, email: 'Hi all,\nThanks.',
});
const MEETINGS = [
  { id: 'm1', title: 'Brightcart discovery', createdAt: day(1), durationSec: 1800, folder: 'Brightcart', people: 'Priya Shah', userNotes: 'pilot in May',
    result: result('Brightcart discovery', [{ task: 'Send the SOC 2 report', owner: 'Me', due: 'Friday' }, { task: 'Old task', owner: 'Priya', done: true }]),
    transcript: [{ from: 65000, to: 70000, speaker: 'Them', text: 'We want a pilot with Zendesk.' }] },
  { id: 'm2', title: 'Weekly pipeline sync', createdAt: day(3), durationSec: 900, folder: 'Team', people: 'Helen Park',
    result: result('Weekly pipeline sync', [{ task: 'Update the forecast', owner: 'Helen', due: '' }]),
    transcript: [{ from: 0, to: 4000, speaker: 'Me', text: 'Brightcart is close to signing.' }] },
  { id: 'm3', title: 'Northwind kickoff', createdAt: day(40), durationSec: 600, folder: 'Northwind', people: 'Sam Lee', userNotes: '',
    result: result('Northwind kickoff', [{ task: 'Book the onsite', owner: 'Sam', due: '' }]), transcript: [] },
];
const meetings = {
  list: () => MEETINGS.map(({ result: _r, transcript: _t, ...m }) => m),
  get: (id) => MEETINGS.find((m) => m.id === id) || null,
  search: (q) => MEETINGS.filter((m) => JSON.stringify(m).toLowerCase().includes(q.toLowerCase())).map(({ result: _r, transcript: _t, ...m }) => m),
};

let passed = 0;
const check = async (name, fn) => { await fn(); passed++; console.log(`ok  ${name}`); };

(async () => {
  const server = mcp.start({ meetings, notes, token: () => TOKEN, port: 0 });
  await new Promise((ok) => server.once('listening', ok));
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/mcp`;
  const auth = { Authorization: `Bearer ${TOKEN}` };
  let n = 0;
  const rpc = async (method, params) => {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...auth }, body: JSON.stringify({ jsonrpc: '2.0', id: ++n, method, params }) });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.ok(!body.error, JSON.stringify(body.error));
    return body.result;
  };
  const call = async (name, args = {}) => {
    const r = await rpc('tools/call', { name, arguments: args });
    assert.ok(!r.isError, r.content[0].text);
    return r;
  };

  await check('401 without a token', async () => {
    const res = await fetch(url, { method: 'POST', body: '{"jsonrpc":"2.0","id":1,"method":"ping"}' });
    assert.strictEqual(res.status, 401);
    const wrong = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${'b'.repeat(32)}` }, body: '{}' });
    assert.strictEqual(wrong.status, 401);
  });
  await check('403 from a web page origin', async () => {
    const res = await fetch(url, { method: 'POST', headers: { ...auth, Origin: 'https://evil.example' }, body: '{}' });
    assert.strictEqual(res.status, 403);
  });
  await check('initialize gives a session id and all capabilities', async () => {
    const res = await fetch(url, { method: 'POST', headers: { ...auth, 'MCP-Protocol-Version': '2025-06-18' }, body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18' } }) });
    assert.ok(res.headers.get('mcp-session-id'));
    assert.strictEqual(res.headers.get('mcp-protocol-version'), '2025-06-18');
    const { result: r } = await res.json();
    assert.strictEqual(r.protocolVersion, '2025-06-18');
    assert.ok(r.capabilities.tools);
  });
  await check('unknown protocol version is refused', async () => {
    const res = await fetch(url, { method: 'POST', headers: { ...auth, 'MCP-Protocol-Version': '1999-01-01' }, body: '{}' });
    assert.strictEqual(res.status, 400);
  });
  await check('notification gets 202', async () => {
    const res = await fetch(url, { method: 'POST', headers: auth, body: '{"jsonrpc":"2.0","method":"notifications/initialized"}' });
    assert.strictEqual(res.status, 202);
  });
  await check('tools/list has the three tools', async () => {
    const { tools } = await rpc('tools/list');
    assert.deepStrictEqual(tools.map((t) => t.name), ['list_meetings', 'search_meetings', 'get_meeting']);
  });
  await check('list_meetings pages and filters', async () => {
    let r = (await call('list_meetings', { limit: 2 })).structuredContent;
    assert.deepStrictEqual([r.meetings.map((m) => m.id), r.total, r.nextOffset], [['m1', 'm2'], 3, 2]);
    r = (await call('list_meetings', { offset: 2 })).structuredContent;
    assert.deepStrictEqual([r.meetings.map((m) => m.id), r.nextOffset], [['m3'], null]);
    assert.deepStrictEqual((await call('list_meetings', { folder: 'team' })).structuredContent.meetings.map((m) => m.id), ['m2']);
    assert.deepStrictEqual((await call('list_meetings', { person: 'priya' })).structuredContent.meetings.map((m) => m.id), ['m1']);
    assert.deepStrictEqual((await call('list_meetings', { from: day(10).slice(0, 10) })).structuredContent.total, 2);
    assert.deepStrictEqual((await call('list_meetings', { to: day(10).slice(0, 10) })).structuredContent.meetings.map((m) => m.id), ['m3']);
  });
  await check('search_meetings finds by transcript', async () => {
    assert.deepStrictEqual((await call('search_meetings', { query: 'zendesk' })).structuredContent.meetings.map((m) => m.id), ['m1']);
  });
  await check('get_meeting gives Markdown and structured notes', async () => {
    const r = await call('get_meeting', { id: 'm1' });
    assert.match(r.content[0].text, /# Brightcart discovery/);
    assert.match(r.content[0].text, /## Transcript\n\[01:05\] Them/);
    const s = r.structuredContent;
    assert.strictEqual(s.summary, 'Brightcart discovery went well.');
    assert.deepStrictEqual(s.decisions, ['Ship the pilot in May.']);
    assert.deepStrictEqual(s.openQuestions, ['Who signs the DPA?']);
    assert.strictEqual(s.actionItems.length, 2);
    assert.strictEqual(s.notes[0].heading, 'Summary');
    assert.strictEqual(s.userNotes, 'pilot in May');
    const missing = await rpc('tools/call', { name: 'get_meeting', arguments: { id: 'nope' } });
    assert.ok(missing.isError);
  });
  await check('GET opens an event stream', async () => {
    const ctrl = new AbortController();
    const res = await fetch(url, { headers: { ...auth, Accept: 'text/event-stream' }, signal: ctrl.signal });
    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/event-stream/);
    const { value } = await res.body.getReader().read();
    assert.match(Buffer.from(value).toString(), /^: open/);
    ctrl.abort();
  });
  await check('DELETE ends the session with 200', async () => {
    assert.strictEqual((await fetch(url, { method: 'DELETE', headers: auth })).status, 200);
  });

  const bridge = (port, lines) => new Promise((ok, fail) => {
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'mcp-stdio.js')], { env: { ...process.env, MUESLI_MCP_TOKEN: TOKEN, MUESLI_MCP_PORT: String(port) } });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', fail);
    child.on('close', () => ok(out.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))));
    child.stdin.end(lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  });
  await check('stdio bridge round trip', async () => {
    const out = await bridge(port, [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_meetings', arguments: { limit: 1 } } },
    ]);
    assert.strictEqual(out.length, 2);
    assert.strictEqual(out[0].result.serverInfo.name, 'muesli');
    assert.strictEqual(out[1].result.structuredContent.meetings[0].id, 'm1');
  });
  await check('stdio bridge says when Muesli is not running', async () => {
    const out = await bridge(1, [{ jsonrpc: '2.0', id: 7, method: 'ping' }]);
    assert.strictEqual(out[0].id, 7);
    assert.match(out[0].error.message, /Muesli is not running/);
  });

  server.close();
  console.log(`\n${passed} passed`);
})().catch((e) => {
  console.error(`FAIL  ${e.stack || e.message}`);
  process.exit(1);
});
