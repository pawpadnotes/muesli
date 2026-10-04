const http = require('http');
const crypto = require('crypto');

// A small MCP server (Streamable HTTP, JSON responses) so assistants such as Claude can read meetings.
// Off unless switched on in Settings, read-only, bound to this computer only, and every request needs the token.

const PORT = Number(process.env.MUESLI_MCP_PORT) || 3939;
const VERSIONS = ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'];
const LATEST = '2025-06-18';

const newToken = () => crypto.randomBytes(16).toString('hex');

const TOOLS = [
  {
    name: 'list_meetings',
    description: 'List meetings recorded in Muesli, newest first, with id, title, date, length, folder and people. Filter by folder, person or date range; page with offset.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'How many to return (default 20)' },
        offset: { type: 'number', description: 'How many to skip, for paging (default 0)' },
        folder: { type: 'string', description: 'Only meetings in this folder' },
        person: { type: 'string', description: 'Only meetings this person was in' },
        from: { type: 'string', description: 'ISO date: only meetings on or after it' },
        to: { type: 'string', description: 'ISO date: only meetings on or before it' },
      },
    },
  },
  {
    name: 'search_meetings',
    description: 'Find meetings whose title, notes or transcript contain the given text.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  },
  {
    name: 'get_meeting',
    description: 'Get one meeting: the finished notes, action items and follow-up email as Markdown, and optionally the full transcript.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, transcript: { type: 'boolean', description: 'Include the full transcript (default true)' } }, required: ['id'] },
  },
];

const has = (text, q) => String(text || '').toLowerCase().includes(q.toLowerCase());

