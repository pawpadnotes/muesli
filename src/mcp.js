const http = require('http');

// A small MCP server (Streamable HTTP, JSON responses) so assistants such as Claude can read meetings.
// Off unless switched on in Settings, read-only, and bound to this computer only.

const PORT = 3939;

const TOOLS = [
  {
    name: 'list_meetings',
    description: 'List meetings recorded in Muesli, newest first, with id, title, date and length.',
    inputSchema: { type: 'object', properties: { limit: { type: 'number', description: 'How many to return (default 20)' } } },
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

function start({ meetings, notes }) {
  const brief = (m) => ({ id: m.id, title: m.title || 'Untitled meeting', date: m.createdAt, minutes: Math.round((m.durationSec || 0) / 60) });

  const callTool = (name, args = {}) => {
    if (name === 'list_meetings') return JSON.stringify(meetings.list().slice(0, args.limit || 20).map(brief), null, 2);
    if (name === 'search_meetings') return JSON.stringify(meetings.search(String(args.query || '')).map(brief), null, 2);
    if (name === 'get_meeting') {
      const m = meetings.get(String(args.id || '').replace(/[\\/]/g, ''));
      if (!m) throw new Error('No meeting has that id. Call list_meetings first.');
      const parts = [m.result ? notes.toMarkdown(m, m.result) : `# ${m.title || 'Untitled meeting'}\n\n(No notes written yet.)`];
      if (m.result?.email) parts.push(`## Follow-up email\n${m.result.email}`);
      if (m.userNotes) parts.push(`## Rough notes typed during the meeting\n${m.userNotes}`);
      if (args.transcript !== false && m.transcript.length) parts.push(`## Transcript\n${notes.formatTranscript(m.transcript)}`);
      return parts.join('\n\n');
    }
    throw new Error(`Unknown tool: ${name}`);
  };

  const answer = (msg) => {
    const ok = (result) => ({ jsonrpc: '2.0', id: msg.id, result });
    switch (msg.method) {
      case 'initialize':
        return ok({ protocolVersion: msg.params?.protocolVersion || '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'muesli', version: '0.1.0' } });
      case 'ping':
        return ok({});
      case 'tools/list':
        return ok({ tools: TOOLS });
      case 'tools/call':
        try {
          return ok({ content: [{ type: 'text', text: callTool(msg.params?.name, msg.params?.arguments) }] });
        } catch (e) {
          return ok({ content: [{ type: 'text', text: e.message }], isError: true });
        }
      default:
        return { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } };
    }
  };

  const server = http.createServer((req, res) => {
    const send = (status, body) => {
      res.writeHead(status, body ? { 'Content-Type': 'application/json' } : {});
      res.end(body ? JSON.stringify(body) : undefined);
    };
    // A web page must not be able to reach this through the browser.
    const origin = req.headers.origin;
    if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return send(403);
    if (!req.url.startsWith('/mcp')) return send(404);
    if (req.method !== 'POST') return send(405);
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
      const replies = list.filter((m) => m.id !== undefined && m.method).map(answer);
      if (!replies.length) return send(202); // notifications need no reply
      send(200, Array.isArray(msg) ? replies : replies[0]);
    });
  });
  server.on('error', () => {});
  server.listen(PORT, '127.0.0.1');
  return server;
}

module.exports = { start, PORT, url: `http://127.0.0.1:${PORT}/mcp` };
