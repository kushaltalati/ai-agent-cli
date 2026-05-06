import "dotenv/config";
import axios from "axios";
import readline from "readline";
import path from "path";
import fs from "fs/promises";
import { exec } from "child_process";
import { OpenAI } from "openai";

if (!process.env.GROQ_API_KEY) {
  console.error(
    "Missing GROQ_API_KEY. Copy .env.example to .env and paste a free key from https://console.groq.com/keys"
  );
  process.exit(1);
}

const MODEL = process.env.MODEL || "llama-3.3-70b-versatile";
const MIN_DELAY_MS = Number(process.env.MIN_DELAY_MS || 3000);
const PROJECT_ROOT = process.cwd();
const MAX_TURN_CALLS = 30;
const MAX_TOOL_ERRORS = 4;
const MAX_HISTORY_CHARS = 20_000;

const client = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: "https://api.groq.com/openai/v1",
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const truncate = (s, n) => {
  if (s == null) return "";
  const str = String(s);
  return str.length > n ? str.slice(0, n) + "…" : str;
};

function safePath(target) {
  const resolved = path.resolve(PROJECT_ROOT, target);
  if (!resolved.startsWith(PROJECT_ROOT)) {
    throw new Error(`Refusing to touch a path outside the project: ${target}`);
  }
  return resolved;
}

async function getTheWeatherOfCity(cityname = "") {
  const { data } = await axios.get(
    `https://wttr.in/${String(cityname).toLowerCase()}?format=%C+%t`,
    { responseType: "text" }
  );
  return `The Weather of ${cityname} is ${data}`;
}

async function getGithubDetailsAboutUser(username = "") {
  const { data } = await axios.get(`https://api.github.com/users/${username}`);
  return {
    login: data.login,
    name: data.name,
    blog: data.blog,
    public_repos: data.public_repos,
  };
}

function executeCommand(cmd = "") {
  return new Promise((resolve) => {
    exec(cmd, { cwd: PROJECT_ROOT, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) resolve(`ERROR: ${err.message}\n${stderr || ""}`);
      else resolve(stdout.trim() || `Command executed: ${cmd}`);
    });
  });
}

