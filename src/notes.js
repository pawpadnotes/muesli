const { OLLAMA } = require('./models');

const TEMPLATES = {
  general: { name: 'General', sections: ['Summary', 'Key points', 'Decisions', 'Open questions'] },
  one_on_one: { name: '1:1', sections: ['Updates', 'Feedback', 'Blockers', 'Growth and goals'] },
  sales: { name: 'Sales call', sections: ['Customer situation', 'Pain points', 'Objections', 'Budget and timeline', 'Next steps'] },
  standup: { name: 'Standup', sections: ['Done', 'Doing next', 'Blockers'] },
};

const NOTES_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    sections: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          heading: { type: 'string' },
          bullets: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                text: { type: 'string' },
                from_my_notes: { type: 'boolean' },
                timestamp: { type: 'string' },
              },
              required: ['text', 'from_my_notes', 'timestamp'],
            },
          },
        },
        required: ['heading', 'bullets'],
      },
    },
  },
  required: ['title', 'sections'],
};

const ACTIONS_SCHEMA = {
  type: 'object',
  properties: {
    action_items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          task: { type: 'string' },
          owner: { type: 'string' },
          due: { type: 'string' },
          timestamp: { type: 'string' },
        },
        required: ['task', 'owner', 'due', 'timestamp'],
      },
    },
  },
  required: ['action_items'],
};

const mmss = (ms) => {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

// segments: [{ speaker, from (ms), text }]
// Lines from the other side carry a voice number when more than one person spoke there: "Them 2".
const formatTranscript = (segments) => segments.map((s) => `[${mmss(s.from)}] ${s.speaker}${s.voice ? ` ${s.voice}` : ''}: ${s.text}`).join('\n');

// Rough: about 4 characters per token for English.
const estimateTokens = (text) => Math.ceil(text.length / 4);

const capsCache = new Map();
async function supportsThinking(model) {
  if (!capsCache.has(model)) {
    const res = await fetch(`${OLLAMA}/api/show`, { method: 'POST', body: JSON.stringify({ model }) });
    const info = await res.json();
    capsCache.set(model, (info.capabilities || []).includes('thinking'));
  }
  return capsCache.get(model);
}

async function chat(model, system, user, { numCtx, numPredict, format, onToken }) {
  const body = {
    model,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    stream: true,
    options: { num_ctx: numCtx, num_predict: numPredict, temperature: 0.2 },
  };
  if (format) body.format = format;
  // Thinking leaks reasoning into the content and breaks JSON parsing; older models reject the flag.
  if (await supportsThinking(model)) body.think = false;

  const res = await fetch(`${OLLAMA}/api/chat`, { method: 'POST', body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`Ollama ${res.status}: ${await res.text()}`);

  let content = '';
  let last = {};
  let pending = '';
  const decoder = new TextDecoder();
  for await (const chunk of res.body) {
    pending += decoder.decode(chunk, { stream: true });
    const lines = pending.split('\n');
    pending = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      if (msg.error) throw new Error(msg.error);
      if (msg.message?.content) {
        content += msg.message.content;
        onToken?.(msg.message.content);
      }
      if (msg.done) last = msg;
    }
  }

  // Ollama truncates an over-long prompt from the front without an error.
  const expected = estimateTokens(system + user);
  const truncated = last.prompt_eval_count && last.prompt_eval_count < expected * 0.6;
  content = content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  return { content, truncated, promptTokens: last.prompt_eval_count, outputTokens: last.eval_count, ms: Math.round((last.total_duration || 0) / 1e6) };
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    const braced = text.match(/\{[\s\S]*\}/);
    return JSON.parse(fenced ? fenced[1] : braced[0]);
  }
}

