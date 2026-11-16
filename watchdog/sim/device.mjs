#!/usr/bin/env node
// A stand-in for the real device, for testing a watchdog before the hardware exists.
// It sends the same heartbeats the firmware sends, and lets you fake outages from the keyboard.
//
//   node sim/device.mjs <heartbeat-url> <device-token> [interval-seconds]
//   node sim/device.mjs https://grid-heartbeat.YOU.workers.dev/hb/sim-test YOUR-DEVICE-TOKEN
//
// Use a name of its own in the URL (like "sim-test") so it does not mix with your real device.
// Quitting removes that name from the watchdog, so it does not keep alerting afterwards.

import readline from "node:readline";

const [url, token, intervalArg] = process.argv.slice(2);
const intervalS = Number(intervalArg ?? 30);
if (!url || !token || !(intervalS > 0)) {
  console.error("Usage: node sim/device.mjs <heartbeat-url> <device-token> [interval-seconds]");
  console.error("  e.g. node sim/device.mjs https://grid-heartbeat.YOU.workers.dev/hb/sim-test YOUR-DEVICE-TOKEN");
  process.exit(1);
}
const target = new URL(url);
const name = target.pathname.split("/").pop();
const headers = { Authorization: `Bearer ${token}` };

let power = true;
let internet = true;
let bootId = newBootId();

function newBootId() {
  return Math.floor(Math.random() * 0xffffffff);
}
function say(text) {
  console.log(`${new Date().toLocaleTimeString()}  ${text}`);
}

async function beat() {
  if (!power) return;
  if (!internet) return say("heartbeat not sent (pretending the internet is down)");
  try {
    const res = await fetch(target, {
      method: "POST",
      headers,
      body: JSON.stringify({ boot: bootId, reset: "power-on event", rssi: -60 }),
      signal: AbortSignal.timeout(10_000),
    });
    say(res.ok ? "heartbeat delivered" : `heartbeat rejected: ${res.status} ${(await res.text()).trim()}`);
  } catch (err) {
    say(`heartbeat failed: ${err.message}`);
  }
}

let quitting = false;
async function quit() {
  if (quitting) return;
  quitting = true;
  clearInterval(timer);
  try {
    const res = await fetch(new URL(`/devices/${name}`, target), { method: "DELETE", headers, signal: AbortSignal.timeout(10_000) });
    say(res.ok ? `removed "${name}" from the watchdog` : `could not remove "${name}" (${res.status}); it will alert as silent`);
  } catch (err) {
    say(`could not remove "${name}" (${err.message}); it will alert as silent`);
  }
  process.exit(0);
}

console.log(`Simulated device "${name}", one heartbeat every ${intervalS} s.`);
console.log("Type a letter and press Enter:  p = cut/restore power   i = cut/restore internet   q = quit\n");

const timer = setInterval(beat, intervalS * 1000);
beat();

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const key = line.trim().toLowerCase();
  if (key === "p") {
    power = !power;
    if (power) {
      // Unlike the real device, which waits one interval after booting, call in at once so tests go faster.
      bootId = newBootId();
      say("power restored: the device boots with a new boot id");
      beat();
    } else {
      say("power cut: the device is off and sends nothing");
    }
  } else if (key === "i") {
    internet = !internet;
    say(internet ? "internet restored" : "internet cut: the device stays on but cannot call out");
    if (internet) beat();
  } else if (key === "q") {
    quit();
  }
});
rl.on("close", quit);
process.on("SIGINT", quit);