async function fetchUrl(args) {
  const url = typeof args === "string" ? args.trim().replace(/^['"]|['"]$/g, "") : args?.url;
  if (!url) return "fetchUrl needs a URL string.";
  const { data } = await axios.get(url, {
    timeout: 15_000,
    headers: { "User-Agent": "Mozilla/5.0 (compatible; ai-agent-cli/1.0)" },
    responseType: "text",
    transformResponse: [(d) => d],
  });
  const html = String(data);
  const stripped = html
    .replace(/<script\b[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[\s\S]*?<\/style>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const cap = 8000;
  return stripped.length > cap ? stripped.slice(0, cap) + "…[truncated]" : stripped;
}

async function createFolder(args) {
  const target = safePath(typeof args === "string" ? args : args?.path || "");
  await fs.mkdir(target, { recursive: true });
  return `Folder ready: ${path.relative(PROJECT_ROOT, target) || "."}`;
}

function coerceWriteArgs(raw) {
  if (raw && typeof raw === "object") return raw;
  if (typeof raw !== "string") return null;
  try {
    const obj = JSON.parse(raw);
    if (obj && typeof obj === "object") return obj;
  } catch {
    // fall through to lenient extraction below
  }
  const pathMatch = raw.match(/"path"\s*:\s*"((?:\\.|[^"\\])*)"/);
  if (!pathMatch) return null;
  const filePath = pathMatch[1].replace(/\\(.)/g, "$1");
  const contentKey = raw.indexOf('"content"');
  if (contentKey === -1) return null;
  const colon = raw.indexOf(":", contentKey);
  const firstQuote = raw.indexOf('"', colon + 1);
  if (firstQuote === -1) return null;
  let i = firstQuote + 1;
  let esc = false;
  let endQuote = -1;
  while (i < raw.length) {
    const ch = raw[i];
    if (esc) esc = false;
    else if (ch === "\\") esc = true;
    else if (ch === '"') {
      const after = raw.slice(i + 1).trimStart();
      if (after.startsWith("}") || after.startsWith(",") || after === "") {
        endQuote = i;
        break;
      }
    }
    i++;
  }
  if (endQuote === -1) {
    const lastBrace = raw.lastIndexOf("}");
    let j = lastBrace - 1;
    while (j > firstQuote && /\s/.test(raw[j])) j--;
    if (raw[j] === '"') endQuote = j;
  }
  if (endQuote === -1) return null;
  const content = raw
    .slice(firstQuote + 1, endQuote)
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\");
  return { path: filePath, content };
}

async function writeFile(args) {
  const parsed = coerceWriteArgs(args);
  if (!parsed?.path || parsed.content == null) {
    throw new Error('writeFile needs {"path":"...","content":"..."}');
  }
  const lower = parsed.path.toLowerCase();
  const trimmed = parsed.content.trim();
  if (lower.endsWith(".html")) {
    if (trimmed.length < 2500) {
      throw new Error(
        `HTML too short (${trimmed.length} chars). Re-emit writeFile with the COMPLETE markup — every section fully populated, ≥2500 chars. No skeletons or one-line files.`
      );
    }
    if (/<(header|main|footer|section|nav)>\s*<\/\1>/i.test(trimmed)) {
      throw new Error(
        "HTML contains empty semantic tags (e.g. <header></header>). Fill every section with real content and re-emit writeFile."
      );
    }
  }
  if (lower.endsWith(".css") && trimmed.length < 1500) {
    throw new Error(
      `CSS too short (${trimmed.length} chars). Provide complete styles for every component referenced in the HTML — header, hero, sections, footer, plus a responsive @media block. Re-emit writeFile with ≥1500 chars.`
    );
  }
  const target = safePath(parsed.path);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, parsed.content, "utf8");
  return `Wrote ${parsed.content.length} bytes → ${parsed.path}`;
}

async function writeFileBase64(args) {
  const obj =
    typeof args === "object" && args
      ? args
      : (() => {
          try {
            return JSON.parse(args);
          } catch {
            return null;
          }
        })();
  if (!obj?.path || !(obj.content_base64 || obj.content)) {
    throw new Error('writeFileBase64 needs {"path":"...","content_base64":"..."}');
  }
  const target = safePath(obj.path);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const buf = Buffer.from(String(obj.content_base64 || obj.content).replace(/\s+/g, ""), "base64");
  if (!buf.length) throw new Error("decoded base64 is empty");
  await fs.writeFile(target, buf);
  return `Wrote ${buf.length} bytes (base64) → ${obj.path}`;
}

async function readFileTool(args) {
  const target = safePath(typeof args === "string" ? args : args?.path || "");
  const data = await fs.readFile(target, "utf8");
  return data.length > 4000 ? data.slice(0, 4000) + "\n…[truncated]" : data;
}

async function listDir(args) {
  const target = safePath(typeof args === "string" ? args || "." : args?.path || ".");
  const entries = await fs.readdir(target, { withFileTypes: true });
  return entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).join("\n");
}

const tool_map = {
  getTheWeatherOfCity,
  getGithubDetailsAboutUser,
  executeCommand,
  fetchUrl,
  createFolder,
  writeFile,
  writeFileBase64,
  readFile: readFileTool,
  listDir,
};

