// A scripted sales call used to compare notes models. Run: node test/sample-meeting.js [model] [numCtx] [chunked]
const { generate, toMarkdown } = require('../src/notes');

const lines = [
  ['Me', "Hi Priya, thanks for making time. I've got Marcus from our solutions team with me."],
  ['Them', "No problem. I've got about twenty five minutes, and Dev from our IT team is on as well."],
  ['Me', 'Great. So last time you mentioned the support team was drowning in tickets. Is that still the main issue?'],
  ['Them', "Yes. We're at about four thousand tickets a month now with eleven agents. First response time has slipped to nine hours and our target is two."],
  ['Them', "Dev here. The other problem is that we're on Zendesk and the contract renews on December first, so if we move it has to be decided by mid November."],
  ['Me', 'Understood. What would a good outcome look like for you?'],
  ['Them', "Honestly, if we could get first response under two hours without hiring, I'd sign. I can't get headcount approved until next fiscal year."],
  ['Me', 'Marcus, do you want to cover how the triage works?'],
  ['Me', 'Sure. We auto-categorise and draft replies for the common ticket types. Customers of your size usually see forty to fifty percent of tickets handled without an agent touching them.'],
  ['Them', 'Forty to fifty percent sounds high. Do you have a reference in e-commerce?'],
  ['Me', "We do. Northwind Outfitters is about your size. I'll set up a reference call with their head of support."],
  ['Them', 'That would help. Dev, what about security?'],
  ['Them', "We'd need SOC 2 Type 2 and a signed DPA, and data has to stay in the EU. That's non-negotiable because of our German customers."],
  ['Me', "We have SOC 2 Type 2 and EU hosting in Frankfurt. I'll send the report and the DPA template today."],
  ['Them', "Good. And pricing? We pay about fifty two thousand a year for Zendesk now."],
  ['Me', "For eleven agents on the growth plan you'd be at roughly thirty eight thousand a year, and there's a one-off onboarding fee of four thousand which I can probably get waived if we sign before the end of October."],
  ['Them', "Okay. My worry is migration. We have six years of ticket history and about two hundred macros."],
  ['Me', 'Marcus?'],
  ['Me', 'We run migrations ourselves. Ticket history comes over in full. Macros need manual review, usually about two weeks for that volume.'],
  ['Them', "Two weeks is fine. Dev, can you send them an export of our macro list so they can scope it?"],
  ['Them', "Yes, I'll send that by Wednesday."],
  ['Them', "I'll also need to take this to our CFO, Helen. She'll want a one page business case."],
  ['Me', "I'll draft the business case with your numbers and send it by Friday so you can edit it before it goes to Helen."],
  ['Them', "Perfect. Can we do a technical deep dive with Dev next week?"],
  ['Me', "Yes. Marcus, are you free Thursday the ninth at two?"],
  ['Me', 'Thursday at two works.'],
  ['Them', "Thursday the ninth at two works for me too. Send the invite."],
  ['Me', "Will do. So to recap: I send the SOC 2 report and DPA today, the business case by Friday, and set up the Northwind reference call. Dev sends the macro export by Wednesday, and we meet Thursday the ninth at two for the technical deep dive."],
  ['Them', "That's right. Thanks both."],
];

const meeting = {
  title: 'Brightcart discovery call',
  template: 'sales',
  userNotes: '4k tickets/mo, 11 agents\nFRT 9h -> want 2h\nzendesk renews dec 1 !!\nno headcount til next FY\nEU data only\nask about waiving onboarding',
  segments: lines.map(([speaker, text], i) => ({ speaker, from: i * 21000, text })),
};

const [model = 'qwen3.5:9b', numCtx = '16384', chunked] = process.argv.slice(2);

generate(meeting, { model, numCtx: Number(numCtx), chunked: chunked === 'chunked' }, (p) => p.token || console.error(`... ${p.step}`)).then((r) => {
  console.log(toMarkdown(meeting, r));
  console.log('--- bullets from my notes:', r.notes.sections.flatMap((s) => s.bullets).filter((b) => b.from_my_notes).length, 'of', r.notes.sections.flatMap((s) => s.bullets).length);
  console.log('--- email ---\n' + r.email);
  console.log('--- stats ---');
  console.table(r.stats);
});
