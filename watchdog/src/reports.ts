// Everything the bot says that is not an alert: the weekly check-in, the monthly summary,
// and the replies to /status, /history, /mute and /unmute.

import type { Cause, Config, Device, Outage, State } from "./monitor";
import { formatDayTime, formatDuration, formatWhen, monthName, sameMonth } from "./time";

const DAY = 24 * 3_600_000;
const MAX_MUTE_MS = 7 * DAY;

const CAUSE_WORDS: Record<Cause, string> = {
  power: "power cut",
  network: "network or internet",
  restart: "device restart",
  unknown: "cause unknown",
};

// A brief self-restart (a firmware update, say) is logged but is not an outage.
const isOutage = (o: Outage) => o.tripped || o.cause !== "restart";

export function signalWords(rssi: number | null): string {
  if (rssi === null) return "unknown";
  const quality = rssi >= -67 ? "good" : rssi >= -75 ? "okay" : rssi >= -82 ? "weak" : "very weak";
  return `${quality} (${rssi} dBm)`;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** "3 outages, 2 h 10 min of silence in total (2 power, 1 network)" or "no outages". */
export function summarize(outages: Outage[]): string {
  const real = outages.filter(isOutage);
  if (real.length === 0) return "no outages";
  const total = real.reduce((sum, o) => sum + (o.to - o.from), 0);
  const counts: string[] = [];
  for (const [cause, word] of [["power", "power"], ["network", "network"], ["restart", "restart"], ["unknown", "unknown"]] as const) {
    const n = real.filter((o) => o.cause === cause).length;
    if (n) counts.push(`${n} ${word}`);
  }
  return `${plural(real.length, "outage")}, ${formatDuration(total)} of silence in total (${counts.join(", ")})`;
}

function deviceLine(d: Device, now: number): string {
  return d.state === "up" ? `🟢 ${d.id} is online` : `🔴 ${d.id} has been silent for ${formatDuration(now - d.lastSeen)}`;
}

export function weeklyReport(state: State, now: number, cfg: Config): string {
  const devices = Object.values(state.devices);
  if (devices.length === 0) return "✅ Weekly check-in: the watchdog is running, but no device has reported yet.";
  const lines = devices.map((d) => {
    const week = state.history.filter((o) => o.id === d.id && o.to >= now - 7 * DAY);
    const signal = d.state === "up" ? ` Wi-Fi signal: ${signalWords(d.rssi)}.` : "";
    return `${deviceLine(d, now)}. Last 7 days: ${summarize(week)}.${signal}`;
  });
  const allUp = devices.every((d) => d.state === "up");
  return `${allUp ? "✅" : "⚠️"} Weekly check-in\n${lines.join("\n")}`;
}

/** Summary of the calendar month that ended just before `scheduledAt`, which is a 1st of the month at 09:00. */
export function monthlyReport(state: State, scheduledAt: number, cfg: Config): string {
  const lastMonth = scheduledAt - 1.5 * DAY; // lands in the previous month
  const outages = state.history.filter((o) => sameMonth(o.from, lastMonth, cfg.timezone) && isOutage(o));
  let text = `📊 ${monthName(lastMonth, cfg.timezone)}: ${summarize(outages)}.`;
  if (outages.length > 1) {
    const longest = outages.reduce((a, b) => (b.to - b.from > a.to - a.from ? b : a));
    text += `\nLongest: ${formatDuration(longest.to - longest.from)} on ${formatWhen(longest.from, cfg.timezone)}.`;
  }
  return text;
}

export function statusText(state: State, now: number, cfg: Config): string {
  const devices = Object.values(state.devices);
  if (devices.length === 0) return "No device has reported yet.";
  const blocks = devices.map((d) => {
    if (d.state === "down") return `${deviceLine(d, now)}\nLast heartbeat: ${formatWhen(d.lastSeen, cfg.timezone)}`;
    return [
      deviceLine(d, now),
      `Last heartbeat: ${formatDuration(now - d.lastSeen)} ago`,
      `Running for ${formatDuration(now - d.bootSeenAt)} without a restart`,
      `Wi-Fi signal: ${signalWords(d.rssi)}`,
    ].join("\n");
  });
  const footer = [`Alerts after ${formatDuration(cfg.timeoutMs)} of silence.`];
  if (state.restartNotes === false) footer.push("Messages about brief restarts are off.");
  if (state.muteUntil !== null && now < state.muteUntil) footer.push(`🔕 Alerts are paused until ${formatDayTime(state.muteUntil, cfg.timezone)}.`);
  return `${blocks.join("\n\n")}\n\n${footer.join("\n")}`;
}

export function historyText(state: State, now: number, cfg: Config): string {
  const several = Object.keys(state.devices).length > 1;
  const recent = state.history.slice(-10).reverse();
  const ongoing = Object.values(state.devices)
    .filter((d) => d.state === "down")
    .map((d) => `• ${formatWhen(d.lastSeen, cfg.timezone)} · ${formatDuration(now - d.lastSeen)} so far · still silent${several ? ` · ${d.id}` : ""}`);
  if (recent.length === 0 && ongoing.length === 0) return "No outages recorded yet.";
  const lines = recent.map((o) => {
    const what = o.tripped || o.cause === "restart" ? CAUSE_WORDS[o.cause] : `${CAUSE_WORDS[o.cause]} (brief)`;
    return `• ${formatWhen(o.from, cfg.timezone)} · ${formatDuration(o.to - o.from)} · ${what}${several ? ` · ${o.id}` : ""}`;
  });
  const thisMonth = state.history.filter((o) => sameMonth(o.from, now, cfg.timezone));
  return `Recent outages, newest first:\n${[...ongoing, ...lines].join("\n")}\n\nThis month so far: ${summarize(thisMonth)}.`;
}

const HELP = [
  "I watch your heartbeat device and tell you when it goes silent.",
  "",
  "/status - is it alive right now",
  "/history - recent outages",
  "/mute 2h - pause alerts (for example 30m, 2h, 1d)",
  "/unmute - turn alerts back on",
  "/restarts off - no messages about brief restarts (on to get them back)",
].join("\n");

/** "30m", "2h", "1.5 h", "1d" -> milliseconds, or null if it is not a duration. */
export function parseDuration(text: string): number | null {
  const m = /^(\d+(?:[.,]\d+)?)\s*(m|min|mins|minutes?|h|hr|hrs|hours?|d|days?)$/i.exec(text.trim());
  if (!m) return null;
  const amount = Number(m[1].replace(",", "."));
  const unit = m[2][0].toLowerCase();
  return Math.round(amount * (unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : DAY));
}

/** Handle one message sent to the bot. May change `state.muteUntil`. Returns the reply. */
export function handleCommand(state: State, text: string, now: number, cfg: Config): string {
  const [first = "", ...rest] = text.trim().split(/\s+/);
  const command = first.toLowerCase().replace(/@.*$/, "");
  const arg = rest.join(" ");

  if (command === "/status") return statusText(state, now, cfg);
  if (command === "/history") return historyText(state, now, cfg);
  if (command === "/unmute") {
    const wasPaused = state.muteUntil !== null && now < state.muteUntil;
    state.muteUntil = null;
    return wasPaused ? "🔔 Alerts are on again." : "Alerts were not paused.";
  }
  if (command === "/restarts") {
    const choice = arg.toLowerCase();
    if (choice === "off" || choice === "on") state.restartNotes = choice === "on";
    const current = state.restartNotes === false
      ? "Messages about brief restarts are off. They still appear in /history and the reports."
      : "Messages about brief restarts are on.";
    return choice === "off" || choice === "on" ? current : `${current}\nSend /restarts off or /restarts on to change it.`;
  }
  if (command === "/mute") {
    const ms = arg ? parseDuration(arg) : 3_600_000;
    if (ms === null || ms < 60_000 || ms > MAX_MUTE_MS) return "Tell me how long, between 1 minute and 7 days. For example: /mute 30m or /mute 2h";
    state.muteUntil = now + ms;
    return `🔕 Alerts are paused for ${formatDuration(ms)}, until ${formatDayTime(state.muteUntil, cfg.timezone)}.\nSend /unmute to turn them back on.`;
  }
  return HELP;
}
