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

const DEFAULT_MODEL_CHAIN = [
  "llama-3.3-70b-versatile",
  "meta-llama/llama-4-maverick-17b-128e-instruct",
  "meta-llama/llama-4-scout-17b-16e-instruct",
  "llama-3.1-8b-instant",
];
const MODELS = (() => {
  if (process.env.MODELS) {
    return process.env.MODELS.split(",").map((s) => s.trim()).filter(Boolean);
  }
  const primary = process.env.MODEL?.trim();
  const chain = primary ? [primary, ...DEFAULT_MODEL_CHAIN] : [...DEFAULT_MODEL_CHAIN];
  return [...new Set(chain)];
})();
let modelIdx = 0;
const currentModel = () => MODELS[modelIdx];
function rotateModel(reason) {
  if (modelIdx + 1 < MODELS.length) {
    modelIdx++;
    console.log(`[model] switching to ${MODELS[modelIdx]} (${reason})`);
    return true;
  }
  console.log(`[model] no more fallbacks (last tried: ${MODELS[modelIdx]})`);
  return false;
}
const MIN_DELAY_MS = Number(process.env.MIN_DELAY_MS || 3000);
const PROJECT_ROOT = process.cwd();
const MAX_TURN_CALLS = 40;
const MAX_TOOL_ERRORS = 8;
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
  let url;
  if (typeof args === "object" && args) {
    url = args.url || args.path || args._raw;
  } else if (typeof args === "string") {
    const trimmed = args.trim().replace(/^['"]|['"]$/g, "");
    if (trimmed.startsWith("{")) {
      try {
        const obj = JSON.parse(trimmed);
        url = obj.url || obj.path;
      } catch {
        url = trimmed;
      }
    } else {
      url = trimmed;
    }
  }
  if (!url || !/^https?:\/\//i.test(url)) {
    return `fetchUrl needs a URL starting with http:// or https://. Got: ${truncate(String(url), 80)}`;
  }
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
  const cap = 2500;
  return stripped.length > cap ? stripped.slice(0, cap) + "…[truncated]" : stripped;
}

function parseArgs(args) {
  if (args == null) return {};
  if (typeof args === "object") return args;
  if (typeof args !== "string") return {};
  const trimmed = args.trim().replace(/^['"]|['"]$/g, "");
  if (trimmed.startsWith("{")) {
    try {
      const obj = JSON.parse(trimmed);
      if (obj && typeof obj === "object") return obj;
    } catch {
      // fall through
    }
  }
  return { _raw: trimmed };
}

function pathFromArgs(args) {
  const a = parseArgs(args);
  return a.path || a.dir || a.folder || a.url || a._raw || "";
}

async function createFolder(args) {
  const p = pathFromArgs(args);
  if (!p) throw new Error("createFolder needs a path");
  const target = safePath(p);
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
    if (trimmed.length < 2000) {
      throw new Error(
        `HTML too short (${trimmed.length} chars, need 2000+). Include doctype, head with title + meta viewport + link to ./style.css, and body with nav, header hero, main containing 3+ section blocks with real content, and footer. Use appendFile to add more after the initial write.`
      );
    }
    if (/<(header|main|footer|section)>\s*<\/\1>/i.test(trimmed)) {
      throw new Error(
        "HTML has an empty <header>, <main>, <footer>, or <section>. Put real content inside each."
      );
    }
    const sectionCount = (trimmed.match(/<section\b/gi) || []).length;
    if (sectionCount < 3) {
      throw new Error(
        `HTML only has ${sectionCount} <section> block(s), need 3+ inside <main> (e.g. about, services, contact).`
      );
    }
    if (!/<nav\b/i.test(trimmed)) {
      throw new Error("HTML has no <nav>. Add a navigation bar with links to the page sections.");
    }
    if (
      /\/_next\/|\/storyblok-assets\/|data-dpl-id=|githubassets\.com|data-color-mode=|data-a11y-|fbcdn\.net|cdn\.jsdelivr\.net.*hash|integrity="sha/i.test(
        trimmed
      )
    ) {
      throw new Error(
        "Looks like raw fetched HTML (CDN/asset markers detected). Write fresh, hand-coded markup with semantic tags and link only to ./style.css and ./script.js — don't paste the page back."
      );
    }
  }
  if (lower.endsWith(".css")) {
    if (trimmed.length < 800) {
      throw new Error(
        `CSS too short (${trimmed.length} chars, need 800+). Include a reset, body typography, color variables, nav, hero with CTA, sections, a grid for cards, footer, and at least one @media query. Use appendFile to add more.`
      );
    }
    if (!/@media\b/i.test(trimmed)) {
      throw new Error("CSS has no @media query. Add a mobile breakpoint, e.g. @media (max-width: 720px).");
    }
    if (!/:hover\b/i.test(trimmed)) {
      throw new Error("CSS has no :hover state. Add hover styles on buttons and nav links.");
    }
  }
  const target = safePath(parsed.path);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, parsed.content, "utf8");
  return `Wrote ${parsed.content.length} bytes → ${parsed.path}`;
}

