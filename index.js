import "dotenv/config";
import axios from "axios";
import { OpenAI } from "openai";
import { exec } from "child_process";
import { promises as fs } from "fs";
import path from "path";
import readline from "readline/promises";
import { stdin as input, stdout as output } from "process";

const MODEL = process.env.MODEL || "gemini-2.5-flash";
const MIN_DELAY_MS = Number(process.env.MIN_DELAY_MS || 6500);
const client = new OpenAI({
  apiKey: process.env.GEMINI_API_KEY,
  baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let lastCallAt = 0;
async function chatWithRetry(messages) {
  const since = Date.now() - lastCallAt;
  if (since < MIN_DELAY_MS) await sleep(MIN_DELAY_MS - since);

  let attempt = 0;
  while (true) {
    try {
      lastCallAt = Date.now();
      return await client.chat.completions.create({
        model: MODEL,
        response_format: { type: "json_object" },
        messages,
      });
    } catch (err) {
      const status = err?.status ?? err?.response?.status;
      if (status === 429 && attempt < 5) {
        const wait = Math.min(60000, 5000 * 2 ** attempt);
        console.log(`[rate-limit] 429 — waiting ${wait / 1000}s (attempt ${attempt + 1}/5)`);
        await sleep(wait);
        attempt++;
        continue;
      }
      throw err;
    }
  }
}

async function getTheWeatherOfCity(cityname = "") {
  const url = `https://wttr.in/${String(cityname).toLowerCase()}?format=%C+%t`;
  const { data } = await axios.get(url, { responseType: "text" });
  return `The Weather of ${cityname} is ${data}`;
}

async function getGithubDetailsAboutUser(username = "") {
  const url = `https://api.github.com/users/${username}`;
  const { data } = await axios.get(url);
  return {
    login: data.login,
    name: data.name,
    blog: data.blog,
    public_repos: data.public_repos,
  };
}

function executeCommand(cmd = "") {
  return new Promise((resolve) => {
    exec(cmd, { maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        resolve(`ERROR running "${cmd}": ${error.message}\nSTDERR: ${stderr}`);
        return;
      }
      resolve(stdout.trim() || stderr.trim() || `Command "${cmd}" completed.`);
    });
  });
}

function parseArgs(args) {
  if (args == null) return {};
  if (typeof args === "object") return args;
  try {
    return JSON.parse(args);
  } catch {
    return { _raw: args };
  }
}

async function writeFile(args) {
  const { path: filePath, content } = parseArgs(args);
  if (!filePath || content == null) {
    return `writeFile needs { path, content } — got ${JSON.stringify(args).slice(0, 120)}`;
  }
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
  return `Wrote ${content.length} bytes to ${filePath}`;
}

async function readFile(args) {
  const a = parseArgs(args);
  const filePath = a.path || a._raw || args;
  const data = await fs.readFile(filePath, "utf8");
  return data.length > 4000 ? data.slice(0, 4000) + "\n...[truncated]" : data;
}

async function createDirectory(args) {
  const a = parseArgs(args);
  const dirPath = a.path || a._raw || args;
  await fs.mkdir(dirPath, { recursive: true });
  return `Created directory ${dirPath}`;
}

async function listDirectory(args) {
  const a = parseArgs(args);
  const dirPath = a.path || a._raw || args || ".";
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  return entries.map((e) => `${e.isDirectory() ? "dir " : "file"}  ${e.name}`).join("\n");
}

const tool_map = {
  getTheWeatherOfCity,
  getGithubDetailsAboutUser,
  executeCommand,
  writeFile,
  readFile,
  createDirectory,
  listDirectory,
};

const SYSTEM_PROMPT = `
You are an AI Assistant that operates on START, THINK, TOOL, OBSERVE, and OUTPUT steps.
You break large problems into small steps, reason multiple times, then act.

Tools:
1. getTheWeatherOfCity(cityname: string)
2. getGithubDetailsAboutUser(username: string)
3. executeCommand(cmd: string) — runs a shell command and returns stdout
4. writeFile({ path: string, content: string }) — creates parent dirs and writes a file
5. readFile(path: string)
6. createDirectory(path: string)
7. listDirectory(path: string)

Rules:
1. Always reply with a SINGLE JSON object — no markdown fences, no extra prose.
2. One step at a time. After every TOOL step, WAIT for the OBSERVE step before continuing.
3. Do exactly ONE concise THINK step before each TOOL call or final OUTPUT (not multiple — the host has tight rate limits).
4. For tools needing multiple arguments (e.g. writeFile), tool_args MUST be a JSON object.
5. For single-arg tools, tool_args is a string.
6. NEVER use shell redirection ("echo > file") to write code. Always use writeFile.

When the user asks to clone the Scaler Academy website (scaler.com):
- Plan a folder named "scaler-clone" containing index.html, style.css, script.js.
- Build a real Header (Scaler-style logo, nav links like Academy/Neovarsity/Topics, Login + Book a Free Trial CTA),
  a Hero section (large headline, subhead, primary CTA, supporting illustration or stats),
  and a Footer (multi-column links: Company, Courses, Contact, plus social icons).
- Use a Scaler-ish palette (dark navy #0f1c2e / blue #3b82f6 / white), modern CSS (flexbox/grid, custom properties, responsive),
  and at least one JS interaction (mobile nav toggle, smooth scroll, or a simple counter/slider).
- After writing files, run listDirectory on "scaler-clone" to confirm.
- Final OUTPUT should tell the user exactly which file to open in the browser.

Output format (one JSON object per turn):
{ "step": "START | THINK | TOOL | OBSERVE | OUTPUT", "content": "string", "tool_name": "string", "tool_args": "string | object" }
`;

const LABELS = {
  START: "[START] ",
  THINK: "[THINK] ",
  TOOL: "[TOOL]  ",
  OBSERVE: "[OBS]   ",
  OUTPUT: "[OUTPUT]",
};

async function runAgentTurn(messages) {
  while (true) {
    const response = await chatWithRetry(messages);

    const content = response.choices[0].message.content;
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      messages.push({
        role: "user",
        content:
          "Your last reply was not valid JSON. Reply with one JSON object using the START/THINK/TOOL/OBSERVE/OUTPUT format.",
      });
      continue;
    }

    messages.push({ role: "assistant", content: JSON.stringify(parsed) });

    const step = parsed.step;
    if (step === "START" || step === "THINK") {
      console.log(`${LABELS[step]} ${parsed.content ?? ""}`);
    } else if (step === "TOOL") {
      const argPreview =
        typeof parsed.tool_args === "string"
          ? parsed.tool_args
          : JSON.stringify(parsed.tool_args);
      console.log(
        `${LABELS.TOOL} ${parsed.tool_name}(${(argPreview || "").slice(0, 80)}${
          argPreview && argPreview.length > 80 ? "..." : ""
        })`
      );

      const fn = tool_map[parsed.tool_name];
      let observation;
      if (!fn) {
        observation = `Tool "${parsed.tool_name}" is not available.`;
      } else {
        try {
          observation = await fn(parsed.tool_args);
        } catch (err) {
          observation = `Tool error: ${err.message}`;
        }
      }
      const obsString =
        typeof observation === "string" ? observation : JSON.stringify(observation);
      console.log(
        `${LABELS.OBSERVE} ${obsString.slice(0, 160)}${obsString.length > 160 ? "..." : ""}`
      );
      messages.push({
        role: "user",
        content: JSON.stringify({ step: "OBSERVE", content: obsString }),
      });
    } else if (step === "OUTPUT") {
      console.log(`\n${LABELS.OUTPUT} ${parsed.content ?? ""}\n`);
      return;
    } else {
      console.log("[?]", parsed);
    }
  }
}

async function main() {
  if (!process.env.GEMINI_API_KEY) {
    console.error("Missing GEMINI_API_KEY. Copy .env.example to .env and fill it in.");
    process.exit(1);
  }

  const rl = readline.createInterface({ input, output });
  const messages = [{ role: "system", content: SYSTEM_PROMPT }];

  console.log("Scaler Clone Agent — chat with the agent. Type 'exit' to quit.");
  console.log("Try: 'clone the scaler academy website'\n");

  while (true) {
    let userInput;
    try {
      userInput = (await rl.question("you > ")).trim();
    } catch {
      break;
    }
    if (!userInput) continue;
    if (userInput === "exit" || userInput === "quit") break;

    messages.push({ role: "user", content: userInput });
    try {
      await runAgentTurn(messages);
    } catch (err) {
      console.error("Agent error:", err.message);
    }
  }

  rl.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
