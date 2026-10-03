// Provider layer self-test against local mocks: no key, no network, no Electron.
// node test/providers.test.js  — exits non-zero on the first failure.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const providers = require('../src/providers');
const notes = require('../src/notes');
const { server: openaiServer } = require('./mock-openai');
const { server: anthropicServer } = require('./mock-anthropic');

const listen = (server) => new Promise((ok) => server.listen(0, '127.0.0.1', () => ok(server.address().port)));
const fakeSafeStorage = { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(s), decryptString: (b) => b.toString() };
let passed = 0;
const check = async (name, fn) => { await fn(); passed++; console.log(`ok  ${name}`); };

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muesli-keys-'));
  providers.useKeyStore(path.join(dir, 'keys.json'), fakeSafeStorage);
  const oPort = await listen(openaiServer);
  const aPort = await listen(anthropicServer);

  const cases = [
    { label: 'openai', setting: { preset: 'custom', baseUrl: `http://127.0.0.1:${oPort}/v1`, model: 'mock-small' }, models: ['mock-large', 'mock-small'], keyRequired: false },
    { label: 'anthropic', setting: { preset: 'anthropic', baseUrl: `http://127.0.0.1:${aPort}`, model: 'claude-mock-small' }, models: ['claude-mock-large', 'claude-mock-small'], keyRequired: true },
  ];
  const tier = (s, model) => ({ provider: providers.resolve(s), model: model || s.model, numCtx: providers.CLOUD_CTX });

  for (const c of cases) {
    const p = providers.resolve(c.setting);
    await check(`${c.label}: resolve keeps the baseUrl override`, () => assert.strictEqual(p.baseUrl, c.setting.baseUrl));
    if (c.keyRequired) {
      await check(`${c.label}: missing key names the provider`, async () => {
        await assert.rejects(providers.chat(tier(c.setting), 's', 'u', {}), (e) => /Anthropic/.test(e.message) && /key/i.test(e.message));
        await assert.rejects(providers.listModels(c.setting), /Anthropic/);
      });
      await check(`${c.label}: mock rejects a missing x-api-key with 401`, async () => {
        const res = await fetch(`http://127.0.0.1:${aPort}/v1/messages`, { method: 'POST', body: '{}' });
        assert.strictEqual(res.status, 401);
        assert.strictEqual((await res.json()).error.type, 'authentication_error');
      });
    }
    await check(`${c.label}: key round trip`, () => {
      providers.setKey(c.setting.preset, 'test-key-not-real');
      assert.ok(providers.hasKey(c.setting.preset));
      assert.strictEqual(providers.getKey(c.setting.preset), 'test-key-not-real');
      providers.setKey(c.setting.preset, '');
      assert.ok(!providers.hasKey(c.setting.preset));
      providers.setKey(c.setting.preset, 'test-key-not-real');
    });
    await check(`${c.label}: listModels`, async () => assert.deepStrictEqual((await providers.listModels(c.setting)).sort(), c.models));
    await check(`${c.label}: test()`, async () => {
      const r = await providers.test(c.setting);
      assert.strictEqual(typeof r.ms, 'number');
      assert.strictEqual(r.reply, 'OK');
    });
    await check(`${c.label}: streaming chat`, async () => {
      const tokens = [];
      const r = await providers.chat(tier(c.setting), 'Draft an email.', 'Hello', { numPredict: 200, onToken: (t) => tokens.push(t) });
      assert.ok(tokens.length > 1);
      assert.strictEqual(tokens.join('').trim(), r.content);
      assert.ok(r.content.startsWith('Subject:'));
      assert.strictEqual(r.promptTokens, 100);
      assert.strictEqual(r.outputTokens, 20);
    });
    await check(`${c.label}: JSON format`, async () => {
      const schemas = {
        sections: { type: 'object', properties: { title: { type: 'string' }, sections: { type: 'array' } } },
        action_items: { type: 'object', properties: { action_items: { type: 'array' } } },
        answers: { type: 'object', properties: { answers: { type: 'array' } } },
      };
      for (const [key, format] of Object.entries(schemas)) {
        const r = await providers.chat(tier(c.setting), 'Extract.', 'Transcript', { numPredict: 500, format });
        assert.ok(Array.isArray(JSON.parse(r.content)[key]), key);
      }
    });
    await check(`${c.label}: stall guard aborts a hung server`, async () => {
      const started = Date.now();
      await assert.rejects(providers.chat(tier(c.setting, 'mock-hang'), 's', 'u', { timeoutMs: 300 }), /stopped answering/);
      assert.ok(Date.now() - started < 5000);
    });
  }

  await check('anthropic: notes.generate end to end', async () => {
    const meeting = { title: 'Mock call', template: 'general', userNotes: 'price', segments: [{ start: 5, end: 8, speaker: 'Me', text: 'I will send the notes by Friday.' }, { start: 10, end: 12, speaker: 'Them', text: 'Great, thanks.' }] };
    const r = await notes.generate(meeting, tier(cases[1].setting));
    assert.strictEqual(r.notes.title, 'Mock notes');
    assert.ok(r.notes.sections.length > 0);
    assert.strictEqual(r.actions[0].task, 'Send the notes');
    assert.ok(r.email.startsWith('Subject:'));
    assert.strictEqual(r.provider, 'Anthropic');
  });

  console.log(`\n${passed} checks passed`);
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