async function appendFile(args) {
  const parsed = coerceWriteArgs(args);
  if (!parsed?.path || parsed.content == null) {
    throw new Error('appendFile needs {"path":"...","content":"..."}');
  }
  const target = safePath(parsed.path);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.appendFile(target, parsed.content, "utf8");
  const stat = await fs.stat(target);
  return `Appended ${parsed.content.length} bytes to ${parsed.path} (now ${stat.size} bytes)`;
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
  const p = pathFromArgs(args);
  if (!p) throw new Error("readFile needs a path");
  const target = safePath(p);
  const data = await fs.readFile(target, "utf8");
  return data.length > 4000 ? data.slice(0, 4000) + "\n…[truncated]" : data;
}

async function listDir(args) {
  const p = pathFromArgs(args) || ".";
  const target = safePath(p);
  const entries = await fs.readdir(target, { withFileTypes: true });
  return entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).join("\n");
}

async function scaffoldClone(args) {
  const a = parseArgs(args);
  const raw = String(a.name || a.site || a.path || a._raw || "").toLowerCase();
  const available = await fs.readdir(safePath("templates")).catch(() => []);
  const candidates = [
    raw,
    raw.replace(/\.(com|org|io|in|net|co)\/?$/i, ""),
    raw.replace(/^https?:\/\//, "").replace(/^www\./, ""),
    raw.replace(/-clone$/, ""),
    raw.replace(/_clone$/, ""),
    raw.split(/[\/.\s-]/)[0],
  ]
    .map((s) => s.replace(/[^a-z0-9]/g, ""))
    .filter(Boolean);
  const name = candidates.find((c) => available.includes(c));
  if (!name) {
    throw new Error(
      `No template matched "${raw}". Available templates: ${available.join(", ") || "(none)"}. Call scaffoldClone with one of those exact names.`
    );
  }
  const templatesDir = safePath(`templates/${name}`);
  const entries = await fs.readdir(templatesDir);
  const destDir = safePath(`${name}-clone`);
  await fs.mkdir(destDir, { recursive: true });
  for (const f of entries) {
    await fs.copyFile(path.join(templatesDir, f), path.join(destDir, f));
  }
  return `Scaffolded ${entries.length} polished files into ${name}-clone/ from templates/${name}/`;
}

const tool_map = {
  getTheWeatherOfCity,
  getGithubDetailsAboutUser,
  executeCommand,
  fetchUrl,
  createFolder,
  writeFile,
  writeFileBase64,
  appendFile,
  readFile: readFileTool,
  listDir,
  scaffoldClone,
};

async function buildSystemPrompt() {
  let templates = [];
  try {
    const all = await fs.readdir(safePath("templates"), { withFileTypes: true });
    templates = all.filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    templates = [];
  }
  const templateLine = templates.length
    ? `- scaffoldClone(name): copy a ready-made template from templates/<name>/ into <name>-clone/. Available templates: ${templates.map((t) => `"${t}"`).join(", ")}. Use this when the user asks for one of these sites.`
    : `- scaffoldClone(name): copy a ready-made template from templates/<name>/ into <name>-clone/. (No templates installed yet.)`;

  return `You are an AI coding agent that writes real static websites on disk.
Reply with EXACTLY ONE JSON object per turn. No prose, no markdown fences.
Shape: {"step":"START|THINK|TOOL|OUTPUT","content":"...","tool_name":"...","tool_args":"..."}

Tools:
- fetchUrl(url): GET a URL, returns stripped HTML/text. Use this to read a site before cloning it.
- createFolder(path)
- writeFile(JSON-string {"path":"...","content":"..."}): write a file. Escape newlines as \\n. Don't paste raw fetchUrl output. Link only to ./style.css and ./script.js.
- appendFile(JSON-string {"path":"...","content":"..."}): add more to a file you already wrote. Useful for building bigger pages in chunks.
${templateLine}
- readFile(path), listDir(path), executeCommand(cmd)
- getTheWeatherOfCity(city), getGithubDetailsAboutUser(user)

Loop: one START, then one THINK, then TOOL calls one at a time (wait for OBSERVE between each), then OUTPUT. Don't keep thinking, take action.

Folder name comes from the user's request. "clone scaler.com" -> "scaler-clone". "build a portfolio for jane" -> "jane-portfolio". "doctor portfolio" -> "doctor-portfolio".

Every site you build needs all three files: index.html, style.css, script.js. Don't OUTPUT until all three exist.

index.html (2000+ chars): doctype, head with title + viewport + link to ./style.css, body with <nav>, hero <header> (h1 + tagline + CTA), <main> with 3+ <section id="..."> blocks (e.g. about, services, contact), <footer>, <script src="./script.js"></script>. Use real content for the persona, not "Welcome to my portfolio" filler.

style.css (800+ chars): reset / box-sizing, :root with color variables, body typography, nav with :hover, hero with CTA button, section spacing, a grid for cards with hover lift, footer, and at least one @media (max-width: 720px) block.

script.js: something that runs — mobile nav toggle, smooth-scroll, or scroll-reveal. Don't leave it empty.

Build flow (when the user asks to build a site from scratch):
1. createFolder
2. writeFile index.html
3. writeFile style.css
4. writeFile script.js
5. listDir
6. OUTPUT

Clone flow (when the user asks to clone a real URL):
- If a template exists, fetchUrl -> scaffoldClone(name) -> listDir -> OUTPUT.
- Otherwise fetchUrl -> createFolder -> writeFile index.html -> writeFile style.css -> writeFile script.js -> listDir -> OUTPUT.

If a writeFile is rejected for being too short or missing nav/section/@media/:hover, rewrite the file with the missing pieces and call writeFile again. Don't OUTPUT yet.

Example tool call:
{"step":"TOOL","tool_name":"writeFile","tool_args":"{\\"path\\":\\"site/index.html\\",\\"content\\":\\"<!doctype html>...\\"}"}`;
}

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
        model: currentModel(),
        messages,
        response_format: { type: "json_object" },
        temperature: 0.3,
        max_tokens: 4000,
      });
    } catch (err) {
      const status = err?.status ?? err?.response?.status;
      const body = err?.error?.message || err?.message || "";
      const code = err?.error?.code || err?.code || "";
      const isCtxLimit =
        /context[_ ]length|maximum context|too many tokens|tokens per minute|rate_limit_exceeded|tpm/i.test(
          `${body} ${code}`
        );
      if (status === 429) {
        if (attempt < 2) {
          const wait = 5_000 * (attempt + 1);
          console.log(
            `[rate-limit] 429 on ${currentModel()} — waiting ${wait / 1000}s (attempt ${attempt + 1}/2)${
              body ? `\n         ${truncate(body, 200)}` : ""
            }`
          );
          await sleep(wait);
          attempt++;
          continue;
        }
        if (rotateModel(isCtxLimit ? "tpm/context limit" : "rate-limited")) {
          attempt = 0;
          continue;
        }
      }
      if (status === 503 && attempt < 2) {
        const wait = 8_000 * (attempt + 1);
        console.log(
          `[upstream] 503 on ${currentModel()} — waiting ${wait / 1000}s (attempt ${attempt + 1}/2)`
        );
        await sleep(wait);
        attempt++;
        continue;
      }
      if ((status === 503 || status === 500 || status === 502) && rotateModel(`upstream ${status}`)) {
        attempt = 0;
        continue;
      }
      if ((status === 400 || status === 404) && /model|decommission|not[_ ]found/i.test(body)) {
        if (rotateModel("model unavailable")) {
          attempt = 0;
          continue;
        }
      }
      throw err;
    }
  }
}

