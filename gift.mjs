#!/usr/bin/env node
// Gift wizard: prepares a heartbeat device for someone else's home, one step at a time.
//
//   node gift.mjs
//
// It gives the other person their own bot and watchdog (in your Cloudflare account), tests the
// board on your Wi-Fi, loads their Wi-Fi, and prints a card they can scan to start receiving
// alerts. Everything it learns is kept in gifts/<name>/, so you can stop at any point and run
// the same command again to carry on where you left off.

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const project = path.dirname(fileURLToPath(import.meta.url));

/** Boards the firmware supports, with the settings written into firmware/heartbeat.yaml's substitutions. */
export const BOARDS = {
  "xiao-c3": {
    label: "Seeed XIAO ESP32-C3: comes with a separate antenna on a thin wire",
    short: "Seeed XIAO ESP32-C3",
    settings: { board: "esp32-c3-devkitm-1", cpu_frequency: "160MHZ", wifi_power_save: "none" },
    antenna: true,
  },
  "s3-zero": {
    label: "ESP32-S3 Zero (Waveshare or TENSTAR): small square board, antenna built in",
    short: "ESP32-S3 Zero",
    // Slower chip and a dozing radio: less heat in its tiny case, and a heartbeat needs neither.
    settings: { board: "esp32-s3-devkitc-1", cpu_frequency: "80MHZ", wifi_power_save: "light" },
    antenna: false,
  },
};
const board = () => BOARDS[s.BOARD] ?? BOARDS["xiao-c3"];
const watchdogDir = path.join(project, "watchdog");
const TOTAL = 8;
// What the bot calls the device in its messages, such as "home went silent". Gifts prepared before
// this could be chosen were all called "home".
const device = () => s.DEVICE_NAME || "home";
const FAST = process.env.GRID_FAST === "1"; // shortens waits; used by the tests
const telegramApi = process.env.TELEGRAM_API_BASE ?? "https://api.telegram.org";

// ---------------------------------------------------------------- talking to the person

// Answers are queued as they arrive, so several pasted or piped lines are not lost while a step is busy.
let rl = null;
let finished = false;
let inputEnded = false;
const typedLines = [];
let waiting = null;
function stopped() {
  console.log("\n\nStopped. Run the same command again to carry on where you left off.\n");
  process.exit(1);
}
function openPrompt() {
  rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.on("line", (line) => {
    if (waiting) {
      const resolve = waiting;
      waiting = null;
      resolve(line);
    } else {
      typedLines.push(line);
    }
  });
  rl.on("close", () => {
    inputEnded = true;
    if (waiting && !finished) stopped();
  });
}
async function nextLine(prompt) {
  process.stdout.write(prompt);
  if (!typedLines.length && inputEnded) stopped();
  const line = typedLines.length ? typedLines.shift() : await new Promise((resolve) => (waiting = resolve));
  // A terminal shows what was typed; when answers are piped in, show them so the transcript reads properly.
  if (!process.stdin.isTTY) process.stdout.write(`${line}\n`);
  return line;
}

const say = (text = "") => console.log(text);
const ok = (text) => console.log(`   ✓ ${text}`);
const note = (text) => console.log(`   ${text}`);
function step(n, title) {
  console.log(`\n────────────────────────────────────────────────────────\nStep ${n} of ${TOTAL}: ${title}\n────────────────────────────────────────────────────────`);
}
function stop(message) {
  finished = true;
  console.error(`\n✗ ${message}\n\nNothing is lost. Fix that, then run the same command again.\n`);
  process.exit(1);
}

/** Asks until `validate` (which returns a complaint, or nothing when happy) accepts the answer. */
async function ask(question, { fallback = "", validate = () => null } = {}) {
  for (;;) {
    const typed = (await nextLine(`\n   ${question}${fallback ? ` [${fallback}]` : ""}\n   > `)).trim();
    const answer = typed || fallback;
    const complaint = answer ? await validate(answer) : "Please type an answer.";
    if (!complaint) return answer;
    say(`   ✗ ${complaint}`);
  }
}
async function yes(question, fallback = true) {
  const answer = await ask(`${question} (y/n)`, { fallback: fallback ? "y" : "n", validate: (a) => (/^(y|yes|n|no)$/i.test(a) ? null : "Please answer y or n.") });
  return /^y/i.test(answer);
}
/** Offers numbered choices and returns the index of the one picked. */
async function choose(question, options, fallback = 0) {
  const list = options.map((o, i) => `     ${i + 1}. ${o}`).join("\n");
  const answer = await ask(`${question}\n${list}\n   Type the number`, {
    fallback: fallback === null ? "" : String(fallback + 1),
    validate: (a) => (/^\d+$/.test(a) && Number(a) >= 1 && Number(a) <= options.length ? null : `Type a number from 1 to ${options.length}.`),
  });
  return Number(answer) - 1;
}
const pause = (text) => nextLine(`\n   ${text}\n   Press Enter when done. `);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(what, check, minutes) {
  process.stdout.write(`   Waiting for ${what} `);
  const every = FAST ? 400 : 3000;
  const until = Date.now() + (FAST ? minutes * 4000 : minutes * 60_000);
  while (Date.now() < until) {
    if (await check()) {
      console.log(" ✓");
      return true;
    }
    process.stdout.write(".");
    await sleep(every);
  }
  console.log(" no luck");
  return false;
}

