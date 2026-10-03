// A stand-in for any OpenAI-compatible server, for self-tests without a key or a network.
// node test/mock-openai.js [port]  — answers /models and streaming /chat/completions; JSON when asked for it.
const http = require('http');
const port = Number(process.argv[2] || 8765);
const reply = (body) => {
  const sys = body.messages.find((m) => m.role === 'system')?.content || '';
  const schema = body.response_format?.json_schema?.schema || (/JSON schema:\s*(\{[\s\S]*\})/.exec(sys) || [])[1];
  if (!schema) return sys.includes('single word OK') ? 'OK' : 'Subject: Follow-up\n\nHi all,\n\nThanks for the time today.\n\nWhat we covered:\n- The mock server answered.\n\nNext steps:\n- I will send the notes.\n\nBest regards,';
  const s = typeof schema === 'string' ? JSON.parse(schema) : schema;
  if (s.properties?.sections) return JSON.stringify({ title: 'Mock notes', sections: [{ heading: 'Summary', bullets: [{ text: 'Written by the mock server.', from_my_notes: false, timestamp: '00:05' }] }] });
  if (s.properties?.action_items) return JSON.stringify({ action_items: [{ task: 'Send the notes', owner: 'Me', due: 'Friday', timestamp: '00:10' }] });
  if (s.properties?.answers) return JSON.stringify({ answers: [] });
  return '{}';
};
http.createServer((req, res) => {
  if (req.url.endsWith('/models')) return res.end(JSON.stringify({ data: [{ id: 'mock-small' }, { id: 'mock-large' }] }));
  let raw = '';
  req.on('data', (d) => (raw += d));
  req.on('end', () => {
    const body = JSON.parse(raw || '{}');
    if (process.env.MOCK_REJECT_SCHEMA && body.response_format?.type === 'json_schema') { res.writeHead(400); return res.end(JSON.stringify({ error: { message: 'response_format json_schema not supported' } })); }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const text = reply(body);
    for (const piece of text.match(/.{1,12}/gs)) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ delta: {} }], usage: { prompt_tokens: 100, completion_tokens: 20 } })}\n\ndata: [DONE]\n\n`);
    res.end();
  });
}).listen(port, () => console.log(`mock openai on ${port}`));