async function runAgentTurn(messages) {
  let calls = 0;
  let toolErrors = 0;
  const created = { folders: new Set(), files: new Set() };

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
    let isProgressFailure = false;

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
        if (!parsed.tool_name) {
          observation = `Your last JSON had no "tool_name". Reply with one JSON object that includes both tool_name and tool_args. Available tools: ${Object.keys(tool_map).join(", ")}.`;
          toolFailed = true;
        } else if (!fn) {
          observation = `Tool "${parsed.tool_name}" is not available. Pick one of: ${Object.keys(tool_map).join(", ")}.`;
          toolFailed = true;
        } else {
          try {
            const result = await fn(parsed.tool_args);
            observation = typeof result === "string" ? result : JSON.stringify(result);
          } catch (err) {
            observation = `Tool error: ${err.message}`;
            toolFailed = true;
            if (
              (parsed.tool_name === "writeFile" || parsed.tool_name === "appendFile") &&
              /too short|empty <|missing a <nav|<section> block|@media|:hover/i.test(err.message)
            ) {
              isProgressFailure = true;
              observation += `\nQuality-bar rejection, the file was not written. Rewrite it with the missing pieces and call writeFile again. Don't OUTPUT yet.`;
            }
          }
        }
        console.log(`[OBS]   ${truncate(observation, 200)}`);
        messages.push({
          role: "user",
          content: JSON.stringify({ step: "OBSERVE", content: observation }),
        });
        if (
          parsed.tool_name === "writeFile" ||
          parsed.tool_name === "writeFileBase64" ||
          parsed.tool_name === "appendFile"
        ) {
          if (!toolFailed) {
            const a = coerceWriteArgs(parsed.tool_args);
            if (a?.path) created.files.add(a.path);
          }
          const last = messages[messages.length - 2];
          if (last?.role === "assistant") {
            last.content = JSON.stringify({
              step: "TOOL",
              tool_name: parsed.tool_name,
              note: toolFailed
                ? "[content omitted from history — write failed, see OBSERVE]"
                : "[content omitted from history — file written successfully]",
            });
          }
        }
        if (!toolFailed && parsed.tool_name === "createFolder") {
          const p = pathFromArgs(parsed.tool_args);
          if (p) created.folders.add(p);
        }
        producedTool = true;
        break;
      } else if (parsed.step === "OUTPUT") {
        console.log(`\n[OUTPUT] ${parsed.content ?? ""}\n`);
        if (created.files.size || created.folders.size) {
          console.log("Files created in this run:");
          for (const f of created.files) {
            const abs = path.resolve(PROJECT_ROOT, f);
            console.log(`  ${abs}`);
          }
          if (created.files.size === 0) {
            for (const d of created.folders) {
              console.log(`  ${path.resolve(PROJECT_ROOT, d)}/`);
            }
          }
          const firstHtml = [...created.files].find((p) => p.toLowerCase().endsWith(".html"));
          if (firstHtml) {
            const abs = path.resolve(PROJECT_ROOT, firstHtml);
            console.log("");
            console.log("To view the result in your browser, run:");
            console.log(`  open "${abs}"`);
            console.log("");
            console.log("Or double-click the file in Finder:");
            console.log(`  ${abs}`);
            console.log("");
          } else if (created.folders.size) {
            const firstFolder = [...created.folders][0];
            console.log("");
            console.log(`Created folder: ${path.resolve(PROJECT_ROOT, firstFolder)}/`);
            console.log("");
          }
        }
        producedOutput = true;
        break;
      }
    }

    if (producedOutput) return;
    if (producedTool) {
      if (toolFailed && !isProgressFailure) {
        toolErrors++;
      } else if (!toolFailed) {
        toolErrors = 0;
      }
      if (toolErrors >= MAX_TOOL_ERRORS) {
        console.log(`[!] ${toolErrors} consecutive protocol errors — aborting turn.`);
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
  const systemPrompt = await buildSystemPrompt();
  const messages = [{ role: "system", content: systemPrompt }];
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

  console.log("ai-agent-cli. type 'exit' to quit.");
  console.log(`model: ${currentModel()}${MODELS.length > 1 ? `  (fallbacks: ${MODELS.slice(1).join(", ")})` : ""}`);
  console.log('try: clone <any-url>  /  build a <type> site for <whom>\n');

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
