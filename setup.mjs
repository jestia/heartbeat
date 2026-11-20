#!/usr/bin/env node
// Guided setup and update. You fill in one settings file; this publishes the watchdog, stores its
// secrets, checks that Telegram works, switches on the bot commands, and writes the settings the
// board needs. Run it again after changing anything in the watchdog folder or the settings file.
//
//   node setup.mjs            your own device
//   node setup.mjs friend     a second, separate device: its own settings file, watchdog and firmware
//
// The first run creates the settings file (my-settings.txt, or my-settings-friend.txt) and opens it.
// Fill it in, save, and run the same command again.
// Before using this, log in to Cloudflare once:  cd watchdog && npm install && npx wrangler login

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const TEMPLATE = `# Fill in the value after each = sign. No quote marks needed.
# Save this file, then run the setup command again.

# From BotFather in Telegram. Looks like 8123456789:AAHk3...
TELEGRAM_BOT_TOKEN=

# The number you found in the browser after "chat":{"id":
TELEGRAM_CHAT_ID=

# Your home Wi-Fi, exactly as it appears on your phone (capital letters matter).
WIFI_NAME=
WIFI_PASSWORD=
`;

const PROFILE_TEMPLATE = `# Settings for a second device. Fill in the value after each = sign. No quote marks needed.
# Save this file, then run the setup command again.

# The NEW bot's token from BotFather. Looks like 8123456789:AAHk3...
# Use a new bot, not the one your own device uses.
TELEGRAM_BOT_TOKEN=

# Who gets this device's alerts. Filled in with your own number, from my-settings.txt.
# To send them to someone else, put their number here; they can get it from @userinfobot.
# Whoever it is must open the new bot in Telegram and press Start once.
TELEGRAM_CHAT_ID=

# The Wi-Fi the board should join, exactly as it appears on a phone (capital letters matter).
# To test it at your place first, put your own Wi-Fi here, and theirs once it works.
WIFI_NAME=
WIFI_PASSWORD=

# Which board: xiao-c3 for the Seeed XIAO ESP32-C3, s3-zero for the ESP32-S3 Zero.
BOARD=xiao-c3
`;

