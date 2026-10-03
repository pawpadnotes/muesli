// A stand-in for Anthropic's Messages API, for self-tests without a key or a network.
// node test/mock-anthropic.js [port]  — answers /v1/models and /v1/messages (plain or streaming); JSON when the system prompt asks for it.
const http = require('http');
const { reply } = require('./mock-openai');
const port = Number(process.argv[2] || 8766);
const fail = (res, status, type, message) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ type: 'error', error: { type, message } })); };
const server = http.createServer((req, res) => {
  if (!req.headers['x-api-key']) return fail(res, 401, 'authentication_error', 'x-api-key header is required');
  if (!req.headers['anthropic-version']) return fail(res, 400, 'invalid_request_error', 'anthropic-version header is required');
  if (req.method === 'GET' && req.url.startsWith('/v1/models')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ data: [{ type: 'model', id: 'claude-mock-large', display_name: 'Claude Mock Large', created_at: '2026-01-01T00:00:00Z' }, { type: 'model', id: 'claude-mock-small', display_name: 'Claude Mock Small', created_at: '2026-01-01T00:00:00Z' }], has_more: false, first_id: 'claude-mock-large', last_id: 'claude-mock-small' }));
  }
  if (req.method !== 'POST' || !req.url.startsWith('/v1/messages')) return fail(res, 404, 'not_found_error', 'Not found');
  let raw = '';
  req.on('data', (d) => (raw += d));
  req.on('end', () => {
    const body = JSON.parse(raw || '{}');
    if (body.model === 'mock-hang') return; // never answers: exercises the stall guard
    if (!body.model || !body.max_tokens || !Array.isArray(body.messages)) return fail(res, 400, 'invalid_request_error', 'model, max_tokens and messages are required');
    const system = typeof body.system === 'string' ? body.system : (body.system || []).map((b) => b.text).join('\n');
    const text = reply({ messages: [{ role: 'system', content: system }, ...body.messages] });
    const id = 'msg_mock';
    const usage = { input_tokens: 100, output_tokens: 20 };
    if (!body.stream) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ id, type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, usage }));
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    ev('message_start', { message: { id, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, usage: { input_tokens: 100, output_tokens: 1 } } });
    ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
    ev('ping', {});
    for (const piece of text.match(/.{1,12}/gs)) ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: piece } });
    ev('content_block_stop', { index: 0 });
    ev('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 20 } });
    ev('message_stop', {});
    res.end();
  });
});
if (require.main === module) server.listen(port, () => console.log(`mock anthropic on ${port}`));
module.exports = { server };