const SYSTEM_PROMPT = `You are an AI coding agent that builds real files on disk to satisfy a user's instruction.
You reply with EXACTLY ONE JSON object per turn — never multiple, never plain prose, never markdown fences.

Each reply has the shape:
{"step":"START | THINK | TOOL | OUTPUT","content":"...","tool_name":"<optional>","tool_args":"<optional>"}

Tools (tool_args is a string unless noted):
- fetchUrl(url) — GETs a URL and returns the visible text/markup (script/style/comments stripped, truncated). Use this to study the real target before generating a clone.
- createFolder(path)
- writeFile({"path":"...","content":"..."}) — tool_args MUST be a JSON-encoded string. Escape newlines as \\n and quotes as \\". Write the COMPLETE final file in one call.
- writeFileBase64({"path":"...","content_base64":"..."}) — fallback for very long files where escaping JSON is fragile.
- readFile(path), listDir(path), executeCommand(cmd)
- getTheWeatherOfCity(city), getGithubDetailsAboutUser(username)

Loop:
- Turn 1: emit ONE START with a one-sentence summary of the goal.
- Turn 2: emit ONE THINK with the plan as a numbered list.
- Turns 3+: emit TOOL calls one at a time. After each TOOL, the runtime sends back an OBSERVE message — read it before the next step.
- Final turn: emit OUTPUT telling the user what was produced and how to view it.

Never loop on THINK. After one THINK, take action. Never write skeleton files (empty <header></header>, "// TODO" placeholders, etc.) — every file must be the COMPLETE final content in one writeFile call.

CONTENT QUALITY (hard requirements — the writeFile tool will reject undersized files):
- index.html MUST be ≥2500 characters with COMPLETE markup. No empty <header></header> or <section></section>. Real headings, real paragraphs, real nav links, real footer columns. Use semantic tags.
- style.css MUST be ≥1500 characters with rules for every class referenced in the HTML, CSS custom properties for the palette, flex/grid layouts, hover states, and at least one responsive @media block.
- script.js MUST have at least one real interactive behavior whose selectors actually exist in the HTML (mobile nav toggle, smooth-scroll, project filter, theme switch, etc.).
- LINKS MUST BE REAL when cloning a real site. Never use href="#" for nav/footer items. If you fetched the target URL, use the real absolute URLs you read (or sensible deep links like https://www.example.com/about). Social icons must point to actual social profiles when known, not "#".

Cloning a website:
1. Optionally call fetchUrl on the target URL to read real headings, nav links, footer columns, palette cues.
2. createFolder for the project (e.g. "<site>-clone" — use a slug derived from the user's request).
3. writeFile index.html — full structure: header with logo + nav, hero with big headline + subhead + CTA, 2–3 content sections, multi-column footer.
4. writeFile style.css — palette via :root vars, header layout, hero styling, section styling, footer grid, responsive media query.
5. writeFile script.js — real interactive behavior with working selectors.
6. listDir on the folder to confirm.
7. OUTPUT: tell the user the exact relative file path to open.

Building any other site/app: same content-quality bar applies. Generate substantial, finished pages — never skeletons.

Example turn-by-turn:
{"step":"START","content":"Cloning https://example.com into a static page."}
{"step":"THINK","content":"Plan: 1) fetchUrl example.com  2) make folder  3) write index.html, style.css, script.js  4) list and report."}
{"step":"TOOL","tool_name":"fetchUrl","tool_args":"https://example.com"}
{"step":"TOOL","tool_name":"createFolder","tool_args":"example-clone"}
{"step":"TOOL","tool_name":"writeFile","tool_args":"{\\"path\\":\\"example-clone/index.html\\",\\"content\\":\\"<!doctype html>...\\"}"}
{"step":"OUTPUT","content":"Done. Open example-clone/index.html in a browser."}`;

function extractJsonObjects(text) {
  if (!text) return [];
  const cleaned = text.replace(/```(?:json)?/gi, "").replace(/```/g, "");
  const out = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      continue;
    }
    if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0 && start >= 0) {
        try {
          out.push(JSON.parse(cleaned.slice(start, i + 1)));
        } catch {
          /* skip */
        }
        start = -1;
      }
    }
  }
  return out;
}

function trimHistory(messages) {
  let total = messages.reduce((n, m) => n + (m.content?.length ?? 0), 0);
  if (total <= MAX_HISTORY_CHARS) return;
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 1; i--) {
    if (messages[i].role === "user") {
      lastUserIdx = i;
      break;
    }
  }
  let i = 1;
  while (total > MAX_HISTORY_CHARS && i < messages.length - 1) {
    if (i === lastUserIdx) {
      i++;
      continue;
    }
    total -= messages[i].content?.length ?? 0;
    messages.splice(i, 1);
    if (lastUserIdx > i) lastUserIdx--;
  }
}

let lastCallAt = 0;
let totalCalls = 0;
async function callModel(messages) {
  trimHistory(messages);
  const since = Date.now() - lastCallAt;
  if (since < MIN_DELAY_MS) await sleep(MIN_DELAY_MS - since);

  let attempt = 0;
  while (true) {
    try {
      lastCallAt = Date.now();
      totalCalls++;
      return await client.chat.completions.create({
        model: MODEL,
        messages,
        response_format: { type: "json_object" },
        temperature: 0.3,
      });
    } catch (err) {
      const status = err?.status ?? err?.response?.status;
      if (status === 429 && attempt < 5) {
        const wait = Math.min(60_000, 5_000 * 2 ** attempt);
        console.log(`[rate-limit] 429 — waiting ${wait / 1000}s (attempt ${attempt + 1}/5)`);
        await sleep(wait);
        attempt++;
        continue;
      }
      if (status === 503 && attempt < 3) {
        const wait = 8_000 * (attempt + 1);
        console.log(`[upstream] 503 — waiting ${wait / 1000}s (attempt ${attempt + 1}/3)`);
        await sleep(wait);
        attempt++;
        continue;
      }
      throw err;
    }
  }
}

