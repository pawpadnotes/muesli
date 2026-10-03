// Where the notes model runs. Ollama on this computer is the default and needs no setup; the same
// chat() also reaches a remote Ollama, any OpenAI-compatible server (OpenAI, Groq, OpenRouter, Together,
// vLLM, llama.cpp, LM Studio, LiteLLM) or Anthropic, with the user's own key. Transcription is local regardless.

const DEFAULT_OLLAMA = 'http://127.0.0.1:11434';

// settings.provider: { kind: 'ollama' | 'openai' | 'anthropic', preset, baseUrl, model }
// Keys live in the OS keychain (see keys below), never in settings.json.
const PRESETS = {
  ollama: { kind: 'ollama', name: 'Ollama on this computer', baseUrl: DEFAULT_OLLAMA, local: true },
  ollama_remote: { kind: 'ollama', name: 'Ollama on another machine', baseUrl: 'http://192.168.1.10:11434', local: true },
  openai: { kind: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4.1-mini', keyUrl: 'https://platform.openai.com/api-keys' },
  anthropic: { kind: 'anthropic', name: 'Anthropic', baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-5-5', keyUrl: 'https://console.anthropic.com/settings/keys' },
  groq: { kind: 'openai', name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile', keyUrl: 'https://console.groq.com/keys' },
  openrouter: { kind: 'openai', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-4.1-mini', keyUrl: 'https://openrouter.ai/keys' },
  together: { kind: 'openai', name: 'Together', baseUrl: 'https://api.together.xyz/v1', model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', keyUrl: 'https://api.together.ai/settings/api-keys' },
  mistral: { kind: 'openai', name: 'Mistral', baseUrl: 'https://api.mistral.ai/v1', model: 'mistral-small-latest', keyUrl: 'https://console.mistral.ai/api-keys' },
  deepseek: { kind: 'openai', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', keyUrl: 'https://platform.deepseek.com/api_keys' },
  lmstudio: { kind: 'openai', name: 'LM Studio', baseUrl: 'http://127.0.0.1:1234/v1', local: true },
  llamacpp: { kind: 'openai', name: 'llama.cpp server', baseUrl: 'http://127.0.0.1:8080/v1', local: true },
  vllm: { kind: 'openai', name: 'vLLM', baseUrl: 'http://127.0.0.1:8000/v1', local: true },
  custom: { kind: 'openai', name: 'Other OpenAI-compatible server', baseUrl: 'http://127.0.0.1:8000/v1' },
};

// The current choice, filled in from its preset. Anything that is not a complete cloud setup falls back to local Ollama.
function resolve(setting) {
  const p = setting?.preset && PRESETS[setting.preset] ? PRESETS[setting.preset] : PRESETS.ollama;
  const kind = setting?.kind || p.kind;
  const baseUrl = (setting?.baseUrl || p.baseUrl).replace(/\/+$/, '');
  const host = baseUrl.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const local = /^(127\.0\.0\.1|localhost|\[::1\]|0\.0\.0\.0)(:|$)/.test(host) || /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host) || host.endsWith('.local');
  return { preset: setting?.preset || 'ollama', kind, name: p.name, baseUrl, model: setting?.model || p.model || '', local, keyUrl: p.keyUrl };
}

const ollamaBase = (setting) => (resolve(setting).kind === 'ollama' ? resolve(setting).baseUrl : DEFAULT_OLLAMA);

// ---------- keys ----------
// Encrypted with the OS keychain (DPAPI on Windows, Keychain on Mac) in keys.json next to settings.json.
let keyStore = null; // { file, safeStorage }
function useKeyStore(file, safeStorage) { keyStore = { file, safeStorage }; }
function readKeys() {
  try { return JSON.parse(require('fs').readFileSync(keyStore.file, 'utf8')); } catch { return {}; }
}
function setKey(preset, key) {
  const keys = readKeys();
  if (key) keys[preset] = keyStore.safeStorage.encryptString(key).toString('base64');
  else delete keys[preset];
  require('fs').writeFileSync(keyStore.file, JSON.stringify(keys));
}
function getKey(preset) {
  const raw = readKeys()[preset];
  if (!raw) return '';
  try { return keyStore.safeStorage.decryptString(Buffer.from(raw, 'base64')); } catch { return ''; }
}
const hasKey = (preset) => !!readKeys()[preset];

// ---------- streaming helpers ----------
async function* sseLines(body) {
  const decoder = new TextDecoder();
  let pending = '';
  for await (const chunk of body) {
    pending += decoder.decode(chunk, { stream: true });
    const lines = pending.split('\n');
    pending = lines.pop();
    for (const line of lines) yield line;
  }
  if (pending.trim()) yield pending;
}

// Nothing arriving for this long means the server is stuck, not slow.
const STALL_MS = 90000;
function stallGuard(onToken, ms = STALL_MS) {
  const ctl = new AbortController();
  let timer = setTimeout(() => ctl.abort(), ms);
  const touch = () => { clearTimeout(timer); timer = setTimeout(() => ctl.abort(), ms); };
  return { signal: ctl.signal, token: (t) => { touch(); onToken?.(t); }, done: () => clearTimeout(timer) };
}

const errorText = async (res, who) => {
  const text = await res.text().catch(() => '');
  let detail = text;
  try { detail = JSON.parse(text).error?.message || JSON.parse(text).error || text; } catch {}
  if (res.status === 401 || res.status === 403) return `${who} did not accept the key (${res.status}).`;
  if (res.status === 429) return `${who} is rate-limiting this key (429). Try again in a moment.`;
  if (res.status === 404) return `${who} has no model called that (404). Pick another in Settings.`;
  return `${who} ${res.status}: ${String(detail).slice(0, 300)}`;
};

const estimateTokens = (text) => Math.ceil(text.length / 4);

// ---------- Ollama ----------
const capsCache = new Map();
async function ollamaThinks(baseUrl, model) {
  const key = `${baseUrl}/${model}`;
  if (!capsCache.has(key)) {
    try {
      const res = await fetch(`${baseUrl}/api/show`, { method: 'POST', body: JSON.stringify({ model }) });
      const info = await res.json();
      capsCache.set(key, (info.capabilities || []).includes('thinking'));
    } catch { capsCache.set(key, false); }
  }
  return capsCache.get(key);
}

async function ollamaChat(p, system, user, { numCtx, numPredict, format, onToken, timeoutMs }) {
  const body = {
    model: p.model,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    stream: true,
    options: { num_ctx: numCtx, num_predict: numPredict, temperature: 0.2 },
  };
  if (format) body.format = format;
  // Thinking leaks reasoning into the content and breaks JSON parsing; older models reject the flag.
  if (await ollamaThinks(p.baseUrl, p.model)) body.think = false;
  const guard = stallGuard(onToken, timeoutMs);
  const started = Date.now();
  try {
    const res = await fetch(`${p.baseUrl}/api/chat`, { method: 'POST', body: JSON.stringify(body), signal: guard.signal });
    if (!res.ok) throw new Error(await errorText(res, 'Ollama'));
    let content = '', last = {};
    for await (const line of sseLines(res.body)) {
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      if (msg.error) throw new Error(msg.error);
      if (msg.message?.content) { content += msg.message.content; guard.token(msg.message.content); }
      if (msg.done) last = msg;
    }
    // Ollama truncates an over-long prompt from the front without an error.
    const expected = estimateTokens(system + user);
    const truncated = last.prompt_eval_count && last.prompt_eval_count < expected * 0.6;
    return { content, truncated, promptTokens: last.prompt_eval_count, outputTokens: last.eval_count, ms: Math.round((last.total_duration || 0) / 1e6) || Date.now() - started };
  } catch (e) {
    throw guard.signal.aborted ? new Error('The notes model stopped answering.') : e;
  } finally { guard.done(); }
}

async function ollamaModels(p) {
  const res = await fetch(`${p.baseUrl}/api/tags`, { signal: AbortSignal.timeout(4000) });
  return (await res.json()).models.filter((m) => !/whisper|embed/i.test(m.name)).map((m) => m.name);
}

// ---------- OpenAI-compatible ----------
const jsonInstruction = (format) => `\nReply with one JSON object only, no prose and no code fence, matching this JSON schema:\n${JSON.stringify(format)}`;

async function openaiChat(p, system, user, { numPredict, format, onToken, timeoutMs }, key) {
  const headers = { 'Content-Type': 'application/json', ...(key && { Authorization: `Bearer ${key}` }), 'HTTP-Referer': 'https://github.com/pawpadnotes/muesli', 'X-Title': 'Muesli' };
  // Structured output where the server supports it; servers that reject it get the schema in the prompt instead.
  const attempts = format
    ? [{ response_format: { type: 'json_schema', json_schema: { name: 'notes', schema: format, strict: false } } }, { response_format: { type: 'json_object' }, hint: true }, { hint: true }]
    : [{}];
  let lastError;
  for (const attempt of attempts) {
    const body = {
      model: p.model,
      messages: [{ role: 'system', content: system + (attempt.hint ? jsonInstruction(format) : '') }, { role: 'user', content: user }],
      stream: true,
      temperature: 0.2,
      max_tokens: numPredict,
      ...(attempt.response_format && { response_format: attempt.response_format }),
    };
    const guard = stallGuard(onToken, timeoutMs);
    const started = Date.now();
    try {
      const res = await fetch(`${p.baseUrl}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body), signal: guard.signal });
      if (res.status === 400 && attempt !== attempts[attempts.length - 1]) { lastError = new Error(await errorText(res, p.name)); continue; }
      if (!res.ok) throw new Error(await errorText(res, p.name));
      let content = '', usage = null;
      for await (const line of sseLines(res.body)) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        let msg;
        try { msg = JSON.parse(data); } catch { continue; }
        if (msg.error) throw new Error(msg.error.message || String(msg.error));
        const delta = msg.choices?.[0]?.delta?.content;
        if (delta) { content += delta; guard.token(delta); }
        if (msg.usage) usage = msg.usage;
      }
      return { content: content.replace(/<think>[\s\S]*?<\/think>/g, '').trim(), truncated: false, promptTokens: usage?.prompt_tokens, outputTokens: usage?.completion_tokens, ms: Date.now() - started };
    } catch (e) {
      throw guard.signal.aborted ? new Error(`${p.name} stopped answering.`) : e;
    } finally { guard.done(); }
  }
  throw lastError;
}

async function openaiModels(p, key) {
  const res = await fetch(`${p.baseUrl}/models`, { headers: key ? { Authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(await errorText(res, p.name));
  const json = await res.json();
  return (json.data || json.models || []).map((m) => m.id || m.name).filter(Boolean).sort();
}

// ---------- Anthropic ----------
async function anthropicChat(p, system, user, { numPredict, format, onToken, timeoutMs }, key) {
  if (!key) throw new Error(`No ${p.name} key saved. Add one in Settings.`);
  const headers = { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' };
  const body = {
    model: p.model,
    system: system + (format ? jsonInstruction(format) : ''),
    messages: [{ role: 'user', content: user }],
    max_tokens: numPredict || 1024,
    temperature: 0.2,
    stream: true,
  };
  const guard = stallGuard(onToken, timeoutMs);
  const started = Date.now();
  try {
    const res = await fetch(`${p.baseUrl}/v1/messages`, { method: 'POST', headers, body: JSON.stringify(body), signal: guard.signal });
    if (!res.ok) throw new Error(await errorText(res, p.name));
    let content = '', input = 0, output = 0;
    for await (const line of sseLines(res.body)) {
      if (!line.startsWith('data:')) continue;
      let msg;
      try { msg = JSON.parse(line.slice(5)); } catch { continue; }
      if (msg.type === 'error') throw new Error(msg.error?.message || 'Anthropic error');
      if (msg.type === 'content_block_delta' && msg.delta?.text) { content += msg.delta.text; guard.token(msg.delta.text); }
      if (msg.type === 'message_start') input = msg.message?.usage?.input_tokens || 0;
      if (msg.type === 'message_delta') output = msg.usage?.output_tokens || output;
    }
    return { content: content.trim(), truncated: false, promptTokens: input, outputTokens: output, ms: Date.now() - started };
  } catch (e) {
    throw guard.signal.aborted ? new Error(`${p.name} stopped answering.`) : e;
  } finally { guard.done(); }
}

async function anthropicModels(p, key) {
  if (!key) throw new Error(`No ${p.name} key saved. Add one in Settings.`);
  const res = await fetch(`${p.baseUrl}/v1/models?limit=100`, { headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' }, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(await errorText(res, p.name));
  return ((await res.json()).data || []).map((m) => m.id);
}

// ---------- the one entry point ----------
// tier: { provider (resolved), model, numCtx, chunked }
async function chat(tier, system, user, opts) {
  const p = { ...tier.provider, model: tier.model };
  if (p.kind === 'openai') return openaiChat(p, system, user, opts, getKey(p.preset));
  if (p.kind === 'anthropic') return anthropicChat(p, system, user, opts, getKey(p.preset));
  return ollamaChat(p, system, user, opts);
}

async function listModels(setting) {
  const p = resolve(setting);
  if (p.kind === 'openai') return openaiModels(p, getKey(p.preset));
  if (p.kind === 'anthropic') return anthropicModels(p, getKey(p.preset));
  return ollamaModels(p);
}

// One tiny request: proves the URL, key and model together, and shows how fast the answer comes.
async function test(setting) {
  const p = resolve(setting);
  if (!p.model) throw new Error('Pick a model first.');
  const started = Date.now();
  const r = await chat({ provider: p, model: p.model, numCtx: 4096 }, 'Reply with the single word OK.', 'Ready?', { numPredict: 5 });
  return { ms: Date.now() - started, reply: r.content.slice(0, 40) };
}

// Context to plan for. Cloud and server models are large; local Ollama tiers keep their measured sizes.
const CLOUD_CTX = 60000;

module.exports = { PRESETS, DEFAULT_OLLAMA, resolve, ollamaBase, chat, listModels, test, useKeyStore, setKey, getKey, hasKey, CLOUD_CTX };
