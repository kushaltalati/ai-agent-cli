# ai-agent-cli

Small conversational AI agent that runs in the terminal and writes real files. You type something like "clone scaler.com", it reasons through it step by step, calls tools, and ends up with an actual `index.html`/`style.css`/`script.js` on disk that you can open in a browser.

Built for Scaler Academy Assignment 02. The default demo task is cloning the Scaler website, but the agent itself isn't tied to that — give it any URL or any "build me X" request.

## What it can do

The model only ever replies with one JSON object per turn, so the runtime stays in control. The loop is:

```
START -> THINK -> TOOL -> OBSERVE -> TOOL -> OBSERVE ... -> OUTPUT
```

Tools the agent can call:

- `fetchUrl(url)` - pulls a page, strips scripts/styles, hands the visible markup back
- `createFolder(path)`
- `writeFile({path, content})` - writes a file, parent dirs created automatically
- `writeFileBase64(...)` - same but base64 (small models sometimes prefer this)
- `readFile`, `listDir`, `executeCommand`
- `scaffoldClone(name)` - copies a ready-made template from `templates/<name>/` into `<name>-clone/`. Drop a folder in `templates/` and it shows up automatically.
- `getTheWeatherOfCity`, `getGithubDetailsAboutUser` - left in from the assignment starter

Everything writes inside the project folder. There's a `safePath` check that refuses anything trying to escape it.

## Setup

You need Node 18+ and a free Groq API key from https://console.groq.com/keys (no card required).

```
git clone https://github.com/kushaltalati/ai-agent-cli.git
cd ai-agent-cli
npm install
cp .env.example .env
```

Open `.env`, paste your key after `GROQ_API_KEY=`, save.

```
npm start
```

You'll get a `you >` prompt. Type something like:

```
you > clone the scaler academy website
```

The agent will loop through its steps (`[START]`, `[THINK]`, `[TOOL]`, `[OBS]`, ..., `[OUTPUT]`). When it finishes it prints the absolute paths of every file it wrote and the exact command to open the page, e.g.:

```
To view the result in your browser, run:
  open "/Users/you/Desktop/ai-agent-cli/scaler-clone/index.html"
```

Paste that command back into the same terminal and the page opens in your default browser. Type `exit` when you're done with the session.

## Config

`.env` knobs (all optional except the key):

```
GROQ_API_KEY=...
MODEL=llama-3.3-70b-versatile
MODELS=llama-3.3-70b-versatile,meta-llama/llama-4-maverick-17b-128e-instruct,llama-3.1-8b-instant
MIN_DELAY_MS=1500
```

`MODELS` is a comma-separated fallback chain. If a model 429s (TPD/TPM exhausted) or 503s, the runtime rotates to the next one in the list and keeps the turn going. If you only set `MODEL`, the defaults are appended after it so you still get fallbacks for free.

## Templates

`templates/scaler/` is shipped as an example. When the user asks to clone Scaler, the agent calls `scaffoldClone("scaler")` and the runtime copies those files into `scaler-clone/`. This way the output is consistent regardless of which model you're on.

To add another, drop a folder like `templates/github/` with `index.html`/`style.css`/`script.js` and the agent will pick it up automatically. The list of available templates is injected into the prompt at startup.

For URLs without a template, the agent falls back to fetching the page and writing files itself.

## Notes on reliability

A few small things that took some iteration to get right:

- Lenient `writeFile` parser. Smaller models sometimes break JSON escaping on big HTML payloads, so the parser falls back to a regex extract if `JSON.parse` fails.
- After every successful `writeFile`, the assistant message holding the giant content is replaced with a short "[content omitted]" note. Otherwise the conversation history doubles every file you write and you hit token limits inside three calls.
- Throttle plus exponential backoff on 429s. Groq surfaces the actual reason (TPM, TPD, etc.) in the body so you can see what's happening.
- writeFile rejects files that don't meet a quality bar: HTML needs at least 2000 chars with a nav, hero, three sections, and footer; CSS needs at least 800 chars with a media query and hover state; script.js has to actually exist. The model gets the rejection back as an OBSERVE message and rewrites the file properly.
- Quality-bar rejections don't count as protocol errors. The agent only aborts on real protocol mistakes (missing tool_name, unknown tool, etc.), so the model gets plenty of room to retry a too-short HTML write without burning its error budget.
- Model fallback chain. On 429/503/decommissioned-model errors, the runtime backs off, then rotates to the next model in `MODELS` instead of dying mid-turn.

## Project layout

```
ai-agent-cli/
  .env.example
  .gitignore
  README.md
  package.json
  index.js
  templates/
    scaler/
      index.html
      style.css
      script.js
  scaler-clone/      # generated output (committed so it's visible in the repo)
    index.html
    style.css
    script.js
```

## Submission

- GitHub: https://github.com/kushaltalati/ai-agent-cli
- YouTube: https://youtu.be/n0Wcv-BZwoE