async function runAgentTurn(messages) {
  let calls = 0;
  let toolErrors = 0;

  while (calls < MAX_TURN_CALLS) {
    calls++;
    const response = await callModel(messages);
    const raw = response.choices?.[0]?.message?.content ?? "";
    const objects = extractJsonObjects(raw);

    if (!objects.length) {
      if (calls >= 4) {
        console.log("[!] No valid JSON in 4 attempts — aborting turn.");
        return;
      }
      messages.push({
        role: "user",
        content:
          'Your last reply had no parsable JSON. Reply with exactly ONE JSON object such as {"step":"TOOL","tool_name":"createFolder","tool_args":"my-site"}.',
      });
      continue;
    }

    messages.push({ role: "assistant", content: raw });

    let producedTool = false;
    let producedOutput = false;
    let toolFailed = false;

    for (const parsed of objects) {
      if (!parsed.step) continue;
      if (parsed.step === "START") {
        console.log(`\n[START] ${parsed.content ?? ""}`);
      } else if (parsed.step === "THINK") {
        console.log(`[THINK] ${parsed.content ?? ""}`);
      } else if (parsed.step === "TOOL") {
        const argPreview =
          typeof parsed.tool_args === "string"
            ? parsed.tool_args
            : JSON.stringify(parsed.tool_args ?? "");
        console.log(`[TOOL]  ${parsed.tool_name}(${truncate(argPreview, 90)})`);
        const fn = tool_map[parsed.tool_name];
        let observation;
        if (!fn) {
          observation = `Tool "${parsed.tool_name}" is not available.`;
          toolFailed = true;
        } else {
          try {
            const result = await fn(parsed.tool_args);
            observation = typeof result === "string" ? result : JSON.stringify(result);
          } catch (err) {
            observation = `Tool error: ${err.message}`;
            toolFailed = true;
          }
        }
        console.log(`[OBS]   ${truncate(observation, 200)}`);
        messages.push({
          role: "user",
          content: JSON.stringify({ step: "OBSERVE", content: observation }),
        });
        if (
          !toolFailed &&
          (parsed.tool_name === "writeFile" || parsed.tool_name === "writeFileBase64")
        ) {
          const last = messages[messages.length - 2];
          if (last?.role === "assistant") {
            last.content = JSON.stringify({
              step: "TOOL",
              tool_name: parsed.tool_name,
              note: `[content omitted from history to save tokens — file written successfully]`,
            });
          }
        }
        producedTool = true;
        break;
      } else if (parsed.step === "OUTPUT") {
        console.log(`\n[OUTPUT] ${parsed.content ?? ""}\n`);
        producedOutput = true;
        break;
      }
    }

    if (producedOutput) return;
    if (producedTool) {
      toolErrors = toolFailed ? toolErrors + 1 : 0;
      if (toolErrors >= MAX_TOOL_ERRORS) {
        console.log(`[!] ${toolErrors} consecutive tool errors — aborting turn.`);
        return;
      }
      continue;
    }

    messages.push({
      role: "user",
      content:
        'Continue. Either call a tool now or emit OUTPUT if you are done. Reply with one JSON object.',
    });
    if (calls >= 8) {
      console.log("[!] Too many think-only turns — aborting.");
      return;
    }
  }
  console.log(`[!] Hit ${MAX_TURN_CALLS}-call cap for this turn.`);
}

async function main() {
  const messages = [{ role: "system", content: SYSTEM_PROMPT }];
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let closed = false;
  rl.on("close", () => {
    closed = true;
  });
  const ask = () =>
    new Promise((res, rej) => {
      if (closed) return rej(new Error("closed"));
      try {
        rl.question("you > ", (l) => res(l));
      } catch (err) {
        rej(err);
      }
    });

  console.log("AI Agent CLI — chat with the agent. Type 'exit' to quit.");
  console.log(`Model: ${MODEL}`);
  console.log('Try: "clone <any-url>" or "build a <type> site for <whom>".\n');

  while (!closed) {
    let line;
    try {
      line = (await ask()).trim();
    } catch {
      break;
    }
    if (!line) continue;
    if (["exit", "quit", ":q"].includes(line.toLowerCase())) {
      rl.close();
      break;
    }
    messages.push({ role: "user", content: line });
    try {
      await runAgentTurn(messages);
    } catch (err) {
      console.error(`\n[error] ${err.message}\n`);
    }
    console.log(`(model calls so far: ${totalCalls})`);
  }
  console.log(`\nbye. (model calls this session: ${totalCalls})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
