// Lets assistants that only speak MCP over stdio (Claude Desktop and others) reach the running Muesli.
// Each line on stdin is a JSON-RPC message; it is posted to Muesli's local endpoint with the token, and the answer goes to stdout.
// Run as `Muesli --mcp`, or `node src/mcp-stdio.js` from source.
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');

// Muesli's settings folder, the same one Electron calls userData.
function userData() {
  if (process.env.MUESLI_USER_DATA) return process.env.MUESLI_USER_DATA;
  const base = process.platform === 'win32' ? process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
    : process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support')
      : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  // Installed it is "Muesli"; run from source it is "muesli".
  return ['Muesli', 'muesli'].map((n) => path.join(base, n)).find((d) => fs.existsSync(path.join(d, 'settings.json'))) || path.join(base, 'Muesli');
}

function token() {
  if (process.env.MUESLI_MCP_TOKEN) return process.env.MUESLI_MCP_TOKEN;
  try {
    return JSON.parse(fs.readFileSync(path.join(userData(), 'settings.json'), 'utf8')).mcpToken || '';
  } catch {
    return '';
  }
}

function run({ input = process.stdin, output = process.stdout, onEnd = () => process.exit(0) } = {}) {
  const url = `http://127.0.0.1:${Number(process.env.MUESLI_MCP_PORT) || 3939}/mcp`;
  const write = (msg) => output.write(`${JSON.stringify(msg)}\n`);
  const fail = (id, message) => id !== undefined && write({ jsonrpc: '2.0', id, error: { code: -32000, message } });
  let session = null;
  let queue = Promise.resolve();

  const forward = async (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    }
    const ids = (Array.isArray(msg) ? msg : [msg]).map((m) => m.id).filter((id) => id !== undefined);
    let res;
    try {
      // The token is read each time, so regenerating it in Settings needs no restart here.
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${token()}`, ...(session && { 'Mcp-Session-Id': session }) },
        body: line,
      });
    } catch {
      return ids.forEach((id) => fail(id, 'Muesli is not running. Open Muesli and switch on Settings › Assistants.'));
    }
    session = res.headers.get('mcp-session-id') || session;
    if (res.status === 401) return ids.forEach((id) => fail(id, 'Muesli turned this connection away: the token is missing or out of date. Switch on Settings › Assistants in Muesli.'));
    if (res.status === 202 || !ids.length) return;
    const text = await res.text();
    try {
      write(JSON.parse(text));
    } catch {
      ids.forEach((id) => fail(id, `Muesli answered ${res.status}: ${text.slice(0, 200)}`));
    }
  };

  const lines = readline.createInterface({ input });
  // One at a time, so answers come back in the order they were asked.
  lines.on('line', (line) => { if (line.trim()) queue = queue.then(() => forward(line)); });
  lines.on('close', () => queue.then(onEnd));
}

if (require.main === module) run();

module.exports = { run };