function stop(message) {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

function readSettings(file) {
  const values = {};
  for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    const eq = line.indexOf("=");
    if (!line || line.startsWith("#") || eq < 1) continue;
    values[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return values;
}

/** Write a value this script produced back into the settings file, so later runs reuse it. */
function remember(file, settings, key, value, comment) {
  settings[key] = value;
  const text = fs.readFileSync(file, "utf8");
  const line = new RegExp(`^${key}=.*$`, "m");
  fs.writeFileSync(file, line.test(text) ? text.replace(line, () => `${key}=${value}`) : `${text.trimEnd()}\n\n# ${comment}\n${key}=${value}\n`);
}

function wrangler(dir, args, input) {
  return spawnSync("npx", ["wrangler", ...args], { cwd: dir, input, encoding: "utf8", stdio: [input === undefined ? "inherit" : "pipe", "pipe", "pipe"] });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Returns null when the test message was sent, otherwise what went wrong and what to do about it. */
async function testTelegram(address, token) {
  for (let attempt = 1; ; attempt++) {
    let res, text;
    try {
      res = await fetch(`${address}/test`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) });
      text = (await res.text()).trim();
    } catch (err) {
      text = err.cause?.code ?? err.message;
    }
    if (res?.ok) return null;
    // New secrets and brand-new addresses take a few seconds to become active, so retry those cases.
    if ((!res || res.status === 401) && attempt < 8) {
      await sleep(4000);
      continue;
    }
    if (!res) return `Could not reach the watchdog at ${address} (${text}). If you just created it, wait a few minutes and run setup again.`;
    if (res.status === 401) return "The watchdog did not accept the device password. Run setup again; if it keeps happening, tell Claude.";
    if (/Telegram answered (401|404)/.test(text)) return "Telegram rejected the bot token. Copy it again from BotFather into TELEGRAM_BOT_TOKEN.";
    if (/Telegram answered (400|403)/.test(text)) return "Telegram could not deliver to that chat. Check TELEGRAM_CHAT_ID, and press Start in your own bot.";
    return `The test failed: ${text}`;
  }
}

/** Calls one Telegram bot method. Returns null on success, otherwise what went wrong. */
async function telegram(token, method, body) {
  const api = process.env.TELEGRAM_API_BASE ?? "https://api.telegram.org";
  try {
    const res = await fetch(`${api}/bot${token}/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
    const data = await res.json().catch(() => ({}));
    return res.ok && data.ok ? null : `Telegram answered ${res.status}${data.description ? `: ${data.description}` : ""}`;
  } catch (err) {
    return `could not reach Telegram (${err.cause?.code ?? err.message})`;
  }
}

const here = path.dirname(fileURLToPath(import.meta.url));
const project = [here, path.join(os.homedir(), "Downloads", "grid-heartbeat"), process.cwd(), path.dirname(process.cwd())]
  .find((dir) => fs.existsSync(path.join(dir, "watchdog", "wrangler.jsonc")));
if (!project) stop("I can't find the grid-heartbeat folder. Move this file into that folder and run it again.");
const watchdogDir = path.join(project, "watchdog");
const mainSettingsFile = path.join(project, "my-settings.txt");

// A second device gets its own settings file, watchdog and firmware folder, so the first is never touched.
const profile = process.argv[2]?.toLowerCase();
if (profile !== undefined && !/^[a-z0-9][a-z0-9-]{0,19}$/.test(profile)) {
  stop(`"${process.argv[2]}" cannot be a device name. Use one word of letters or digits, for example:\n  node setup.mjs friend`);
}
const settingsFile = profile ? path.join(project, `my-settings-${profile}.txt`) : mainSettingsFile;
const workerArgs = profile ? ["--name", `grid-heartbeat-${profile}`] : [];
const hostname = profile ? `heartbeat-${profile}` : "grid-heartbeat";
const firmwareDir = profile ? path.join(project, "firmware", profile) : path.join(project, "firmware");

if (!fs.existsSync(settingsFile)) {
  let template = TEMPLATE;
  if (profile) {
    const own = fs.existsSync(mainSettingsFile) ? readSettings(mainSettingsFile).TELEGRAM_CHAT_ID ?? "" : "";
    template = PROFILE_TEMPLATE.replace("TELEGRAM_CHAT_ID=\n", `TELEGRAM_CHAT_ID=${own}\n`);
  }
  fs.writeFileSync(settingsFile, template);
  if (process.platform === "darwin") spawnSync("open", ["-e", settingsFile]);
  console.log(`\nI created the settings file:\n  ${settingsFile}\n\nFill in the values, save it, then run this same command again.\n`);
  process.exit(0);
}

const s = readSettings(settingsFile);
const problems = [];
if (!s.TELEGRAM_BOT_TOKEN) problems.push("TELEGRAM_BOT_TOKEN is empty.");
else if (!/^\d{6,}:[A-Za-z0-9_-]{30,}$/.test(s.TELEGRAM_BOT_TOKEN)) problems.push("TELEGRAM_BOT_TOKEN does not look like a bot token (numbers, a colon, then a long mix of letters).");
if (!s.TELEGRAM_CHAT_ID) problems.push("TELEGRAM_CHAT_ID is empty.");
else if (!/^-?\d+$/.test(s.TELEGRAM_CHAT_ID)) problems.push("TELEGRAM_CHAT_ID should be only a number.");
if (!s.WIFI_NAME) problems.push("WIFI_NAME is empty.");
if (!s.WIFI_PASSWORD) problems.push("WIFI_PASSWORD is empty.");
else if (s.WIFI_PASSWORD.length < 8) problems.push("WIFI_PASSWORD is shorter than 8 characters, which no Wi-Fi password is.");
let boardSettings = null;
if (profile) {
  const { BOARDS } = await import(pathToFileURL(path.join(project, "gift.mjs")).href);
  if (!BOARDS[s.BOARD]) problems.push(`BOARD should be ${Object.keys(BOARDS).join(" or ")}.`);
  else boardSettings = BOARDS[s.BOARD].settings;
  // Two devices on one bot would fight over its commands, so each needs its own.
  for (const other of fs.readdirSync(project).filter((f) => /^my-settings(-[a-z0-9-]+)?\.txt$/.test(f) && path.join(project, f) !== settingsFile)) {
    if (s.TELEGRAM_BOT_TOKEN && readSettings(path.join(project, other)).TELEGRAM_BOT_TOKEN === s.TELEGRAM_BOT_TOKEN) {
      problems.push(`TELEGRAM_BOT_TOKEN is the same bot as in ${other}. Make a new bot with BotFather (send /newbot) and use its token.`);
    }
  }
}
if (problems.length) stop(`Please fix these in ${settingsFile} and run again:\n  - ${problems.join("\n  - ")}`);
if (/[‘’“”–—]/.test(s.WIFI_NAME + s.WIFI_PASSWORD)) {
  console.log("\nNote: your Wi-Fi name or password contains a curly quote or long dash. If TextEdit changed it while you typed, paste the value instead.");
}

// Passwords the user never needs to invent. Kept in the settings file so every run uses the same ones.
if (!s.DEVICE_TOKEN) remember(settingsFile, s, "DEVICE_TOKEN", randomBytes(24).toString("hex"), "Created by setup. The password between your board and your watchdog.");
if (!s.UPDATE_PASSWORD) remember(settingsFile, s, "UPDATE_PASSWORD", randomBytes(12).toString("hex"), "Created by setup. Protects wireless firmware updates.");
if (!s.TELEGRAM_WEBHOOK_SECRET) remember(settingsFile, s, "TELEGRAM_WEBHOOK_SECRET", randomBytes(24).toString("hex"), "Created by setup. Lets the watchdog recognise messages that really come from Telegram.");
if (!s.SETUP_HOTSPOT_PASSWORD) remember(settingsFile, s, "SETUP_HOTSPOT_PASSWORD", randomBytes(6).toString("hex"), "Created by setup. Password of the hotspot the board opens when it cannot join your Wi-Fi.");

if (!fs.existsSync(path.join(watchdogDir, "node_modules"))) {
  console.log("\nInstalling the watchdog's tools (one time)...");
  if (spawnSync("npm", ["install"], { cwd: watchdogDir, stdio: "inherit" }).status !== 0) stop("npm install failed. See the messages above.");
}

console.log("\nPublishing the watchdog...");
const published = wrangler(watchdogDir, ["deploy", ...workerArgs]);
const found = `${published.stdout}`.match(/https:\/\/[a-z0-9.-]+\.workers\.dev/);
if (published.status !== 0 || (!found && !s.WATCHDOG_ADDRESS)) {
  stop(`Publishing did not work:\n${published.stdout}${published.stderr}\nIf it says you are not logged in, run this first:\n  cd "${watchdogDir}" && npx wrangler login`);
}
if (!s.WATCHDOG_ADDRESS) remember(settingsFile, s, "WATCHDOG_ADDRESS", found[0], "Found by setup. Where your watchdog lives.");
const address = s.WATCHDOG_ADDRESS.replace(/\/+$/, "");
// Report times use this computer's time zone unless the settings file names another one.
const timezone = s.TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
console.log(`Watchdog address: ${address}`);
console.log(`Time zone for reports: ${timezone}`);

console.log("Storing the settings on the watchdog...");
const secrets = {
  DEVICE_TOKEN: s.DEVICE_TOKEN,
  TELEGRAM_BOT_TOKEN: s.TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID: s.TELEGRAM_CHAT_ID,
  TELEGRAM_WEBHOOK_SECRET: s.TELEGRAM_WEBHOOK_SECRET,
  TIMEZONE: timezone,
  // Quoted by /fix, so whoever is at home can give the device a new Wi-Fi password from a phone.
  SETUP_HOTSPOT_NAME: `${hostname} setup`,
  SETUP_HOTSPOT_PASSWORD: s.SETUP_HOTSPOT_PASSWORD,
};
const stored = wrangler(watchdogDir, ["secret", "bulk", ...workerArgs], JSON.stringify(secrets));
if (stored.status !== 0) {
  stop(`Storing the secrets did not work:\n${stored.stdout}${stored.stderr}\nIf it says you are not logged in, run this first:\n  cd "${watchdogDir}" && npx wrangler login`);
}

console.log("Sending a test message to your Telegram...");
const failure = await testTelegram(address, s.DEVICE_TOKEN);
if (failure) stop(failure);

console.log("Switching on the bot commands...");
const hook = await telegram(s.TELEGRAM_BOT_TOKEN, "setWebhook", { url: `${address}/telegram`, secret_token: s.TELEGRAM_WEBHOOK_SECRET, allowed_updates: ["message"] });
if (hook) stop(`The bot commands could not be switched on: ${hook}`);
// The menu of commands Telegram shows when you type "/". Cosmetic, so a failure here is not fatal.
const menu = await telegram(s.TELEGRAM_BOT_TOKEN, "setMyCommands", {
  commands: [
    { command: "status", description: "Is the device alive right now" },
    { command: "fix", description: "What to check if something seems wrong" },
    { command: "history", description: "Recent outages" },
    { command: "mute", description: "Pause alerts, for example /mute 2h" },
    { command: "unmute", description: "Turn alerts back on" },
    { command: "restarts", description: "Brief restart messages: /restarts off or on" },
  ],
});
if (menu) console.log(`  (Could not set the command menu: ${menu}. The commands still work.)`);

const q = JSON.stringify;
if (profile) {
  // The board's own copy of the firmware, named after this device and set up for its board.
  const { firmwareFor } = await import(pathToFileURL(path.join(project, "gift.mjs")).href);
  fs.mkdirSync(firmwareDir, { recursive: true });
  const base = fs.readFileSync(path.join(project, "firmware", "heartbeat.yaml"), "utf8");
  fs.writeFileSync(path.join(firmwareDir, "heartbeat.yaml"), firmwareFor(base, hostname, boardSettings));
}
const firmwareSecrets = path.join(firmwareDir, "secrets.yaml");
const yaml = [
  `# Written by setup.mjs from ${path.basename(settingsFile)}. To change something, edit that file and run setup again.`,
  `wifi_ssid: ${q(s.WIFI_NAME)}`,
  `wifi_password: ${q(s.WIFI_PASSWORD)}`,
  `fallback_ap_password: ${q(s.SETUP_HOTSPOT_PASSWORD)}`,
  `ota_password: ${q(s.UPDATE_PASSWORD)}`,
  `heartbeat_url: ${q(`${address}/hb/home`)}`,
  `heartbeat_auth: ${q(`Bearer ${s.DEVICE_TOKEN}`)}`,
  "",
].join("\n");
if (fs.existsSync(firmwareSecrets) && fs.readFileSync(firmwareSecrets, "utf8") !== yaml) fs.copyFileSync(firmwareSecrets, `${firmwareSecrets}.bak`);
fs.writeFileSync(firmwareSecrets, yaml);

console.log(`
✓ Done.
  - A test message should now be in your Telegram.
  - Your bot answers /status, /fix, /history, /mute, /unmute and /restarts.
  - The board's settings are written to ${firmwareSecrets}
${profile ? `
To load it onto the new board, plug the board into this computer and run:
  cd "${firmwareDir}"
  source ~/esphome-venv/bin/activate
  esphome run heartbeat.yaml
` : `
If the board is not flashed yet, that is the next step. If it is already running, nothing else is needed.`}
`);
