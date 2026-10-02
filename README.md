# Muesli

Meeting notes that never leave your computer.

Muesli sits in the tray, records both sides of a call, transcribes it, and turns your rough jottings plus the transcript into clean notes, action items and a follow-up email. Everything runs on your own machine. No bot joins the meeting, there is no account, and nothing is uploaded.

## Try it

1. Install [Ollama](https://ollama.com/download) and open it. Muesli uses it to write the notes.
2. Download Muesli from the [releases page](https://github.com/pawpadnotes/muesli/releases):
   - **Windows:** `Muesli-Setup-0.1.0.exe`. The build is not code-signed, so Windows SmartScreen will ask; choose "More info", then "Run anyway".
   - **Mac (Apple Silicon):** `Muesli-mac-arm64.zip`. Unzip, then right-click the app and choose Open the first time. macOS asks for microphone and system-audio permission when you first record.
3. Open Muesli. It checks your memory, suggests a notes model that fits, and downloads it with one button.
4. Open the sample meeting to see finished notes straight away, or press **New meeting** and **Record**.

## How it works

| Step | What happens |
| --- | --- |
| Record | Your microphone and the call audio are captured as two separate tracks, so Muesli knows who said what without a bot in the call. |
| Jot | Type rough notes while you talk. They steer what the finished notes focus on. |
| Enhance | The transcript and your jottings become notes, action items and a follow-up email. Lines that came from your own notes are marked with a green dot; each line links to its moment in the transcript. |

Transcription is done by [whisper.cpp](https://github.com/ggml-org/whisper.cpp), which ships inside the app. Notes are written by a model running in Ollama.

## Notes model

Muesli picks the largest model that fits your graphics memory (or unified memory on a Mac). You can choose any other installed Ollama model in Settings.

| Memory available | Suggested model | Download |
| --- | --- | --- |
| 24 GB or more | `qwen3.8:27b` | 17.7 GB |
| 16 GB | `qwen3.5:9b-q8_0` | 10.7 GB |
| 10 GB | `qwen3.5:9b` | 6.6 GB |
| 8 GB or less | `qwen3.5:4b` | 3.4 GB |

## Other things it does

- **Live transcript:** watch the transcript appear a few seconds behind the call while you record.
- **Speakers:** when several people talk on the other side, Muesli tells their voices apart ("Them 1", "Them 2").
- **Ask:** put questions to any meeting ("What did I commit to?"). Answers come from the transcript, with links to the moment each thing was said.
- **Ask your meetings:** one question across every meeting; the answer names the meeting each point came from.
- **Call detection (Windows):** when Zoom, Teams or a browser opens your microphone, Muesli offers to record. One click starts it.
- **Languages:** pick the spoken language in Settings; transcript and notes follow it.
- **Assistants (MCP):** switch it on in Settings and Claude or any MCP client on your computer can list, search and read your meetings. Read-only and local.
- **Templates:** General, 1:1, Sales call, Standup. Change the template and rewrite the notes at any time.
- **Search** across every meeting.
- **Plain files:** each meeting is a folder in `Documents/Muesli` holding the audio, transcript and notes.
- **Automation:** add a webhook URL in Settings and Muesli posts the notes, action items, email and transcript as JSON after each meeting. This fits n8n, Make or Zapier. It is off until you add a URL, and it is the only time anything leaves the machine.
- **Light and dark** themes.

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