// ---------------------------------------------------------------- files and commands

function readSettings(file) {
  const values = {};
  if (!fs.existsSync(file)) return values;
  for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    const eq = line.indexOf("=");
    if (!line || line.startsWith("#") || eq < 1) continue;
    values[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return values;
}

let settingsFile = "";
let s = {};
/** Keep an answer or a generated value, so a later run does not have to ask again. */
function remember(key, value) {
  s[key] = value;
  const text = fs.existsSync(settingsFile) ? fs.readFileSync(settingsFile, "utf8") : "# Written by gift.mjs. Holds passwords: keep it private.\n";
  const line = new RegExp(`^${key}=.*$`, "m");
  fs.writeFileSync(settingsFile, line.test(text) ? text.replace(line, () => `${key}=${value}`) : `${text.trimEnd()}\n${key}=${value}\n`);
}
function generated(key, bytes) {
  if (!s[key]) remember(key, randomBytes(bytes).toString("hex"));
  return s[key];
}

function run(command, args, { cwd = project, input, show = false } = {}) {
  const result = spawnSync(command, args, { cwd, input, encoding: "utf8", stdio: show ? "inherit" : [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
  return { status: result.status ?? 1, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}
const wrangler = (args, input) => run("npx", ["wrangler", ...args], { cwd: watchdogDir, input });

/** Runs a command for a fixed time and returns what it printed. Used to read the board's log. */
function listen(command, args, cwd, seconds) {
  return new Promise((resolve) => {
    let text = "";
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (d) => (text += d));
    child.stderr.on("data", (d) => (text += d));
    const done = () => (clearTimeout(timer), resolve(text));
    const timer = setTimeout(() => (child.kill(), done()), seconds * 1000);
    child.on("exit", done);
    child.on("error", done);
  });
}

async function telegram(token, method, body = {}) {
  try {
    const res = await fetch(`${telegramApi}/bot${token}/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
    const data = await res.json().catch(() => ({}));
    return res.ok && data.ok ? { ok: true, result: data.result } : { ok: false, error: `Telegram answered ${res.status}${data.description ? `: ${data.description}` : ""}`, status: res.status };
  } catch (err) {
    return { ok: false, error: `could not reach Telegram (${err.cause?.code ?? err.message})`, status: 0 };
  }
}

/** Calls the gift's watchdog. Returns { status, data } with status 0 when it could not be reached. */
async function watchdog(route, method = "GET") {
  try {
    const res = await fetch(`${s.WATCHDOG_ADDRESS}${route}`, { method, headers: { Authorization: `Bearer ${s.DEVICE_TOKEN}` }, signal: AbortSignal.timeout(15_000) });
    const text = await res.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      // plain-text answer
    }
    return { status: res.status, data, text };
  } catch {
    return { status: 0, data: null, text: "" };
  }
}

// ---------------------------------------------------------------- the board

function findEsphome() {
  const candidates = [process.env.GRID_ESPHOME, path.join(os.homedir(), "esphome-venv", "bin", "esphome"), "esphome"].filter(Boolean);
  return candidates.find((c) => spawnSync(c, ["version"], { encoding: "utf8" }).status === 0) ?? null;
}
function findPython() {
  for (const name of ["python3.13", "python3.12", "python3.14", "python3"]) {
    const v = spawnSync(name, ["-c", "import sys; print(sys.version_info[0], sys.version_info[1])"], { encoding: "utf8" });
    const [major, minor] = `${v.stdout ?? ""}`.trim().split(" ").map(Number);
    if (v.status === 0 && major === 3 && minor >= 12 && minor <= 14) return name;
  }
  return null;
}

function serialPorts() {
  try {
    return fs.readdirSync("/dev").filter((n) => /^(cu\.usbmodem|cu\.usbserial|cu\.wchusbserial|ttyACM|ttyUSB)/.test(n)).map((n) => `/dev/${n}`).sort();
  } catch {
    return [];
  }
}

/** Finds the board's port by seeing which one appears when the board is plugged in. */
async function findBoard() {
  if (process.env.GRID_SERIAL_PORT) return process.env.GRID_SERIAL_PORT;
  for (;;) {
    await pause("Unplug the board from this computer (if it is plugged in).");
    const before = serialPorts();
    await pause("Now plug the board into this computer with the USB-C cable.");
    let fresh = [];
    for (let i = 0; i < 20 && fresh.length === 0; i++) {
      await sleep(500);
      fresh = serialPorts().filter((p) => !before.includes(p));
    }
    if (fresh.length === 1) {
      ok(`Found the board at ${fresh[0]}`);
      return fresh[0];
    }
    say(fresh.length ? "   ✗ More than one new device appeared. Unplug other USB gadgets and try again." : "   ✗ No board appeared.");
    note("Things that help: use a cable that carries data (not a charge-only one); plug straight into");
    note("the computer, not into a monitor or hub; or hold the board's BOOT button while plugging it in.");
    if (process.platform === "darwin") note('If macOS asks "Allow accessory to connect?", choose Allow.');
  }
}

const quote = JSON.stringify;
/** firmware/heartbeat.yaml with the gift's name and the board's settings filled into its substitutions. */
export function firmwareFor(base, hostname, settings) {
  let text = base;
  for (const [key, value] of Object.entries({ device_name: hostname, ...settings })) {
    // Only the substitution lines, which hold plain values, never the "${...}" lines that use them.
    const line = new RegExp(`^(  ${key}: )(?!\\$)\\S+$`, "m");
    if (!line.test(text)) throw new Error(`firmware/heartbeat.yaml has no substitution line "  ${key}: ...", so I cannot set it for this board.`);
    text = text.replace(line, (_, start) => `${start}${value}`);
  }
  return text;
}

function writeFirmware(dir, hostname, wifiName, wifiPassword) {
  fs.mkdirSync(dir, { recursive: true });
  const base = fs.readFileSync(path.join(project, "firmware", "heartbeat.yaml"), "utf8");
  try {
    fs.writeFileSync(path.join(dir, "heartbeat.yaml"), firmwareFor(base, hostname, board().settings));
  } catch (err) {
    stop(err.message);
  }
  fs.writeFileSync(
    path.join(dir, "secrets.yaml"),
    [
      "# Written by gift.mjs. Run it again to change these.",
      `wifi_ssid: ${quote(wifiName)}`,
      `wifi_password: ${quote(wifiPassword)}`,
      `fallback_ap_password: ${quote(s.SETUP_HOTSPOT_PASSWORD)}`,
      `ota_password: ${quote(s.UPDATE_PASSWORD)}`,
      `heartbeat_url: ${quote(`${s.WATCHDOG_ADDRESS}/hb/${device()}`)}`,
      `heartbeat_auth: ${quote(`Bearer ${s.DEVICE_TOKEN}`)}`,
      "",
    ].join("\n"),
  );
}

async function flash(esphome, dir, port) {
  say("\n   Building and loading the firmware. The first time takes 10 to 20 minutes; lots of text is normal.\n");
  for (;;) {
    const result = run(esphome, ["run", "heartbeat.yaml", "--device", port, "--no-logs"], { cwd: dir, show: true });
    if (result.status === 0) return ok("Firmware loaded onto the board.");
    say("\n   ✗ Loading the firmware did not work. The messages above say why.");
    note("If it could not connect to the board: unplug it, hold its BOOT button, plug it back in while holding.");
    note(`If they mention a different chip than the ${board().short} (for example "This chip is ESP32-S3"), the board type is wrong.`);
    const other = Object.keys(BOARDS).find((k) => k !== s.BOARD);
    const next = await choose("What now?", ["Try again.", `Switch to the ${BOARDS[other].short} and try again.`, "Stop here."]);
    if (next === 2) stop("The firmware was not loaded.");
    if (next === 1) {
      remember("BOARD", other);
      fs.writeFileSync(path.join(dir, "heartbeat.yaml"), firmwareFor(fs.readFileSync(path.join(project, "firmware", "heartbeat.yaml"), "utf8"), s.HOSTNAME, board().settings));
      ok(`Switched to the ${board().short}.`);
    }
  }
}

/**
 * Turns the board's log into advice. `fix` says where the remedy lies: on the "board" itself
 * (nothing to retype), in the Wi-Fi "details" that were entered, or "unknown".
 */
export function diagnose(log, wifiName, hasAntennaWire = true) {
  if (/No networks found/i.test(log)) {
    const why = hasAntennaWire
      ? "Its antenna is almost certainly not attached. Press the antenna's small round connector straight down onto the tiny gold socket on the board until it clicks."
      : "Its antenna is the small block at the end opposite the USB socket. Move the board closer to the router and away from metal. If it still hears nothing, the board may be faulty.";
    return { fix: "board", lines: ["The board cannot hear any Wi-Fi at all.", why] };
  }
  if (/Auth Expired|Authentication Failed|4-Way Handshake Timeout|Handshake Failed/i.test(log)) {
    return { fix: "details", lines: [`The Wi-Fi "${wifiName}" refused the password.`, "Check it character by character. Capital letters, and 0 versus O, are the usual culprits."] };
  }
  if (/Network no longer found|Probe Request Unsuccessful/i.test(log)) {
    return { fix: "details", lines: [`The board hears other networks but not one called "${wifiName}".`, "Check the name letter by letter (capitals and spaces matter), and that the router's 2.4 GHz band is switched on. The board cannot use 5 GHz."] };
  }
  if (/\[wifi[^\]]*\]:.*Connected|WiFi Connected/i.test(log)) {
    return { fix: "board", lines: ["The board joined the Wi-Fi but its heartbeats are not arriving.", "Check that this Wi-Fi has working internet. If it does, give it two more minutes."] };
  }
  return { fix: "unknown", lines: ["I could not tell from the board's log what is wrong."] };
}

// ---------------------------------------------------------------- the card

function cardHtml({ name, giver, link, qrSvg, hotspotName, hotspotPassword, minutes, buttons, deviceName }) {
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Home heartbeat for ${esc(name)}</title>
<style>
  body { font: 15px/1.5 -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; color: #18212b; max-width: 640px; margin: 32px auto; padding: 0 24px; }
  h1 { font-size: 26px; margin: 0 0 4px; }
  h2 { font-size: 17px; margin: 28px 0 8px; border-bottom: 1px solid #ccd4dc; padding-bottom: 4px; }
  .from { color: #586472; margin: 0 0 20px; }
  .start { display: flex; gap: 24px; align-items: flex-start; }
  .start svg { width: 170px; height: 170px; flex: none; }
  ol, ul { padding-left: 1.3em; margin: 0; }
  li { margin-bottom: 6px; }
  code { font: 14px ui-monospace, Menlo, Consolas, monospace; background: #eef1f4; padding: 1px 5px; border-radius: 4px; }
  .box { border: 1px solid #ccd4dc; border-radius: 8px; padding: 10px 14px; margin-top: 8px; }
  .small { color: #586472; font-size: 13px; }
  .link { word-break: break-all; }
  @media print { body { margin: 0 auto; } .noprint { display: none; } }
</style></head><body>
<p class="noprint small">Print this page (Cmd+P or Ctrl+P) and put it in the box with the device.</p>
<h1>Your home heartbeat</h1>
<p class="from">For ${esc(name)}, from ${esc(giver)}</p>
<p>This small device tells you on your phone when the power or the internet at home goes out, and when it is back. It needs no attention once it runs.</p>

<h2>Getting started</h2>
<div class="start">
  ${qrSvg}
  <ol>
    <li><strong>Plug it in.</strong> Use the charger and cable in the box, in a socket where your Wi-Fi is good. ${buttons ? "It has no screen, and you never need to press its two small buttons." : "There is no light and no button; that is normal."}</li>
    <li><strong>Scan this code</strong> with your phone's camera. It opens Telegram (install the Telegram app first if you do not have it). Press <strong>Start</strong>.</li>
    <li><strong>Done.</strong> The bot says hello. Within a few minutes of the device being plugged in it adds “✅ ${esc(deviceName)} is online”.</li>
  </ol>
</div>
<p class="small">No camera? Open this link on your phone instead:<br><span class="link">${esc(link)}</span></p>

<h2>What the messages mean</h2>
<ul>
  <li>🔴 <strong>went silent</strong>: no sign of life for ${esc(minutes)} minutes. The power or the internet at home is probably out.</li>
  <li>🟢 <strong>is back</strong>: it is working again, and the message says whether power or internet was the cause.</li>
  <li>✅ <strong>Weekly check-in</strong>, every Monday: everything is still being watched.</li>
</ul>
<p>You can also ask it things. Send <code>/status</code> to see if all is well right now, or <code>/help</code> for everything it can do.</p>

<h2>If something seems wrong</h2>
<p>Send <code>/fix</code> to the bot. It checks the device and tells you what to do. If you cannot reach the bot, go through these in order:</p>
<ol>
  <li>Is there a power cut, or is your internet down? Then it is doing its job. It reports back by itself.</li>
  <li>Is it still plugged in? Push the cable in firmly at both ends. Unplug the charger, wait 10 seconds, plug it back in.</li>
  <li>Is your Wi-Fi working? If not, restart your router and wait 5 minutes.</li>
  <li>New router, or a new Wi-Fi name or password? Give the device the new details:
    <div class="box">
      Leave it plugged in and wait 2 minutes. On your phone, open the Wi-Fi settings and join the network<br>
      <strong>${esc(hotspotName)}</strong> &nbsp; password: <code>${esc(hotspotPassword)}</code><br>
      A page opens. Choose your home Wi-Fi, type its password, and save.
    </div>
  </li>
  <li>Still nothing after 5 minutes? Ask ${esc(giver)}.</li>
</ol>

<h2>Good to know</h2>
<ul>
  <li>A new phone? Scan the code again and it will talk to that phone too.</li>
  <li>Keep this card to yourself: anyone who scans the code receives your alerts. The bot tells you when someone joins.</li>
  <li>It uses about as much electricity as a tenth of an LED bulb.</li>
</ul>
</body></html>
`;
}

// ---------------------------------------------------------------- the eight steps

function slugify(name) {
  const plain = name.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/ı/g, "i").replace(/ß/g, "ss").toLowerCase();
  return plain.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 20) || "gift";
}

async function checkComputer() {
  step(1, "Checking this computer");
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 12)) stop(`This needs Node.js 22.12 or newer and you have ${process.versions.node}. On a Mac: brew upgrade node`);
  ok(`Node.js ${process.versions.node}`);

  if (!fs.existsSync(path.join(watchdogDir, "node_modules", "qrcode")) || !fs.existsSync(path.join(watchdogDir, "node_modules", "wrangler"))) {
    note("Installing the watchdog's tools (one time)...");
    if (run("npm", ["install", "--no-audit", "--no-fund"], { cwd: watchdogDir, show: true }).status !== 0) stop("npm install failed. The messages above say why.");
  }
  ok("Watchdog tools installed");

  let who = wrangler(["whoami"]);
  if (who.status !== 0 || /not authenticated|not logged in/i.test(who.out)) {
    note("You are not logged in to Cloudflare on this computer. A browser window opens now; log in and click Allow.");
    run("npx", ["wrangler", "login"], { cwd: watchdogDir, show: true });
    who = wrangler(["whoami"]);
    if (who.status !== 0 || /not authenticated|not logged in/i.test(who.out)) stop("Still not logged in to Cloudflare. Run this and then start again:\n  cd watchdog && npx wrangler login");
  }
  ok("Logged in to Cloudflare");

  let esphome = findEsphome();
  if (!esphome) {
    const python = findPython();
    if (!python) stop("The flashing tool needs Python 3.12, 3.13 or 3.14, and I found none. On a Mac: brew install python@3.13");
    note("Installing the flashing tool, ESPHome (one time, a few minutes)...");
    const venv = path.join(os.homedir(), "esphome-venv");
    if (run(python, ["-m", "venv", venv], { show: true }).status !== 0 || run(path.join(venv, "bin", "pip"), ["install", "esphome"], { show: true }).status !== 0) {
      stop("Installing ESPHome failed. The messages above say why.");
    }
    esphome = findEsphome();
    if (!esphome) stop("ESPHome was installed but does not start.");
  }
  ok("Flashing tool (ESPHome) ready");
  return esphome;
}

async function chooseGift() {
  step(2, "Who is it for");
  const giftsDir = path.join(project, "gifts");
  const existing = fs.existsSync(giftsDir) ? fs.readdirSync(giftsDir).filter((d) => fs.existsSync(path.join(giftsDir, d, "settings.txt"))) : [];
  let slug = null;
  for (const candidate of existing) {
    const name = readSettings(path.join(giftsDir, candidate, "settings.txt")).RECIPIENT_NAME ?? candidate;
    if (await yes(`You already started a gift for ${name}. Carry on with that one?`)) {
      slug = candidate;
      break;
    }
  }
  if (slug) {
    settingsFile = path.join(giftsDir, slug, "settings.txt");
    s = readSettings(settingsFile);
  } else {
    const name = await ask("What is the first name of the person you are giving it to?", { validate: (a) => (a.length > 40 ? "Keep it under 40 characters." : null) });
    slug = slugify(name);
    while (existing.includes(slug)) slug += "-2";
    fs.mkdirSync(path.join(giftsDir, slug), { recursive: true });
    settingsFile = path.join(giftsDir, slug, "settings.txt");
    s = {};
    remember("RECIPIENT_NAME", name);
    remember("SLUG", slug);
  }
  if (!s.SLUG) remember("SLUG", slug);

  if (!s.GIVER_NAME) remember("GIVER_NAME", await ask("And your own first name, as they know you? The bot tells them to ask you if they get stuck."));
  if (!s.TIMEZONE) {
    const mine = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    const same = await yes(`Do they live in the same time zone as this computer (${mine})?`);
    const zone = same ? mine : await ask("Their time zone, written like Europe/Istanbul or America/New_York", {
      validate: (z) => { try { new Intl.DateTimeFormat("en", { timeZone: z }); return null; } catch { return "I do not know that zone. Use the Region/City form, for example Europe/Istanbul."; } },
    });
    remember("TIMEZONE", zone);
  }
  if (!s.ALERT_MINUTES) {
    remember("ALERT_MINUTES", await ask("After how many minutes of silence should they be alerted? Short power blinks then pass quietly.", {
      fallback: "15", validate: (m) => (/^\d+$/.test(m) && Number(m) >= 2 && Number(m) <= 1440 ? null : "Type a whole number between 2 and 1440."),
    }));
  }
  if (!BOARDS[s.BOARD]) {
    const keys = Object.keys(BOARDS);
    const picked = await choose("Which board are you giving? Look at it: does it have a separate antenna on a thin wire?", keys.map((k) => BOARDS[k].label), null);
    remember("BOARD", keys[picked]);
  }
  if (!s.DEVICE_NAME) {
    // A board that already holds this gift's firmware reports as "home"; keep it that way.
    const named = s.STAGE ? "home" : (await ask('What should the bot call the device in its messages? For example "home", or "freezer" if it watches a freezer.', {
      fallback: "home",
      validate: (n) => (/^[a-z0-9][a-z0-9-]{0,19}$/.test(n.toLowerCase()) ? null : "Use one word of up to 20 letters or digits (a hyphen is fine), for example freezer."),
    })).toLowerCase();
    remember("DEVICE_NAME", named);
  }
  ok(`Gift for ${s.RECIPIENT_NAME}, from ${s.GIVER_NAME}, on a ${board().short}, called "${device()}". Alert after ${s.ALERT_MINUTES} minutes. Time zone ${s.TIMEZONE}.`);
  note(`Everything about this gift is kept in ${path.dirname(settingsFile)}`);
}

async function createBot() {
  step(3, "A Telegram bot of their own");
  if (s.TELEGRAM_BOT_TOKEN) {
    const me = await telegram(s.TELEGRAM_BOT_TOKEN, "getMe");
    if (me.ok) {
      if (s.BOT_USERNAME !== me.result.username) remember("BOT_USERNAME", me.result.username);
      return ok(`Using the bot you already gave me: @${me.result.username}`);
    }
    if (me.status === 401 || me.status === 404) note("The bot token I have saved no longer works, so I need a new one.");
    else stop(`I could not check the saved bot token: ${me.error}`);
  }
  say(`
   Each home needs its own bot. On your phone, in Telegram:
     1. Open @BotFather and send  /newbot
     2. Give it a name, for example "${s.RECIPIENT_NAME}'s Home Watch"
     3. Give it a username that ends in "bot"
     4. BotFather replies with a token that looks like  8123456789:AAHk3...`);
  const token = await ask("Paste that token here", {
    validate: async (t) => {
      if (!/^\d{6,}:[A-Za-z0-9_-]{30,}$/.test(t)) return "That does not look like a bot token. It is numbers, a colon, then a long mix of letters. Copy the whole thing.";
      const me = await telegram(t, "getMe");
      if (me.ok) { s.BOT_USERNAME = me.result.username; return null; }
      return me.status === 401 || me.status === 404 ? "Telegram does not accept that token. Copy it again from BotFather." : `I could not check it: ${me.error}. Try again.`;
    },
  });
  remember("TELEGRAM_BOT_TOKEN", token);
  remember("BOT_USERNAME", s.BOT_USERNAME);
  ok(`Telegram knows this bot: @${s.BOT_USERNAME}`);
}

async function publishWatchdog() {
  step(4, "Their watchdog in the cloud");
  const worker = `grid-heartbeat-${s.SLUG}`;
  const hostname = `heartbeat-${s.SLUG}`;
  generated("DEVICE_TOKEN", 24);
  generated("TELEGRAM_WEBHOOK_SECRET", 24);
  generated("CLAIM_CODE", 16);
  generated("UPDATE_PASSWORD", 12);
  generated("SETUP_HOTSPOT_PASSWORD", 6);
  if (!s.HOSTNAME) remember("HOSTNAME", hostname);

  note(`Publishing "${worker}" to your Cloudflare account...`);
  const published = wrangler(["deploy", "--name", worker, "--var", `TIMEOUT_SECONDS:${Number(s.ALERT_MINUTES) * 60}`, "--var", "REMINDER_MINUTES:60"]);
  const found = published.out.match(/https:\/\/[a-z0-9.-]+\.workers\.dev/);
  if (published.status !== 0 || (!found && !s.WATCHDOG_ADDRESS && !process.env.GRID_WATCHDOG_ADDRESS)) stop(`Publishing did not work:\n${published.out}`);
  if (process.env.GRID_WATCHDOG_ADDRESS) remember("WATCHDOG_ADDRESS", process.env.GRID_WATCHDOG_ADDRESS);
  else if (found && s.WATCHDOG_ADDRESS !== found[0]) remember("WATCHDOG_ADDRESS", found[0]);
  ok(`Published at ${s.WATCHDOG_ADDRESS}`);

  const secrets = {
    DEVICE_TOKEN: s.DEVICE_TOKEN,
    TELEGRAM_BOT_TOKEN: s.TELEGRAM_BOT_TOKEN,
    TELEGRAM_WEBHOOK_SECRET: s.TELEGRAM_WEBHOOK_SECRET,
    CLAIM_CODE: s.CLAIM_CODE,
    TIMEZONE: s.TIMEZONE,
    RESTART_MESSAGES: "off",
    SETUP_HOTSPOT_NAME: `${s.HOSTNAME} setup`,
    SETUP_HOTSPOT_PASSWORD: s.SETUP_HOTSPOT_PASSWORD,
    HELP_CONTACT: s.GIVER_NAME,
  };
  const stored = wrangler(["secret", "bulk", "--name", worker], JSON.stringify(secrets));
  if (stored.status !== 0) stop(`Storing its settings did not work:\n${stored.out}`);
  ok("Settings stored");

  // A brand-new address and fresh secrets take a few seconds to become active.
  if (!(await waitFor("the watchdog to answer", async () => (await watchdog("/status")).status === 200, 2))) {
    stop(`The watchdog at ${s.WATCHDOG_ADDRESS} does not answer yet. Brand-new addresses can take a few minutes; run this again shortly.`);
  }

  const hook = await telegram(s.TELEGRAM_BOT_TOKEN, "setWebhook", { url: `${s.WATCHDOG_ADDRESS}/telegram`, secret_token: s.TELEGRAM_WEBHOOK_SECRET, allowed_updates: ["message"] });
  if (!hook.ok) stop(`Telegram would not connect the bot to the watchdog: ${hook.error}`);
  await telegram(s.TELEGRAM_BOT_TOKEN, "setMyCommands", {
    commands: [
      { command: "status", description: "Is everything fine right now" },
      { command: "fix", description: "What to check if something seems wrong" },
      { command: "history", description: "Recent outages" },
      { command: "mute", description: "Pause alerts, for example /mute 2h" },
      { command: "unmute", description: "Turn alerts back on" },
      { command: "help", description: "Everything I can do" },
    ],
  });
  ok("Bot connected to the watchdog");
}

const inviteLink = () => `https://t.me/${s.BOT_USERNAME}?start=${s.CLAIM_CODE}`;
const qrcode = () => createRequire(path.join(watchdogDir, "package.json"))("qrcode");

async function connectYourPhone() {
  step(5, "Connect your own phone, for testing");
  const people = async () => (await watchdog("/status")).data?.people ?? 0;
  if ((await people()) > 0) return ok("A phone is already connected to this bot.");
  say("\n   Scan this with your phone's camera, then press Start in Telegram:\n");
  say((await qrcode().toString(inviteLink(), { type: "terminal", small: true })).replace(/^/gm, "   "));
  say(`   Or open this link on your phone:\n   ${inviteLink()}\n`);
  if (!(await waitFor("you to press Start", async () => (await people()) > 0, 10))) {
    stop("Nobody pressed Start. Open the link above on your phone, press Start, and run this again.");
  }
  ok("The bot greeted you. Test messages will come to your phone.");
}

async function waitForHeartbeat(since) {
  return waitFor("the board's first heartbeat (up to 4 minutes)", async () => ((await watchdog("/status")).data?.devices?.[device()]?.lastSeen ?? 0) > since, 4);
}

async function testHere(esphome) {
  step(6, "Test the board here, on your own Wi-Fi");
  if (s.STAGE === "tested" || s.STAGE === "final") {
    if (!(await yes("This board already passed its test here. Test it again?", false))) return null;
  }
  say("\n   Before it goes to their home, the board proves itself on your Wi-Fi: it connects,\n   calls the watchdog, and the bot tells your phone.");
  if (!s.TEST_WIFI_NAME) {
    const mine = readSettings(path.join(project, "my-settings.txt"));
    if (mine.WIFI_NAME && mine.WIFI_PASSWORD && (await yes(`Use your own Wi-Fi "${mine.WIFI_NAME}" from your settings file for the test?`))) {
      remember("TEST_WIFI_NAME", mine.WIFI_NAME);
      remember("TEST_WIFI_PASSWORD", mine.WIFI_PASSWORD);
    } else {
      remember("TEST_WIFI_NAME", await askWifiName("The name of the Wi-Fi where you are now"));
      remember("TEST_WIFI_PASSWORD", await askWifiPassword("Its password"));
    }
  }
  note(board().antenna ? "Press the antenna's connector onto the board now until it clicks." : "This board has its antenna built in, so there is nothing to attach.");
  const dir = path.join(path.dirname(settingsFile), "firmware");
  const port = await findBoard();

  let reload = true;
  let since = Date.now();
  for (;;) {
    if (reload) {
      since = Date.now();
      writeFirmware(dir, s.HOSTNAME, s.TEST_WIFI_NAME, s.TEST_WIFI_PASSWORD);
      await flash(esphome, dir, port);
    }
    if (await waitForHeartbeat(since)) break;

    say("\n   ✗ No heartbeat arrived. Reading the board's log to find out why (25 seconds)...");
    const found = diagnose(await listen(esphome, ["logs", "heartbeat.yaml", "--device", port], dir, FAST ? 2 : 25), s.TEST_WIFI_NAME, board().antenna);
    say("");
    for (const line of found.lines) say(`   → ${line}`);
    const next = await choose("What now?", [
      board().antenna ? "I fixed it on the board (antenna, cable). Check again." : "I moved the board or changed the cable. Check again.",
      "Let me type the Wi-Fi name and password again.",
      "Load the firmware once more, unchanged.",
      "Stop here.",
    ], found.fix === "details" ? 1 : 0);
    if (next === 3) stop("The board did not pass its test.");
    if (next === 1) {
      remember("TEST_WIFI_NAME", await askWifiName("The name of the Wi-Fi where you are now", s.TEST_WIFI_NAME));
      remember("TEST_WIFI_PASSWORD", await askWifiPassword("Its password", s.TEST_WIFI_PASSWORD));
    }
    // The board keeps trying by itself, so a fix on the board needs no reloading.
    reload = next !== 0;
  }
  remember("STAGE", "tested");
  ok("The whole chain works: board, Wi-Fi, watchdog, Telegram.");
  note(`Your phone should show "✅ ${device()} is online. Monitoring started."`);
  return port;
}

const askWifiName = (question, fallback) => ask(question, { fallback, validate: (n) => (Buffer.byteLength(n) > 32 ? "A Wi-Fi name is at most 32 characters." : null) });
const askWifiPassword = (question, fallback) => ask(question, { fallback, validate: (p) => (p.length < 8 || p.length > 63 ? "A Wi-Fi password has between 8 and 63 characters." : null) });

async function loadTheirWifi(esphome, port) {
  step(7, `Load ${s.RECIPIENT_NAME}'s Wi-Fi`);
  if (s.STAGE === "final" && !(await yes(`The board already holds ${s.RECIPIENT_NAME}'s Wi-Fi ("${s.THEIR_WIFI_NAME}"). Load it again, for example to correct it?`, false))) return;
  say(`
   Now the board gets the Wi-Fi of the home it will live in. I cannot test this one from here,
   so it has to be exact. On their phone the name is in the Wi-Fi settings; copy it letter by
   letter, capitals included. The board only uses 2.4 GHz.`);
  for (;;) {
    const name = await askWifiName(`The name of ${s.RECIPIENT_NAME}'s Wi-Fi`, s.THEIR_WIFI_NAME);
    const password = await askWifiPassword("Its password", s.THEIR_WIFI_PASSWORD);
    if (/5\s?g(hz)?\b/i.test(name)) note(`"${name}" looks like the name of a 5 GHz network. If the router also has a name without "5G", use that one.`);
    if (name === s.TEST_WIFI_NAME) note("That is the same Wi-Fi the board was just tested on.");
    say(`\n   Name:      ${name}\n   Password:  ${password}`);
    remember("THEIR_WIFI_NAME", name);
    remember("THEIR_WIFI_PASSWORD", password);
    if (await yes("Is that exactly right, character by character?")) break;
  }
  const dir = path.join(path.dirname(settingsFile), "firmware");
  writeFirmware(dir, s.HOSTNAME, s.THEIR_WIFI_NAME, s.THEIR_WIFI_PASSWORD);
  await flash(esphome, dir, port ?? (await findBoard()));
  // Forget the test run, so the first thing the bot reports from their home is "... is online".
  await watchdog(`/devices/${device()}`, "DELETE");
  remember("STAGE", "final");
  ok(`The board now holds ${s.RECIPIENT_NAME}'s Wi-Fi. It will stay quiet here, which is expected.`);
}

async function makeCard() {
  step(8, "Their card");
  const file = path.join(path.dirname(settingsFile), "card.html");
  const qrSvg = await qrcode().toString(inviteLink(), { type: "svg", margin: 1 });
  fs.writeFileSync(file, cardHtml({
    name: s.RECIPIENT_NAME, giver: s.GIVER_NAME, link: inviteLink(), qrSvg,
    hotspotName: `${s.HOSTNAME} setup`, hotspotPassword: s.SETUP_HOTSPOT_PASSWORD, minutes: s.ALERT_MINUTES, buttons: s.BOARD === "s3-zero", deviceName: device(),
  }));
  ok(`Card written to ${file}`);
  if (process.platform === "darwin" && !FAST) spawnSync("open", [file]);
  say(`
════════════════════════════════════════════════════════
✓ The gift for ${s.RECIPIENT_NAME} is ready.

  1. Print the card that just opened (Cmd+P).
  2. Unplug the board and pack it with a 5 V USB charger, the cable, and the card.
  3. At their home: plug it in, they scan the code on the card and press Start.

  What happens then:
  - Their phone gets a welcome from the bot, and "✅ ${device()} is online" within a few minutes.
  - Your phone gets "👤 ${s.RECIPIENT_NAME} now also receives these alerts."
  - You keep receiving their alerts too. Send /leave to that bot if you would rather not.

  If the board stays silent at their home, the Wi-Fi name or password was not exact. They can
  fix that from their phone with the steps on the card, or by sending /fix to the bot.
════════════════════════════════════════════════════════
`);
}

async function main() {
  openPrompt();
  say("\nThis prepares a heartbeat device as a gift. It takes about 30 minutes, most of it waiting.");
  say("You need: the new board (with its antenna, if it has one), a USB-C data cable, your phone with Telegram,");
  say("and the other person's Wi-Fi name and password. You can stop any time and continue later.");
  const esphome = await checkComputer();
  await chooseGift();
  await createBot();
  await publishWatchdog();
  await connectYourPhone();
  const port = await testHere(esphome);
  await loadTheirWifi(esphome, port);
  await makeCard();
  finished = true;
  rl.close();
}

// Only run the wizard when started directly; the tests import this file for diagnose().
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