const NOTES_SYSTEM = `You write meeting notes. You are given the user's own rough notes and a timestamped transcript.
Rules:
- Keep every point from the user's rough notes, rewritten as a clear short sentence with the detail the transcript adds, and mark those bullets from_my_notes true.
- Add what the user missed from the transcript; mark those bullets from_my_notes false.
- timestamp is the mm:ss of the transcript line that best supports the bullet, or "" if none.
- Only state what the transcript or the rough notes support. Do not invent names, numbers or dates.
- Bullets are short and specific: who, what, by when. No filler.
- title is a short specific name for the meeting (for example "Brightcart discovery call"), never "Untitled" or "Meeting".
- Use the section headings given. Leave a section's bullets empty if nothing was said about it.
- "Me" is the user; "Them" is the other side of the call. "Them 1", "Them 2" are different people on the other side; use their real names when the transcript gives them.`;

const ACTIONS_SYSTEM = `You extract action items from a meeting transcript and the user's rough notes.
Rules:
- An action item is something a specific person agreed or was asked to do.
- owner is the person's name as said in the meeting, "Me" for the user, or "Unassigned" if unclear.
- due is the deadline as stated (for example "Friday"), or "" if none was given.
- timestamp is the mm:ss of the transcript line where it was agreed, or "".
- Do not invent items. If there are none, return an empty list.`;

const EMAIL_SYSTEM = `You draft the follow-up email the user ("Me" in the transcript) sends to the other side ("Them") after a meeting.
Rules:
- Write as the user, in the first person, to the other participants. Never describe the user's side as "you" or the other side as "we".
- Plain text. First line "Subject: ...", a blank line, then a greeting using the other side's names if they were said.
- Greet only people who spoke on the "Them" lines. Colleagues on the user's side and people who were only mentioned are not greeted.
- One sentence of thanks. Then "What we covered:" with two to four dashes of facts, numbers and decisions (not tasks). Then "Next steps:" with one dash per action item: who does what by when. No task appears twice.
- The owner "Me" is the user: write "I will ...", never "Me will".
- End with "Best regards," and no name after it.
- Only include facts from the notes and transcript. Do not claim a decision that was not made. No bracketed placeholders.
- Under 160 words.`;

const CHUNK_SYSTEM = `You are given one part of a longer meeting transcript. List every substantive point, decision, question
and commitment in it as short bullets, each starting with its [mm:ss] timestamp. Do not summarise away names, numbers or dates.
Lines are marked "Me" (the user) or "Them" (the other side). Keep that: start each bullet with Me or Them after the timestamp, and say who made each commitment.`;

function chunkSegments(segments, maxTokens) {
  const chunks = [[]];
  let size = 0;
  for (const seg of segments) {
    const t = estimateTokens(seg.text) + 8;
    if (size + t > maxTokens && chunks[chunks.length - 1].length) {
      chunks.push([]);
      size = 0;
    }
    chunks[chunks.length - 1].push(seg);
    size += t;
  }
  return chunks;
}

