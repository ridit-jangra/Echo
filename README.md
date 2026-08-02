# Miles

Miles is a partner which will help you research about "stuff", give you actual good advice, talk like a partner and not "ai chat bot" :D.

It will help you actually do stuff and help you manage yourself, it will handle your schedule, your slack, your github.

---

## Features

- **Voice-first interaction**, custom wake-word detection (OpenWakeWord), local Whisper transcription, and Piper text-to-speech for natural spoken conversation.
- **Specialized subagents**, dedicated agents for coding (`hank`), research and MCP tools (`scout`), web search/fetch (`merlin`), Slack drafting (`dexter`), and system/music control (`otto`), each with their own toolset and memory.
- **Screen and visual awareness**, webcam-based presence/attention detection (`argus`) and continuous screen/window context tracking (`iris`) so Miles knows what you're looking at and doing.
- **Proactive behavior**, habit tracking and unprompted nudges (`sybil`), a dated intention ledger that catches contradictions between what you said and what you did (`janus`), and alert triage that decides what's worth interrupting you for (`cerberus`).
- **Persistent memory**, per-agent read/write/edit memory tools backed by a durable store at `~/.echo/`, so context survives across sessions.
- **Integrations**, Slack (with writing-style mimicry), GitHub, and Chrome DevTools via MCP.
- **Scheduling & briefings**, reminders, do-not-disturb mode, and daily briefing generation.
- **Cross-platform desktop app**, Electron + React client with packaged builds for Linux & Windows. (macOS soon)

## Prerequisites

- **Node.js** 18+ and a package manager ([Bun](https://bun.sh) is used here; npm works too)
- **Python** 3.11 (see `.python-version`) with a virtual environment at `.venv`
- **PortAudio** for microphone capture (PyAudio dependency)
- An **Openrouter API key** for the AI agent
- _Optional:_ NVIDIA GPU + CUDA libraries for faster Whisper (CPU int8 fallback otherwise)

## Getting started

### 1. Install dependencies

```bash
bun install            # or: npm install

python -m venv .venv
.venv/bin/pip install -r requirements.txt
```

### 2. Download the speech models

Fetches the Piper voice, Whisper small model, and OpenWakeWord models into `models/` and the HF cache.

```bash
npm run download-models:linux      # Linux / macOS
npm run download-models:win        # Windows (PowerShell)
```

> **Custom wake word:** a custom pretrained custom model is already placed at `models/echo.onnx`. You can train yout custom wake words and use [OpenWakeWord Colab notebook](https://github.com/dscripka/openWakeWord).

### 3. Configure environment

Create a `.env` in the project root:

```dotenv
OPENROUTER_API_KEY=your_openrouter_key_here
GITHUB_CLIENT_ID=for_integrations...fallback_id_is_already_placed
# Optional wake tuning:
# WAKE_SCORE_THRESHOLD=0.15
# WAKE_INPUT_DEVICE=pulse
```

### 4. Run in development

Run the speech server and the desktop client in two terminals:

```bash
npm run start:server     # Python FastAPI on 127.0.0.1:8000 (start:server:win on Windows)
npm run start:client     # Electron + React with HMR
```

## Usage

2. Speak naturally. Miles transcribes, the agent reasons and acts, and the reply is spoken back.
3. Open **Integrations** in the sidebar to connect Slack, GitHub, or Chrome DevTools.

Runtime state lives in `~/.echo/`, user profile, memory, sessions, MCP config, and briefing state.

## Scripts

| Command                                  | Description                                   |
| ---------------------------------------- | --------------------------------------------- |
| `npm run start:client`                   | Electron app with hot reload                  |
| `npm run start:server`                   | Python speech server (with `--reload`)        |
| `npm run build`                          | Type-check + build the app                    |
| `npm run build:linux` / `:win` / `:mac`  | Package a distributable with electron-builder |
| `npm run typecheck`                      | Type-check node + web configs                 |
| `npm run lint` / `npm run format`        | ESLint / Prettier                             |
| `npm run download-models:linux` / `:win` | Download speech models                        |

## Configuration reference

Common environment variables read by the speech server (`src/core/server/server.py`):

| Variable               | Default | Purpose                        |
| ---------------------- | ------- | ------------------------------ |
| `WAKE_SCORE_THRESHOLD` | `0.15`  | Wake-word confidence threshold |
| `WAKE_INPUT_DEVICE`    | `pulse` | Input device name for capture  |
| `WAKE_COOLDOWN`        | `3.0`   | Seconds between wake triggers  |
| `WAKE_DEBUG`           | off     | Verbose detection logging      |

## License

[MIT](./LICENSE.txt)
