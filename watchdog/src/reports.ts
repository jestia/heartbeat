// Everything the bot says that is not an alert: the weekly check-in, the monthly summary,
// and the replies to /status, /history, /mute and /unmute.

import type { Cause, Config, Device, Outage, Person, State } from "./monitor";
import { formatDayTime, formatDuration, formatWhen, monthName, sameMonth } from "./time";

const DAY = 24 * 3_600_000;
const MAX_MUTE_MS = 7 * DAY;
export const MAX_PEOPLE = 5;

/** Whether brief restarts are announced: the owner's choice if made, otherwise the configured default. */
export function restartNotesOn(state: State, cfg: Config): boolean {
  return state.restartNotes ?? cfg.restartNotes ?? true;
}

/** Chats that receive alerts: everyone who joined by invitation, otherwise the single configured chat. */
export function recipients(state: State, fallbackChat: string | undefined): string[] {
  if (state.people?.length) return state.people.map((p) => p.chat);
  return fallbackChat ? [fallbackChat] : [];
}

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
  if (!restartNotesOn(state, cfg)) footer.push("Messages about brief restarts are off.");
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

function helpText(state: State): string {
  const lines = [
    "I watch your heartbeat device and tell you when it goes silent.",
    "",
    "/status - is it alive right now",
    "/fix - what to check if something seems wrong",
    "/history - recent outages",
    "/mute 2h - pause alerts (for example 30m, 2h, 1d)",
    "/unmute - turn alerts back on",
    "/restarts off - no messages about brief restarts (on to get them back)",
  ];
  if (state.people?.length) lines.push("/leave - stop receiving these alerts");
  return lines.join("\n");
}

/** Step-by-step help for the person at home, worded for someone who did not set the device up. */
export function fixText(state: State, now: number, cfg: Config): string {
  const devices = Object.values(state.devices);
  const down = devices.filter((d) => d.state === "down");
  const help = cfg.help ?? {};
  const askFor = help.contact ? `ask ${help.contact}` : "ask the person who set the device up";

  if (devices.length > 0 && down.length === 0) {
    const lines = devices.map((d) => `${deviceLine(d, now)}, last heartbeat ${formatDuration(now - d.lastSeen)} ago, Wi-Fi signal ${signalWords(d.rssi)}.`);
    const weak = devices.some((d) => d.rssi !== null && d.rssi < -75);
    return [
      "Everything looks fine right now.",
      ...lines,
      "",
      `An alert only comes after ${formatDuration(cfg.timeoutMs)} of silence, so short interruptions pass without one.`,
      "If you expected a message and got none, check that this chat is not muted in Telegram.",
      ...(weak ? ["The Wi-Fi signal is on the weak side. Moving the device closer to the router helps."] : []),
    ].join("\n");
  }

  const hotspot = help.hotspotName ? `the Wi-Fi network called "${help.hotspotName}"` : 'the Wi-Fi network whose name ends in "setup"';
  const password = help.hotspotPassword ? `Its password is ${help.hotspotPassword}` : "Its password is on the card that came with the device";
  const intro = devices.length === 0
    ? "The device has not connected yet."
    : `${down.map((d) => `${d.id} has been silent for ${formatDuration(now - d.lastSeen)}`).join(", ")}.`;
  return [
    `${intro} Check these in order:`,
    "",
    "1. Is there a power cut, or is your internet down? Then the device is doing its job and there is nothing to fix. It reports back by itself.",
    "",
    "2. Is the device still plugged in? Push the cable in firmly at both ends. Then unplug the charger, wait 10 seconds, and plug it back in.",
    "",
    "3. Is your home Wi-Fi working? If your phone has no internet on Wi-Fi either, restart the router and wait 5 minutes.",
    "",
    "4. Has your Wi-Fi name or password changed, or do you have a new router? Then give the device the new details:",
    "   a. Leave it plugged in and wait 2 minutes.",
    `   b. On your phone, open the Wi-Fi settings and join ${hotspot}. ${password}.`,
    "   c. A page opens. Choose your home Wi-Fi, type its password, and save.",
    "",
    "5. After any of these, wait 2 minutes and send /status.",
    "",
    `Still silent? Then ${askFor}.`,
  ].join("\n");
}

function welcomeText(state: State, name: string, now: number, cfg: Config): string {
  const devices = Object.values(state.devices);
  const current = devices.length ? devices.map((d) => `${deviceLine(d, now)}.`).join("\n") : "The device has not connected yet. Plug it in and give it two minutes.";
  return [
    `👋 Hello ${name}! I watch the small device plugged in at home. If the power or the internet is out for more than ${formatDuration(cfg.timeoutMs)}, I tell you here, and again when it is back.`,
    "",
    current,
    "",
    "/status - is everything fine right now",
    "/fix - what to check if something seems wrong",
    "/help - everything I can do",
  ].join("\n");
}

/**
 * Someone opened the invitation link. Adds them to `state.people` and returns what to tell them,
 * plus a note for the people who were already there.
 */
export function joinChat(state: State, person: Person, fallbackChat: string | undefined, now: number, cfg: Config): { reply: string; announce: string | null } {
  const people = (state.people ??= []);
  if (people.some((p) => p.chat === person.chat)) return { reply: welcomeText(state, person.name, now, cfg), announce: null };
  // The chat that was configured by hand keeps receiving alerts once others join by link.
  if (people.length === 0 && fallbackChat && fallbackChat !== person.chat) people.push({ chat: fallbackChat, name: "the owner" });
  if (people.length >= MAX_PEOPLE) {
    return { reply: `This device already has ${MAX_PEOPLE} people receiving its alerts. One of them has to send /leave first.`, announce: null };
  }
  people.push(person);
  return { reply: welcomeText(state, person.name, now, cfg), announce: people.length > 1 ? `👤 ${person.name} now also receives these alerts.` : null };
}

/** Returns false if that chat was not on the list. */
export function leaveChat(state: State, chat: string): boolean {
  const before = state.people?.length ?? 0;
  state.people = (state.people ?? []).filter((p) => p.chat !== chat);
  return state.people.length < before;
}

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
  if (command === "/fix") return fixText(state, now, cfg);
  if (command === "/restarts") {
    const choice = arg.toLowerCase();
    if (choice === "off" || choice === "on") state.restartNotes = choice === "on";
    const current = restartNotesOn(state, cfg)
      ? "Messages about brief restarts are on."
      : "Messages about brief restarts are off. They still appear in /history and the reports.";
    return choice === "off" || choice === "on" ? current : `${current}\nSend /restarts off or /restarts on to change it.`;
  }
  if (command === "/mute") {
    const ms = arg ? parseDuration(arg) : 3_600_000;
    if (ms === null || ms < 60_000 || ms > MAX_MUTE_MS) return "Tell me how long, between 1 minute and 7 days. For example: /mute 30m or /mute 2h";
    state.muteUntil = now + ms;
    return `🔕 Alerts are paused for ${formatDuration(ms)}, until ${formatDayTime(state.muteUntil, cfg.timezone)}.\nSend /unmute to turn them back on.`;
  }
  return helpText(state);
}