// meeting: { title, template, userNotes, segments }
// tier: { model, numCtx, chunked }
async function generate(meeting, tier, onProgress = () => {}) {
  const template = meeting.templateDef || TEMPLATES[meeting.template] || TEMPLATES.general;
  const { model, numCtx } = tier;
  const stats = [];
  const call = async (step, system, user, opts) => {
    onProgress({ step });
    if (meeting.language && meeting.language !== 'en') system += '\nWrite in the language the transcript is in.';
    const r = await chat(model, system, user, { numCtx, ...opts, onToken: (t) => onProgress({ step, token: t }) });
    stats.push({ step, ms: r.ms, promptTokens: r.promptTokens, outputTokens: r.outputTokens, truncated: r.truncated });
    return r.content;
  };

  // Small models, and transcripts over half the context, are condensed chunk by chunk first.
  let transcript = formatTranscript(meeting.segments);
  if (tier.chunked || estimateTokens(transcript) > numCtx / 2) {
    const chunks = chunkSegments(meeting.segments, 3000);
    const parts = [];
    for (let i = 0; i < chunks.length; i++) {
      parts.push(await call(`Reading part ${i + 1} of ${chunks.length}`, CHUNK_SYSTEM, formatTranscript(chunks[i]), { numPredict: 800 }));
    }
    transcript = parts.join('\n');
  }

  const context = `Meeting title: ${meeting.title || '(not named yet)'}\n${meeting.people ? `People in the meeting: ${meeting.people}\n` : ''}\nMy rough notes:\n${meeting.userNotes || '(none)'}\n\nTranscript:\n${transcript}`;

  const notes = parseJson(await call('Writing notes', NOTES_SYSTEM, `Section headings: ${template.sections.join(', ')}\n\n${context}`, { numPredict: 2000, format: NOTES_SCHEMA }));
  const actions = parseJson(await call('Finding action items', ACTIONS_SYSTEM, context, { numPredict: 800, format: ACTIONS_SCHEMA })).action_items;
  const email = await call('Drafting follow-up email', EMAIL_SYSTEM, `Action items:\n${JSON.stringify(actions)}\n\n${context}`, { numPredict: 600 });
  // A greeting may only use names that were actually said; small models sometimes invent them.
  const said = `${meeting.segments.map((seg) => seg.text).join(' ')} ${meeting.userNotes || ''}`.toLowerCase();
  const emailText = email.replace(/\bMe will\b/g, 'I will').replace(/^(Hi|Hello|Dear) ([^\n]*),$/m, (line, hello, names) =>
    (names.match(/[A-Z][a-z]+/g) || []).every((n) => said.includes(n.toLowerCase())) ? line : `${hello} all,`);

  return { notes, actions, email: emailText, stats, model };
}

const ASK_SYSTEM = `You answer questions about one meeting for the person who recorded it ("Me" in the transcript; "Them" is the other side).
Rules:
- Use only the notes and transcript you are given. If the answer is not there, say the meeting did not cover it.
- Be brief and direct: a sentence or a few short dashes. Address the user as "you".
- After each fact, give the moment it was said as [mm:ss].
- Plain text only.`;

const wordsOf = (t) => t.toLowerCase().match(/[a-z0-9]{4,}/g) || [];

// history: [{ q, a }]
async function ask(meeting, tier, history, question, onToken) {
  const { model, numCtx } = tier;
  // A long transcript will not fit: keep the lines that share words with the question, plus their neighbours.
  let segments = meeting.segments;
  const budget = numCtx * 0.55;
  if (estimateTokens(formatTranscript(segments)) > budget) {
    const wanted = new Set(wordsOf(question));
    const score = segments.map((s) => wordsOf(s.text).filter((w) => wanted.has(w)).length);
    const order = segments.map((_, i) => i).sort((a, b) => score[b] - score[a]);
    const keep = new Set();
    let size = 0;
    for (const i of order) {
      for (const j of [i - 1, i, i + 1]) {
        if (j < 0 || j >= segments.length || keep.has(j)) continue;
        size += estimateTokens(segments[j].text) + 8;
        keep.add(j);
      }
      if (size > budget) break;
    }
    segments = segments.filter((_, i) => keep.has(i));
  }
  const notesText = meeting.result ? toMarkdown(meeting, meeting.result) : '(not written yet)';
  const earlier = history.slice(-3).map((t) => `Q: ${t.q}\nA: ${t.a}`).join('\n\n');
  const user = `Notes:\n${notesText}\n\nMy rough notes:\n${meeting.userNotes || '(none)'}\n\nTranscript:\n${formatTranscript(segments)}${earlier ? `\n\nEarlier questions:\n${earlier}` : ''}\n\nQuestion: ${question}`;
  const r = await chat(model, ASK_SYSTEM, user, { numCtx, numPredict: 500, onToken });
  return r.content.trim();
}

const ASK_ALL_SYSTEM = `You answer questions across the user's meetings. You are given the notes of several meetings, each under its title and date.
Rules:
- Use only what you are given. If the meetings do not cover it, say so.
- Be brief and direct: a few short dashes. Address the user as "you".
- After each fact, name the meeting it came from in brackets, using its exact title.
- Plain text only.`;