// token: a function, so a regenerated token takes effect at once.
function start({ meetings, notes, token, port = PORT }) {
  const title = (m) => m.title || 'Untitled meeting';
  const brief = (m) => ({ id: m.id, title: title(m), date: m.createdAt, minutes: Math.round((m.durationSec || ((m.transcript || meetings.get(m.id)?.transcript || []).at(-1)?.to || 0) / 1000) / 60), folder: m.folder || '', people: m.people || '' });
  const people = (m) => [m.people, ...Object.values(m.speakers || {})].join(', ');
  const markdown = (m) => (m.result ? notes.toMarkdown(m, m.result) : `# ${title(m)}\n\n(No notes written yet.)`);
  const byId = (id) => {
    const m = meetings.get(String(id || '').replace(/[\\/]/g, ''));
    if (!m) throw new Error('No meeting has that id. Call list_meetings first.');
    return m;
  };
  const section = (r, re) => (r?.notes?.sections || []).filter((s) => re.test(s.heading)).flatMap((s) => s.bullets.map((b) => b.text));
  const result = (text, structuredContent) => ({ content: [{ type: 'text', text }], ...(structuredContent && { structuredContent }) });

  const tools = {
    list_meetings(args) {
      const all = meetings.list().filter((m) =>
        (!args.folder || (m.folder || '').toLowerCase() === String(args.folder).toLowerCase()) &&
        (!args.person || has(people(m), String(args.person))) &&
        (!args.from || m.createdAt.slice(0, String(args.from).length) >= args.from) &&
        (!args.to || m.createdAt.slice(0, String(args.to).length) <= args.to));
      const offset = Math.max(0, args.offset || 0);
      const page = all.slice(offset, offset + (args.limit || 20)).map(brief);
      const out = { meetings: page, total: all.length, nextOffset: offset + page.length < all.length ? offset + page.length : null };
      return result(JSON.stringify(out, null, 2), out);
    },
    search_meetings(args) {
      const out = meetings.search(String(args.query || '')).map(brief);
      return result(JSON.stringify(out, null, 2), { meetings: out });
    },
    get_meeting(args) {
      const m = byId(args.id);
      const r = m.result;
      const parts = [markdown(m)];
      if (r?.email) parts.push(`## Follow-up email\n${r.email}`);
      if (m.userNotes) parts.push(`## Rough notes typed during the meeting\n${m.userNotes}`);
      if (args.transcript !== false && m.transcript?.length) parts.push(`## Transcript\n${notes.formatTranscript(m.transcript)}`);
      return result(parts.join('\n\n'), {
        id: m.id, title: r?.notes?.title || title(m), date: m.createdAt, people: m.people || '', folder: m.folder || '',
        summary: section(r, /summary/i).join(' '),
        notes: (r?.notes?.sections || []).map((s) => ({ heading: s.heading, bullets: s.bullets.map((b) => b.text) })),
        actionItems: (r?.actions || []).map((a) => ({ task: a.task, owner: a.owner, due: a.due || '', done: !!a.done })),
        decisions: section(r, /decision/i), openQuestions: section(r, /open question/i),
        email: r?.email || '', userNotes: m.userNotes || '',
      });
    },
  };

  const answer = (msg) => {
    const ok = (res) => ({ jsonrpc: '2.0', id: msg.id, result: res });
    const fail = (code, message) => ({ jsonrpc: '2.0', id: msg.id, error: { code, message } });
    const p = msg.params || {};
    try {
      switch (msg.method) {
        case 'initialize':
          return ok({ protocolVersion: VERSIONS.includes(p.protocolVersion) ? p.protocolVersion : LATEST, capabilities: { tools: {} }, serverInfo: { name: 'muesli', version: '0.2.0' } });
        case 'ping':
          return ok({});
        case 'tools/list':
          return ok({ tools: TOOLS });
        case 'tools/call':
          if (!tools[p.name]) return fail(-32602, `Unknown tool: ${p.name}`);
          try {
            return ok(tools[p.name](p.arguments || {}));
          } catch (e) {
            return ok({ content: [{ type: 'text', text: e.message }], isError: true });
          }
        default:
          return fail(-32601, `Method not found: ${msg.method}`);
      }
    } catch (e) {
      return fail(-32602, e.message);
    }
  };

  const streams = new Set();
  const server = http.createServer((req, res) => {
    const send = (status, body, headers = {}) => {
      res.writeHead(status, { ...(body && { 'Content-Type': 'application/json' }), ...headers });
      res.end(body ? JSON.stringify(body) : undefined);
    };
    // A web page must not be able to reach this through the browser.
    const origin = req.headers.origin;
    if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return send(403);
    if (!req.url.startsWith('/mcp')) return send(404);
    // Every program on this computer can reach the port, so only one holding the token gets in.
    const want = token();
    const got = /^Bearer (.+)$/.exec(req.headers.authorization || '')?.[1] || '';
    if (!want || got.length !== want.length || !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want))) {
      return send(401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Missing or wrong token. Copy the setup again from Muesli Settings › Assistants.' } }, { 'WWW-Authenticate': 'Bearer' });
    }
    const version = req.headers['mcp-protocol-version'];
    if (version && !VERSIONS.includes(version)) return send(400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: `Unsupported MCP-Protocol-Version: ${version}` } });
    const echo = version ? { 'MCP-Protocol-Version': version } : {};

    if (req.method === 'DELETE') return send(200, null, echo);
    if (req.method === 'GET') {
      if (!/text\/event-stream/.test(req.headers.accept || '')) return send(405, null, { Allow: 'GET, POST, DELETE' });
      // Muesli never pushes anything, so the stream only carries a comment now and then to stay open.
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', ...echo });
      res.write(': open\n\n');
      const beat = setInterval(() => res.write(': keepalive\n\n'), 25000);
      streams.add(res);
      req.on('close', () => { clearInterval(beat); streams.delete(res); });
      return;
    }
    if (req.method !== 'POST') return send(405, null, { Allow: 'GET, POST, DELETE' });
    let raw = '';
    req.on('data', (d) => {
      raw += d;
      if (raw.length > 1e6) req.destroy();
    });
    req.on('end', () => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return send(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      }
      const list = Array.isArray(msg) ? msg : [msg];
      const headers = { ...echo, ...(list.some((m) => m.method === 'initialize') && { 'Mcp-Session-Id': crypto.randomUUID() }) };
      const replies = list.filter((m) => m.id !== undefined && m.method).map(answer);
      if (!replies.length) return send(202, null, headers); // notifications need no reply
      send(200, Array.isArray(msg) ? replies : replies[0], headers);
    });
  });
  server.on('error', () => {});
  // Closing also ends any open event streams, which would otherwise hold the port.
  const close = server.close.bind(server);
  server.close = (cb) => {
    for (const s of streams) s.end();
    close(cb);
    server.closeAllConnections();
  };
  server.listen(port, '127.0.0.1');
  return server;
}

module.exports = { start, newToken, PORT, url: `http://127.0.0.1:${PORT}/mcp` };
