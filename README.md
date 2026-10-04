# Muesli

Open-source meeting notes in the spirit of Granola. Local by default; bring your own model if you like.

Muesli sits in the tray, records both sides of a call, transcribes it on your computer, and turns your rough jottings plus the transcript into clean notes, action items and a follow-up email. No bot joins the meeting and there is no account. Out of the box everything runs on your own machine. If you already pay for OpenAI, Anthropic, Groq or another provider, or run models on a server of your own, you can have that write the notes instead; transcription stays local either way.

## Try it

1. Install [Ollama](https://ollama.com/download) and open it. Muesli uses it to write the notes.
2. Download Muesli from the [releases page](https://github.com/pawpadnotes/muesli/releases):
   - **Windows:** `Muesli-Setup-0.1.0.exe`. The build is not code-signed, so Windows SmartScreen will ask; choose "More info", then "Run anyway".
   - **Mac (Apple Silicon):** `Muesli-mac-arm64.zip`. Unzip and open the app. The build is not notarized, so macOS will say it cannot check it: close that dialog, open System Settings > Privacy & Security, scroll down and choose "Open Anyway" (on older macOS, right-click the app and choose Open). macOS asks for microphone and system-audio permission when you first record.
3. Open Muesli. It checks your memory, suggests a notes model that fits, and downloads it with one button. The download takes several minutes on fast broadband. You can open the sample meeting meanwhile.
4. Open the sample meeting and press **Enhance** to watch the transcript and jottings become notes, or press **New meeting** and **Record**.

## How it works

| Step | What happens |
| --- | --- |
| Record | Your microphone and the call audio are captured as two separate tracks, so Muesli knows who said what without a bot in the call. |
| Jot | Type rough notes while you talk. They steer what the finished notes focus on. |
| Enhance | The transcript and your jottings become notes, action items and a follow-up email. Lines that came from your own notes are marked with a green dot; each line links to its moment in the transcript. |

Transcription is done by [whisper.cpp](https://github.com/ggml-org/whisper.cpp), which ships inside the app. Notes are written by a model in Ollama, on a server of yours, or at a cloud provider with your key (see below).

## Notes model

Settings has three choices for where the notes are written:

| Choice | What it is | Where the transcript goes |
| --- | --- | --- |
| **This computer** (default) | Ollama on this machine. Muesli picks the largest model that fits your memory and downloads it with one button. | Nowhere. |
| **My server** | Ollama on another machine, LM Studio, llama.cpp server, vLLM, LiteLLM or any OpenAI-compatible endpoint. | Only to that server. |
| **Cloud** | OpenAI, Anthropic, Groq, OpenRouter, Together, Mistral or DeepSeek, with your own API key. | To that provider, to write the notes and answer questions. |

Keys are encrypted with the operating system keychain (DPAPI on Windows, Keychain on Mac) and are never shown again once saved. Each form has a **Test** button that makes one small request, and the status bar at the bottom left always says which model is in use and turns teal when notes leave the machine. The notes footer records which model wrote them.

For the local choice, Muesli suggests a model by memory (graphics memory, or unified memory on a Mac). Any other installed Ollama model can be chosen.

| Memory available | Suggested model | Download |
| --- | --- | --- |
| 24 GB or more | `qwen3.8:27b` | 17.7 GB |
| 16 GB | `qwen3.5:9b-q8_0` | 10.7 GB |
| 10 GB | `qwen3.5:9b` | 6.6 GB |
| 8 GB or less | `qwen3.5:4b` | 3.4 GB |

## Other things it does

- **Live transcript:** watch the transcript appear a few seconds behind the call while you record. On a machine with a graphics card or Apple silicon, the meeting is also transcribed properly in pieces of two to five minutes as it goes, so pressing Stop leaves only the last piece to do.
- **Your words:** click any word in a transcript to fix it or have it remembered. A fix can apply every time, or be left for Muesli to judge: when the misheard word turns up in a later meeting, the notes model reads the sentence and decides whether it was misheard again. Near misses of your terms are corrected by sound, but only words that are not everyday English. Every automatic change is underlined and can be changed back or banned.
- **Your field:** switch on the vocabulary of software, medicine, law, finance or sales so acronyms and specialist terms come out right.
- **Interrupted recordings:** if the computer sleeps or Muesli is closed mid-meeting, the audio is kept and the meeting offers "Finish this recording".
- **Speakers:** when several people talk on the other side, Muesli tells their voices apart ("Them 1", "Them 2").
- **Ask:** put questions to any meeting ("What did I commit to?"). Answers come from the transcript, with links to the moment each thing was said.
- **Ask your meetings:** one question across every meeting, found by meaning as well as by words; the answer names the meeting each point came from.
- **Call detection (Windows):** when Zoom, Teams or a browser opens your microphone, Muesli offers to record. One click starts it.
- **Languages:** pick the spoken language in Settings; transcript and notes follow it.
- **Microphone:** uses the system default, or pick a specific one in Settings (a headset, say). Appearance can be dark, light or follow the system.
- **Assistants (MCP):** switch it on in Settings and Claude or any MCP client on your computer can list, search and read your meetings, and pull open action items. Read-only, local and token-protected. See [Assistants (MCP)](#assistants-mcp).
- **Templates:** General, 1:1, Sales call, Standup. Change the template and rewrite the notes at any time; a folder can have its own default template.
- **Recap so far:** during a long call, ask for a summary of what has been said up to now without stopping the recording.
- **Calendar:** paste your calendar's private ICS link (Google, Outlook, iCloud) and Muesli lists what is coming up, names the meeting, fills in who is there and offers to record when it starts. The calendar is only downloaded; nothing is sent.
- **Folders and people:** file meetings into folders and note who was there. Both are searchable.
- **Name the speakers:** click "Them 1" in the transcript and give the voice a name. When somebody answers to a name more than once, or introduces themselves, Muesli puts the name in for you, marked as a guess until you confirm it.
- **Voice profiles:** name a voice once and Muesli recognises that person in later meetings. Your own voice is learned from your microphone during calls, with no setup. A profile is a short list of numbers, not audio, and stays on your computer; forget anyone in Settings.
- **Your own templates:** add a template in Settings with the headings you want.
- **Recipes:** save any question as a one-click chip.
- **Edit anything:** click a line of the notes or the email to change it.
- **Hear it:** click the time on any line of the notes or transcript to hear that moment, your side and theirs both.
- **Pin and bin:** pin a meeting to the top of the list; deleting one gives you six seconds to undo.
- **Export:** PDF or Markdown, as well as copy. Exports say who said each line and when.
- **Share as a web page:** one self-contained file with the notes, action items, email and transcript. It opens in any browser, on a phone too, with nothing hosted anywhere.
- **Import a recording:** a voice memo from your phone or any audio file becomes a meeting with transcript and notes.
- **Shared storage:** keep the meetings folder anywhere, including a shared or synced drive.
- **Search** across every meeting.
- **Plain files:** each meeting is a folder in `Documents/Muesli` holding the audio, transcript and notes.
- **Automation:** add a webhook URL in Settings and Muesli posts the notes, action items, email, transcript, folder and people as JSON after each meeting. This fits n8n, Make or Zapier. It is off until you add a URL.
- **Light and dark** themes.

## Assistants (MCP)

Muesli can serve your meetings to Claude and other assistants over the [Model Context Protocol](https://modelcontextprotocol.io). It is off until you switch on **Settings › Assistants**. Then:

- **Read-only.** Assistants can list, search and read meetings. They cannot change or delete anything.
- **Local.** The server listens on `127.0.0.1:3939` only, and turns away requests from web pages.
- **Token-protected.** Switching it on makes a random token; every request must carry it. **Regenerate token** in Settings makes a new one, and anything set up with the old one stops working.

Settings shows both setups with the token already filled in, ready to copy.

**Claude Code** (Streamable HTTP):

```bash
claude mcp add --transport http muesli http://127.0.0.1:3939/mcp --header "Authorization: Bearer <token>"
```

**Claude Desktop and other stdio apps:** add Muesli to the app's MCP config. This runs Muesli's own binary as a small bridge that passes messages to the running Muesli, so Muesli has to be open. Settings shows it with your install path filled in.

```json
{ "mcpServers": { "muesli": {
  "command": "C:\\Users\\you\\AppData\\Local\\Programs\\Muesli\\Muesli.exe",
  "args": ["C:\\Users\\you\\AppData\\Local\\Programs\\Muesli\\resources\\app.asar\\src\\mcp-stdio.js"],
  "env": { "ELECTRON_RUN_AS_NODE": "1" } } } }
```

`Muesli --mcp` starts the same bridge from a terminal, but on Windows Electron writes a blank line to stdout first, which strict clients reject.

From source, use `"command": "node", "args": ["<path to>/src/mcp-stdio.js"]` instead. The bridge reads the token from Muesli's settings file.

**Tools**

| Tool | What it does |
| --- | --- |
| `list_meetings` | Newest first, with `limit`, `offset`, `folder`, `person`, `from` and `to` (ISO dates). Returns `total` and `nextOffset` for paging. |
| `search_meetings` | Up to 20 meetings matching the text, each with up to 3 matching lines (transcript lines carry their `mm:ss`). Optional `folder`. |
| `get_meeting` | One meeting as Markdown (notes, action items, email, rough notes, transcript), plus the same as structured data. |
| `get_action_items` | Open action items from the last `days` (default 30), optionally for one `person`, each with its meeting. |

**Resources:** `muesli://meeting/<id>` (the notes as Markdown) and `muesli://meeting/<id>/transcript`. The newest 50 meetings are listed.

**Prompts:** `weekly_recap` (`days`, default 7) and `prep_for` (`name`: a person or company) hand the assistant the relevant meetings' notes with a short instruction.

## Run from source

```bash
npm install
npm start
```

A source checkout expects a `whisper-cli` binary under `vendor/whisper` and the Whisper model files under `models/`. The Mac build recipe in `.github/workflows/mac.yml` shows where each file comes from.

## Recording other people

Laws on recording calls vary by place. Tell the people on the call that you are recording. Muesli reminds you each time you start.

## Licence

ISC. Bundled components are listed in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