// all: full meetings, newest first. history: [{ q, a }]
async function askAll(all, tier, history, question, onToken) {
  const wanted = new Set(wordsOf(question));
  const docs = all.map((m) => {
    const body = m.result ? toMarkdown(m, m.result).split('\n').slice(2).join('\n') : m.userNotes;
    const text = `### ${m.title || 'Untitled meeting'} (${m.createdAt.slice(0, 10)})\n${body}`;
    return { text, score: wordsOf(text).filter((w) => wanted.has(w)).length };
  });
  // When they will not all fit, the meetings that share most words with the question go in first; ties stay newest first.
  const keep = [];
  let size = 0;
  for (const d of [...docs].sort((a, b) => b.score - a.score)) {
    size += estimateTokens(d.text);
    if (size > tier.numCtx * 0.6 && keep.length) break;
    keep.push(d);
  }
  const earlier = history.slice(-3).map((t) => `Q: ${t.q}\nA: ${t.a}`).join('\n\n');
  const user = `Today is ${new Date().toISOString().slice(0, 10)}.\n\n${keep.map((d) => d.text).join('\n\n')}${earlier ? `\n\nEarlier questions:\n${earlier}` : ''}\n\nQuestion: ${question}`;
  const r = await chat(tier.model, ASK_ALL_SYSTEM, user, { numCtx: tier.numCtx, numPredict: 500, onToken });
  return r.content.trim();
}

function toMarkdown(meeting, result) {
  const out = [`# ${result.notes.title || meeting.title || 'Meeting'}`, ''];
  for (const s of result.notes.sections) {
    if (!s.bullets.length) continue;
    out.push(`## ${s.heading}`, ...s.bullets.map((b) => `- ${b.text}${b.timestamp ? ` [${b.timestamp}]` : ''}`), '');
  }
  if (result.actions.length) {
    out.push('## Action items', ...result.actions.map((a) => `- [ ] ${a.task} (${a.owner}${a.due ? `, due ${a.due}` : ''})`), '');
  }
  return out.join('\n');
}

// Words the user corrected once before have turned up again. For each, the model reads the sentence and says whether
// the speech recogniser misheard this time too. items: [{ n, sentence (heard word in [[brackets]]), meant, example }]
// Returns the numbers to swap. Anything unclear is left alone.
const JUDGE_SYSTEM = `A speech recogniser sometimes writes one word when another was said. Each numbered item has a sentence from a meeting with one word or phrase in [[double brackets]], and a suggested replacement that the user chose in an earlier meeting, sometimes with the earlier sentence.
For each item decide from the meaning of the sentence whether the bracketed text is a mishearing of the suggestion.
- Answer "swap" only when the suggestion clearly makes more sense in this sentence.
- Answer "keep" when the bracketed text makes sense as it stands, or when you are not sure.
Reply as JSON: {"answers":[{"n":1,"choice":"keep"}]} with one answer per item.`;
const JUDGE_SCHEMA = { type: 'object', properties: { answers: { type: 'array', items: { type: 'object', properties: { n: { type: 'integer' }, choice: { type: 'string', enum: ['keep', 'swap'] } }, required: ['n', 'choice'] } } }, required: ['answers'] };

async function judge(tier, items) {
  const user = items.map((it) => `${it.n}. Sentence: ${it.sentence}\n   Suggestion: ${it.meant}${it.example ? `\n   Earlier sentence where the suggestion was right: ${it.example}` : ''}`).join('\n');
  const res = await chat(tier.model, JUDGE_SYSTEM, user, { numCtx: Math.min(tier.numCtx, 8192), numPredict: 600, format: JUDGE_SCHEMA });
  const swap = new Set();
  for (const a of parseJson(res.content).answers || []) if (a.choice === 'swap' && items.some((it) => it.n === a.n)) swap.add(a.n);
  return swap;
}

module.exports = { judge, generate, ask, askAll, toMarkdown, formatTranscript, TEMPLATES };
