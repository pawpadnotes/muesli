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
const formatTranscript = (segments) => segments.map((s) => `[${mmss(s.from)}] ${s.speaker}: ${s.text}`).join('\n');

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
- "Me" is the user; "Them" is the other side of the call.`;

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
and commitment in it as short bullets, each starting with its [mm:ss] timestamp. Do not summarise away names, numbers or dates.`;

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
  const template = TEMPLATES[meeting.template] || TEMPLATES.general;
  const { model, numCtx } = tier;
  const stats = [];
  const call = async (step, system, user, opts) => {
    onProgress({ step });
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

  const context = `Meeting title: ${meeting.title || '(not named yet)'}\n\nMy rough notes:\n${meeting.userNotes || '(none)'}\n\nTranscript:\n${transcript}`;

  const notes = parseJson(await call('Writing notes', NOTES_SYSTEM, `Section headings: ${template.sections.join(', ')}\n\n${context}`, { numPredict: 2000, format: NOTES_SCHEMA }));
  const actions = parseJson(await call('Finding action items', ACTIONS_SYSTEM, context, { numPredict: 800, format: ACTIONS_SCHEMA })).action_items;
  const email = await call('Drafting follow-up email', EMAIL_SYSTEM, `Action items:\n${JSON.stringify(actions)}\n\n${context}`, { numPredict: 600 });
  const emailText = email.replace(/\bMe will\b/g, 'I will');

  return { notes, actions, email: emailText, stats, model };
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

module.exports = { generate, toMarkdown, formatTranscript, TEMPLATES };
